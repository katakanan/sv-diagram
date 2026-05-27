/**
 * DiagramTree (sv-ast-lower の出力) を ELKjs 入力グラフへ変換する
 *
 * 信号ルーティング方針:
 *   - モジュールの Input ポート       → ドライバ (ELK source)
 *   - モジュールの Output ポート      → シンク   (ELK target)
 *   - 子インスタンスの Input ポート   → シンク
 *   - 子インスタンスの Output ポート  → ドライバ
 *   - AlwaysNode.driven_signals       → ドライバ (FF の Q 出力 / Comb の出力)
 *   - AlwaysNode.read_signals         → シンク   (FF の D 入力 / Comb の入力)
 *   - AssignNode.lhs                  → ドライバ
 *   - AssignNode.rhs の三項演算子     → MUX ノード（セレクタ SOUTH、in1/in0 WEST、out EAST）
 *   - AssignNode.rhs の非三項識別子   → シンク
 */

/** @typedef {{ nodeId: string, portId: string }} Endpoint */

// ─── ノード幅の動的計算 ──────────────────────────────────────────
// ポートラベル: font-size 10 + letter-spacing 0.3 のモノスペースで約 7px/char
// ポートドット(8px) + 内側余白 を合わせた左右各側の固定オフセット
const LABEL_CHAR_W = 7
const PORT_INNER   = 36   // 左右各 18px = ポートドット8 + ギャップ4 + 内側余白6

/**
 * WEST/EAST ポートのラベル幅からノードの最小幅を計算する。
 * ポートラベルがノード中央のテキストと重ならない幅を保証する。
 *
 * @param {object[]} ports      - ELK ポート定義配列
 * @param {object[]} nodeLabels - ノード自身のラベル配列（中央テキスト幅の推定に使用）
 * @param {number}   centerMin  - 中央部分の最小幅
 */
function calcNodeWidth(ports, nodeLabels = [], centerMin = 50) {
  let westMax = 0, eastMax = 0
  for (const p of ports) {
    const side  = p.layoutOptions?.['port.side'] ?? 'WEST'
    const chars = p.labels?.[0]?.text?.length ?? 0
    if (side === 'WEST')      westMax = Math.max(westMax, chars)
    else if (side === 'EAST') eastMax = Math.max(eastMax, chars)
  }
  // ノード名(bold 12px ≈ 8px/char)・サブラベル(11px ≈ 7px/char) から中央幅を推定
  const namePx   = (nodeLabels[0]?.text?.length ?? 0) * 8
  const subPx    = (nodeLabels[1]?.text?.length ?? 0) * 7
  const centerPx = Math.max(centerMin, namePx + 16, subPx + 16)

  return westMax * LABEL_CHAR_W + centerPx + eastMax * LABEL_CHAR_W + PORT_INNER
}

const SV_KEYWORDS = new Set([
  'begin','end','if','else','case','casez','casex','endcase','default',
  'for','while','repeat','forever',
  'logic','wire','reg','bit','int','integer','byte','shortint','longint',
  'input','output','inout','ref',
  'assign','always','always_ff','always_comb','always_latch',
  'module','endmodule','parameter','localparam',
  'posedge','negedge',
])

/** assign/always RHS 文字列から SV 識別子を抽出する（過近似）
 *
 *  SV 整数リテラル（8'hFF, 2'd3, 1'b0 等）を先に除去することで
 *  `d3` / `h1F` のような誤検出を防ぐ。
 */
function extractIdents(expr) {
  const stripped = expr.replace(/\d*'[bBdDoOhHsS][0-9a-fA-F_xXzZ]*/g, '')
  const matches  = stripped.match(/\b[a-zA-Z_][a-zA-Z0-9_$]*\b/g) ?? []
  return [...new Set(matches)].filter(w => !SV_KEYWORDS.has(w))
}

/**
 * SV 式文字列を三項演算子で再帰的に分解する。
 *
 * ブラケット ( [ ] ( ) { } ) を深さとして追跡し、
 * 深さ 0 の ? / : のみを三項演算子として認識する。
 *
 * @returns {{ isTernary: false, value: string }
 *          |{ isTernary: true, cond: string, true_: object, false_: object }}
 */
function parseTernary(expr) {
  const s = expr.trim()
  let depth = 0
  let qPos  = -1

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ('([{'.includes(c))      depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && c === '?' && qPos < 0) { qPos = i; break }
  }
  if (qPos < 0) return { isTernary: false, value: s }

  // qPos 以降で深さ 0 の最初の ':' を探す
  depth = 0
  let cPos = -1
  for (let i = qPos + 1; i < s.length; i++) {
    const c = s[i]
    if ('([{'.includes(c))      depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && c === ':') { cPos = i; break }
  }
  if (cPos < 0) return { isTernary: false, value: s }

  return {
    isTernary: true,
    cond:   s.slice(0, qPos).trim(),
    true_:  parseTernary(s.slice(qPos + 1, cPos)),
    false_: parseTernary(s.slice(cPos + 1)),
  }
}

