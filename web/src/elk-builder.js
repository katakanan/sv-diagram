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

// ─── body AST ヘルパー ────────────────────────────────────────────

/**
 * Expr AST (serde tag="t" content="v") から識別子名を再帰的に収集する。
 * Raw 文字列は extractIdents にフォールバックする。
 */
function collectExprIdents(expr) {
  if (!expr) return []
  switch (expr.t) {
    case 'Ident':   return [expr.v]
    case 'Lit':     return []
    case 'Raw':     return extractIdents(expr.v)
    case 'Unary':   return collectExprIdents(expr.v.operand)
    case 'Binary':  return [...collectExprIdents(expr.v.lhs), ...collectExprIdents(expr.v.rhs)]
    case 'Ternary': return [
      ...collectExprIdents(expr.v.c),
      ...collectExprIdents(expr.v.t),   // "t" は true 分岐 (外側のタグキーと同名だが別物)
      ...collectExprIdents(expr.v.e),
    ]
    case 'Index':   return [...collectExprIdents(expr.v.base), ...collectExprIdents(expr.v.idx)]
    case 'Slice':   return [
      ...collectExprIdents(expr.v.base),
      ...collectExprIdents(expr.v.hi),
      ...collectExprIdents(expr.v.lo),
    ]
    case 'Concat':  return expr.v.flatMap(e => collectExprIdents(e))
    default:        return []
  }
}

/** Expr を表示用の文字列に変換する（定数ノードのラベル用）。 */
function exprToString(expr) {
  if (!expr) return ''
  if (expr.t === 'Ident' || expr.t === 'Lit' || expr.t === 'Raw') return String(expr.v)
  return ''
}

/**
 * always 本体の Stmt 配列を解析し、driven_signal ごとの依存信号セットを返す。
 *
 * - 代入文: RHS 識別子 → LHS の依存集合に追加
 * - if/case 条件: そのブロック内で書かれる全 driven_signal に条件識別子を追加（外側から伝搬）
 */
function extractDepsPerSignal(body, drivenSignals) {
  const deps = new Map(drivenSignals.map(s => [s, new Set()]))

  function getDriven(stmts) {
    const driven = new Set()
    for (const stmt of stmts) {
      if (stmt.t === 'NbAssign' || stmt.t === 'BAssign') { driven.add(stmt.v.lhs) }
      else if (stmt.t === 'If') {
        for (const s of getDriven(stmt.v.then_)) driven.add(s)
        for (const s of getDriven(stmt.v.else_)) driven.add(s)
      } else if (stmt.t === 'Case') {
        for (const item of stmt.v.items)           for (const s of getDriven(item.stmts)) driven.add(s)
        for (const s of getDriven(stmt.v.default_)) driven.add(s)
      }
    }
    return driven
  }

  function walk(stmts, condCtx) {
    for (const stmt of stmts) {
      if (stmt.t === 'NbAssign' || stmt.t === 'BAssign') {
        if (deps.has(stmt.v.lhs)) {
          for (const id of collectExprIdents(stmt.v.rhs)) deps.get(stmt.v.lhs).add(id)
          for (const id of condCtx)                        deps.get(stmt.v.lhs).add(id)
        }
      } else if (stmt.t === 'If') {
        const condIds      = collectExprIdents(stmt.v.cond)
        const branchDriven = getDriven([...stmt.v.then_, ...stmt.v.else_])
        for (const sig of branchDriven) {
          if (deps.has(sig)) {
            for (const id of condIds) deps.get(sig).add(id)
            for (const id of condCtx) deps.get(sig).add(id)
          }
        }
        walk(stmt.v.then_, [...condCtx, ...condIds])
        walk(stmt.v.else_, [...condCtx, ...condIds])
      } else if (stmt.t === 'Case') {
        const selIds     = collectExprIdents(stmt.v.sel)
        const allDriven  = getDriven([...stmt.v.items.flatMap(i => i.stmts), ...stmt.v.default_])
        for (const sig of allDriven) {
          if (deps.has(sig)) {
            for (const id of selIds)  deps.get(sig).add(id)
            for (const id of condCtx) deps.get(sig).add(id)
          }
        }
        for (const item of stmt.v.items) walk(item.stmts, [...condCtx, ...selIds])
        walk(stmt.v.default_, [...condCtx, ...selIds])
      }
    }
  }

  walk(body ?? [], [])
  for (const [, set] of deps) {
    for (const id of [...set]) { if (SV_KEYWORDS.has(id)) set.delete(id) }
  }
  return deps
}

/**
 * async reset のトップレベル if 分岐を除去して else-branch のみを返す。
 *
 * always_ff @(posedge clk or negedge rst_n) begin
 *   if (!rst_n) q <= '0;   ← ここを除去（DFF の RST ポートが担う）
 *   else        q <= d;    ← これだけ返す（組み合わせ NEXT ロジック）
 * end
 */
function stripAsyncResetBranch(body, resetName) {
  if (!resetName || !body || body.length === 0) return body
  for (const stmt of body) {
    if (stmt.t !== 'If') continue
    if (collectExprIdents(stmt.v.cond).includes(resetName)) {
      return stmt.v.else_   // else-branch のみ（通常動作パス）
    }
  }
  return body
}

/**
 * 同期リセットパターンを検出する。
 *
 * 以下の形を認識:
 *   if (<single_ident>)  sig <= <constant>   ← sync reset
 *   else                 sig <= <data>        ← 通常動作
 *
 * @returns {{ sel: string, thenRhs: Expr, elseBody: Stmt[] } | null}
 */
function detectSyncReset(body, sig) {
  if (!body || body.length === 0) return null
  for (const stmt of body) {
    if (stmt.t !== 'If') continue
    const condIdents = collectExprIdents(stmt.v.cond)
    if (condIdents.length !== 1) continue
    const sel = condIdents[0]

    // then-branch に sig への代入があり RHS が定数か確認
    let thenRhs = null
    for (const s of stmt.v.then_) {
      if ((s.t === 'NbAssign' || s.t === 'BAssign') && s.v.lhs === sig) {
        thenRhs = s.v.rhs
        break
      }
    }
    if (!thenRhs) continue
    if (collectExprIdents(thenRhs).length > 0) continue   // 定数でなければスキップ

    return { sel, thenRhs, elseBody: stmt.v.else_ }
  }
  return null
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
      // async reset 分岐を除去した body（else-branch = 通常動作パスのみ）
      // 例: if (!rst_n) q<=0; else q<=d; → [q<=d] を返す
      // async reset の処理は DFF の RST ポートが担うため NEXT ロジックには不要
      const asyncRstName = always.reset?.signal_name ?? null
      const filteredBody = stripAsyncResetBranch(always.body ?? [], asyncRstName)

      // driven_signal ごとに (NEXT or MUX) + DFF のペアを生成
      for (const sig of always.driven_signals) {
        const regId  = `ff_reg.${i}.${sig}`
        const dPid   = `${regId}.D`
        const qPid   = `${regId}.Q`
        const clkPid = `${regId}.CLK`

        // sync reset パターンを検出（async reset がある場合は不適用）
        const syncRst = !always.reset ? detectSyncReset(filteredBody, sig) : null

        if (syncRst) {
          // ── sync reset: srst を SEL とする MUX ノード ────────
          // srst=1 → リセット値(定数)   srst=0 → 通常データ
          const muxId  = `ff_comb.${i}.${sig}`
          const selPid = `${muxId}.sel`
          const in1Pid = `${muxId}.in1`   // SEL=1 パス: リセット値
          const in0Pid = `${muxId}.in0`   // SEL=0 パス: 通常データ
          const outPid = `${muxId}.out`

          // SEL: srst 信号
          tap(syncRst.sel, muxId, selPid, 'sink')

          // in1: リセット値を定数ノードとして接続
          makeConst(exprToString(syncRst.thenRhs) || "'0", in1Pid)

          // in0: else-branch (通常動作) の依存信号
          const elseDeps = extractDepsPerSignal(syncRst.elseBody, [sig]).get(sig) ?? new Set()
          for (const inSig of elseDeps) {
            tap(inSig, muxId, in0Pid, 'sink')
          }

          children.push({
            id:     muxId,
            width:  60,
            height: 68,
            labels: [{ text: 'MUX' }, { text: sig }],
            ports: [
              { id: in1Pid, labels: [{ text: '1' }], layoutOptions: { 'port.side': 'WEST' } },
              { id: in0Pid, labels: [{ text: '0' }], layoutOptions: { 'port.side': 'WEST' } },
              { id: selPid, labels: [{ text: 'S' }],  layoutOptions: { 'port.side': 'SOUTH' } },
              { id: outPid, labels: [{ text: sig }],   layoutOptions: { 'port.side': 'EAST' } },
            ],
            layoutOptions: {
              'portConstraints':          'FIXED_SIDE',
              'elk.nodeLabels.placement': 'INSIDE V_TOP H_CENTER',
            },
          })

          edges.push({ id: `e${eid++}`, sources: [outPid], targets: [dPid] })

        } else {
          // ── async reset 除去済み body から deps を計算 → NEXT ノード ─
          const combId     = `ff_comb.${i}.${sig}`
          const combOutPid = `${combId}.out`
          const combPorts  = []

          const deps = extractDepsPerSignal(filteredBody, [sig]).get(sig) ?? new Set()
          for (const inSig of deps) {
            const pid = `${combId}.in.${inSig}`
            combPorts.push({
              id:            pid,
              labels:        [{ text: inSig }],
              layoutOptions: { 'port.side': 'WEST' },
            })
            tap(inSig, combId, pid, 'sink')
          }
          combPorts.push({ id: combOutPid, labels: [{ text: sig }], layoutOptions: { 'port.side': 'EAST' } })

          const combLabels = [{ text: sig }, { text: 'NEXT' }]
          children.push({
            id:     combId,
            width:  calcNodeWidth(combPorts, combLabels, 44),
            height: Math.max(40, combPorts.length * 20 + 24),
            labels: combLabels,
            ports:  combPorts,
            layoutOptions: {
              'portConstraints':          'FIXED_SIDE',
              'elk.nodeLabels.placement': 'INSIDE V_TOP H_CENTER',
            },
          })

          edges.push({ id: `e${eid++}`, sources: [combOutPid], targets: [dPid] })
        }

        // ─ DFF ────────────────────────────────────────────────
        const regPorts = [
          { id: dPid,   labels: [{ text: 'D' }],   layoutOptions: { 'port.side': 'WEST', 'port.index': '1' } },
          { id: clkPid, labels: [{ text: 'CLK' }], layoutOptions: { 'port.side': 'WEST', 'port.index': '0' },
            ...(always.clock?.edge === 'Negedge' ? { negedge: true } : {}) },
          { id: qPid,   labels: [{ text: 'Q' }],   layoutOptions: { 'port.side': 'EAST', 'port.index': '0' } },
        ]

        if (always.reset) {
          const rstPid   = `${regId}.RST`
          const rstLabel = always.reset.active_low ? 'RST_N' : 'RST'
          regPorts.push({
            id:            rstPid,
            labels:        [{ text: rstLabel }],
            layoutOptions: { 'port.side': 'SOUTH', 'port.index': '0' },
            ...(always.reset.active_low ? { active_low: true } : {}),
          })
          tap(always.reset.signal_name, regId, rstPid, 'sink')
        }

        if (always.clock) {
          tap(always.clock.signal_name, regId, clkPid, 'sink')
        }

        tap(sig, regId, qPid, 'source')

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
      const rhsIdents = extractIdents(assign.rhs)

      if (rhsIdents.length === 0) {
        // 純定数 assign (assign hoge = 1'd0 等):
        // assign ノードは作らず定数ノードを wire システムにソースとして直接登録する
        const label = assign.rhs.replace(/\s+/g, ' ').trim()
        if (label) {
          const cid    = `const.${cstCount++}`
          const outPid = `${cid}.out`
          children.push({
            id:     cid,
            width:  Math.max(28, label.length * 7 + 12),
            height: 20,
            labels: [{ text: label }],
            ports:  [{ id: outPid, layoutOptions: { 'port.side': 'EAST' } }],
            layoutOptions: {
              'portConstraints': 'FIXED_SIDE',
              'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
            },
          })
          tap(assign.lhs, cid, outPid, 'source')
        }
      } else {
        // 識別子を含む非三項 assign → assign ノード（RHS 識別子を WEST 入力）
        const outPid = `${nid}.out`
        const ports  = [{ id: outPid, layoutOptions: { 'port.side': 'EAST' } }]
        tap(assign.lhs, nid, outPid, 'source')

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
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '12',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children,
    edges,
  }
}