/**
 * @param {object} tree      - DiagramTree (JSON.parseされたもの)
 * @param {number} moduleIdx - 表示するモジュールのインデックス
 * @returns {object} ELKjs に渡すグラフオブジェクト
 */
export function buildElkGraph(tree, moduleIdx = 0) {
  const mod = tree.modules[moduleIdx]

  // 他モジュールのポート方向を引ける辞書: module_name → Map<port_name, direction>
  const modulePortDirs = new Map()
  for (const m of tree.modules) {
    const pm = new Map(m.ports.map(p => [p.name, p.direction]))
    modulePortDirs.set(m.name, pm)
  }

  const children = []
  const edges    = []
  let   eid      = 0
  let   cstCount = 0   // 定数ノード連番

  // signal_name → { sources: Endpoint[], sinks: Endpoint[] }
  const wires = new Map()

  /** 配線エンドポイントを登録する */
  function tap(signal, nodeId, portId, role) {
    if (!signal) return
    if (!wires.has(signal)) wires.set(signal, { sources: [], sinks: [] })
    wires.get(signal)[role === 'source' ? 'sources' : 'sinks'].push({ nodeId, portId })
  }

  /**
   * 定数ノードを生成して指定ポートに接続する。
   * 値が空白のみの場合は何もしない。
   */
  function makeConst(value, targetPid) {
    const label = value.replace(/\s+/g, ' ').trim()
    if (!label) return
    const cid    = `const.${cstCount++}`
    const outPid = `${cid}.out`
    children.push({
      id: cid,
      width:  Math.max(28, label.length * 7 + 12),
      height: 20,
      labels: [{ text: label }],
      ports:  [{ id: outPid, layoutOptions: { 'port.side': 'EAST' } }],
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
      },
    })
    edges.push({ id: `e${eid++}`, sources: [outPid], targets: [targetPid] })
  }

  /**
   * 三項演算子ツリーを再帰的に MUX ノードへ展開する。
   *
   * @param {object} parsed - parseTernary の戻り値
   * @param {string} prefix - ノード ID の接頭辞（例: "assign.0"）
   * @param {{ n: number }} cnt - MUX 連番カウンタ（共有参照）
   * @returns {string|null} このサブ式の出力ポート ID（葉ノードは null）
   */
  function buildMux(parsed, prefix, cnt) {
    if (!parsed.isTernary) return null   // 葉ノード：呼び出し元が tap

    const muxId  = `${prefix}.m${cnt.n++}`
    const selPid = `${muxId}.sel`
    const in1Pid = `${muxId}.in1`
    const in0Pid = `${muxId}.in0`
    const outPid = `${muxId}.out`

    // セレクタ信号を SOUTH へ接続
    for (const sig of extractIdents(parsed.cond)) {
      tap(sig, muxId, selPid, 'sink')
    }

    // in1 (true パス)
    const trueOut = buildMux(parsed.true_, prefix, cnt)
    if (trueOut !== null) {
      // 内側 MUX の出力 → この MUX の in1
      edges.push({ id: `e${eid++}`, sources: [trueOut], targets: [in1Pid] })
    } else {
      const sigs = extractIdents(parsed.true_.value)
      if (sigs.length > 0) {
        for (const sig of sigs) tap(sig, muxId, in1Pid, 'sink')
      } else {
        makeConst(parsed.true_.value, in1Pid)   // 純リテラル → 定数ノード
      }
    }

    // in0 (false パス)
    const falseOut = buildMux(parsed.false_, prefix, cnt)
    if (falseOut !== null) {
      edges.push({ id: `e${eid++}`, sources: [falseOut], targets: [in0Pid] })
    } else {
      const sigs = extractIdents(parsed.false_.value)
      if (sigs.length > 0) {
        for (const sig of sigs) tap(sig, muxId, in0Pid, 'sink')
      } else {
        makeConst(parsed.false_.value, in0Pid)  // 純リテラル → 定数ノード
      }
    }

    children.push({
      id: muxId,
      width: 60,
      height: 68,
      labels: [{ text: 'MUX' }],
      ports: [
        { id: in1Pid, labels: [{ text: '1' }], layoutOptions: { 'port.side': 'WEST' } },
        { id: in0Pid, labels: [{ text: '0' }], layoutOptions: { 'port.side': 'WEST' } },
        { id: selPid, labels: [{ text: 'S' }],  layoutOptions: { 'port.side': 'SOUTH' } },
        { id: outPid,                            layoutOptions: { 'port.side': 'EAST' } },
      ],
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
      },
    })

    return outPid
  }

  // ─── 外部ポートノード ─────────────────────────────────────────
  for (const port of mod.ports) {
    const nid      = `ext.${port.name}`
    const pid      = `${nid}.p`
    const isInput  = port.direction !== 'Output'   // Input / Inout → 左
    const isOutput = port.direction === 'Output'
    children.push({
      id: nid,
      width: Math.max(40, port.name.length * LABEL_CHAR_W + 16), height: 24,
      labels: [{ text: port.name }],
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'OUTSIDE V_TOP H_CENTER',
        // 入力を最左層、出力を最右層に強制配置
        'elk.layered.layering.layerConstraint': isOutput ? 'LAST' : 'FIRST',
      },
      ports: [{
        id: pid,
        layoutOptions: { 'port.side': isInput ? 'EAST' : 'WEST' },
      }],
    })
    tap(port.name, nid, pid, isInput ? 'source' : 'sink')
  }

  // ─── モジュールインスタンス ───────────────────────────────────
  for (const inst of mod.instances) {
    const nid       = `inst.${inst.instance_name}`
    const childDirs = modulePortDirs.get(inst.module_name) ?? new Map()
    const ports     = []

    for (const conn of inst.port_connections) {
      const pid   = `${nid}.${conn.port_name}`
      const dir   = childDirs.get(conn.port_name) ?? 'Input'
      const isIn  = dir === 'Input'
      ports.push({
        id: pid,
        labels: [{ text: conn.port_name }],
        layoutOptions: {
          'port.side': isIn ? 'WEST' : 'EAST',
          'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
        },
      })
      tap(conn.signal, nid, pid, isIn ? 'sink' : 'source')
    }

    const paramStr  = inst.param_overrides.map(p => `${p.param_name}=${p.value}`).join(', ')
    const sublabel  = paramStr ? `#(${paramStr})` : `«${inst.module_name}»`
    const nodeLabels = [{ text: inst.instance_name }, { text: sublabel }]

    children.push({
      id: nid,
      width:  calcNodeWidth(ports, nodeLabels, 60),
      height: Math.max(60, ports.length * 20 + 24),
      labels: nodeLabels,
      ports,
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'INSIDE V_TOP H_CENTER',
      },
    })
  }

  // ─── always_ff / always_comb / always_latch ───────────────────
  mod.always_blocks.forEach((always, i) => {
    const isFf = always.kind === 'Ff'

    if (isFf) {
      // ── ff_comb: 次状態ロジックノード ─────────────────────────
      // read_signals (clk・rst は always.rs 側で除外済み) を WEST 入力、
      // driven_signals を EAST 出力として配置。
      // EAST 出力ポートは wire システムには登録せず、
      // ff_reg.D へ直結エッジを張る。
      const combId    = `ff_comb.${i}`
      const combPorts = []

      for (const sig of (always.read_signals ?? [])) {
        const pid = `${combId}.in.${sig}`
        combPorts.push({
          id: pid,
          labels:        [{ text: sig }],
          layoutOptions: { 'port.side': 'WEST' },
        })
        tap(sig, combId, pid, 'sink')
      }

      for (const sig of always.driven_signals) {
        const pid = `${combId}.out.${sig}`
        combPorts.push({
          id: pid,
          labels:        [{ text: sig }],
          layoutOptions: { 'port.side': 'EAST' },
        })
        // wire システム未登録 → 下で ff_reg.D へ直結
      }

      const combLabels = [{ text: 'NEXT' }]
      children.push({
        id:     combId,
        width:  calcNodeWidth(combPorts, combLabels, 44),
        height: Math.max(40, combPorts.length * 20 + 24),
        labels: combLabels,
        ports:  combPorts,
        layoutOptions: {
          'portConstraints':             'FIXED_SIDE',
          'elk.nodeLabels.placement':    'INSIDE V_CENTER H_CENTER',
        },
      })

      // ── ff_reg: D フリップフロップ（driven_signal ごとに 1 個）─
      for (const sig of always.driven_signals) {
        const regId  = `ff_reg.${i}.${sig}`
        const dPid   = `${regId}.D`
        const qPid   = `${regId}.Q`
        const clkPid = `${regId}.CLK`

        // WEST: D (index 0)、CLK (index 1) の順で上から配置
        // SOUTH: RST_N（非同期リセット）
        // EAST: Q
        const regPorts = [
          // WEST: 時計回り(下→上)なので index が大きいほど上に配置される
          // D を上(index:1)、CLK を下(index:0)にする
          { id: dPid,   labels: [{ text: 'D' }],   layoutOptions: { 'port.side': 'WEST', 'port.index': '1' } },
          { id: clkPid, labels: [{ text: 'CLK' }], layoutOptions: { 'port.side': 'WEST', 'port.index': '0' } },
          { id: qPid,   labels: [{ text: 'Q' }],   layoutOptions: { 'port.side': 'EAST', 'port.index': '0' } },
        ]

        if (always.reset) {
          const rstPid   = `${regId}.RST`
          const rstLabel = always.reset.active_low ? 'RST_N' : 'RST'
          regPorts.push({
            id: rstPid,
            labels:        [{ text: rstLabel }],
            layoutOptions: { 'port.side': 'SOUTH', 'port.index': '0' },
          })
          tap(always.reset.signal_name, regId, rstPid, 'sink')
        }

        if (always.clock) {
          tap(always.clock.signal_name, regId, clkPid, 'sink')
        }

        // Q → wire システムにソースとして登録
        tap(sig, regId, qPid, 'source')

        // ff_comb.out.{sig} → D に直結エッジ
        edges.push({
          id:      `e${eid++}`,
          sources: [`${combId}.out.${sig}`],
          targets: [dPid],
        })

        const regLabels = [{ text: sig }, { text: 'DFF' }]
        children.push({
          id:     regId,
          width:  calcNodeWidth(regPorts, regLabels, 40),
          height: Math.max(64, regPorts.length * 18 + 24),
          labels: regLabels,
          ports:  regPorts,
          layoutOptions: {
            'portConstraints':          'FIXED_ORDER',
            'elk.nodeLabels.placement': 'INSIDE V_TOP H_CENTER',
          },
        })
      }

    } else {
      // ── Comb / Latch: 従来どおり1ノード ──────────────────────
      const nid   = `always.${i}`
      const ports = []

      for (const sig of (always.read_signals ?? [])) {
        const pid = `${nid}.in.${sig}`
        ports.push({
          id: pid,
          labels:        [{ text: sig }],
          layoutOptions: { 'port.side': 'WEST' },
        })
        tap(sig, nid, pid, 'sink')
      }

      for (const sig of always.driven_signals) {
        const pid = `${nid}.out.${sig}`
        ports.push({
          id: pid,
          labels:        [{ text: sig }],
          layoutOptions: { 'port.side': 'EAST' },
        })
        tap(sig, nid, pid, 'source')
      }

      const kindLabel  = always.kind === 'Comb' ? 'COMB' : 'LATCH'
      const kindLabels = [{ text: kindLabel }]
      children.push({
        id:     nid,
        width:  calcNodeWidth(ports, kindLabels, 44),
        height: Math.max(60, ports.length * 20 + 24),
        labels: kindLabels,
        ports,
        layoutOptions: {
          'portConstraints':          'FIXED_SIDE',
          'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
        },
      })
    }
  })

  // ─── assign 文ノード ─────────────────────────────────────────
  mod.assigns.forEach((assign, i) => {
    const nid    = `assign.${i}`
    const parsed = parseTernary(assign.rhs)

    if (parsed.isTernary) {
      // 三項演算子 → MUX ノード群に展開
      const cnt      = { n: 0 }
      const outPortId = buildMux(parsed, nid, cnt)
      // 最外 MUX の出力ポートを LHS 信号のソースとして登録
      const outerMuxId = outPortId.replace(/\.out$/, '')
      tap(assign.lhs, outerMuxId, outPortId, 'source')
    } else {
      // 非三項 assign → 小さな assign ノード（RHS 識別子を WEST 入力）
      const outPid = `${nid}.out`
      const ports  = [{ id: outPid, layoutOptions: { 'port.side': 'EAST' } }]
      tap(assign.lhs, nid, outPid, 'source')

      const rhsIdents = extractIdents(assign.rhs)
      for (const sig of rhsIdents) {
        const inPid = `${nid}.in.${sig}`
        ports.push({ id: inPid, layoutOptions: { 'port.side': 'WEST' } })
        tap(sig, nid, inPid, 'sink')
      }
      children.push({
        id: nid,
        width:  calcNodeWidth(ports, [], 12),
        height: Math.max(20, rhsIdents.length * 12 + 8),
        labels: [],
        ports,
        layoutOptions: { 'portConstraints': 'FIXED_SIDE' },
      })
    }
  })

  // ─── エッジ生成（信号ルーティング）──────────────────────────
  for (const [, wire] of wires) {
    for (const src of wire.sources) {
      for (const snk of wire.sinks) {
        edges.push({
          id: `e${eid++}`,
          sources: [src.portId],
          targets: [snk.portId],
        })
      }
    }
  }

  return {
    id: 'root',
    layoutOptions: {
      'algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.nodeNode': '48',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children,
    edges,
  }
}
