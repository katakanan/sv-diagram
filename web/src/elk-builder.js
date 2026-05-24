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
 *   - AssignNode.rhs の識別子         → シンク
 */

/** @typedef {{ nodeId: string, portId: string }} Endpoint */

const SV_KEYWORDS = new Set([
  'begin','end','if','else','case','casez','casex','endcase','default',
  'for','while','repeat','forever',
  'logic','wire','reg','bit','int','integer','byte','shortint','longint',
  'input','output','inout','ref',
  'assign','always','always_ff','always_comb','always_latch',
  'module','endmodule','parameter','localparam',
  'posedge','negedge',
])

/** assign/always RHS 文字列から SV 識別子を抽出する（過近似） */
function extractIdents(expr) {
  const matches = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_$]*\b/g) ?? []
  return [...new Set(matches)].filter(w => !SV_KEYWORDS.has(w))
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

  // signal_name → { sources: Endpoint[], sinks: Endpoint[] }
  const wires = new Map()

  /** 配線エンドポイントを登録する */
  function tap(signal, nodeId, portId, role /* 'source' | 'sink' */) {
    if (!signal) return
    if (!wires.has(signal)) wires.set(signal, { sources: [], sinks: [] })
    wires.get(signal)[role === 'source' ? 'sources' : 'sinks'].push({ nodeId, portId })
  }

  // ─── 外部ポートノード ─────────────────────────────────────────
  for (const port of mod.ports) {
    const nid = `ext.${port.name}`
    const pid = `${nid}.p`
    const isInput = port.direction === 'Input'
    children.push({
      id: nid,
      width: 52, height: 24,
      labels: [{ text: port.name }],
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'OUTSIDE V_TOP H_CENTER',
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
    const nid = `inst.${inst.instance_name}`
    const childDirs = modulePortDirs.get(inst.module_name) ?? new Map()
    const ports = []

    for (const conn of inst.port_connections) {
      const pid = `${nid}.${conn.port_name}`
      const dir = childDirs.get(conn.port_name) ?? 'Input'
      const isIn = dir === 'Input'
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

    const paramStr = inst.param_overrides.map(p => `${p.param_name}=${p.value}`).join(', ')
    const sublabel = paramStr ? `#(${paramStr})` : `«${inst.module_name}»`

    children.push({
      id: nid,
      width: 110,
      height: Math.max(60, ports.length * 20 + 24),
      labels: [
        { text: inst.instance_name },
        { text: sublabel },
      ],
      ports,
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'INSIDE V_TOP H_CENTER',
      },
    })
  }

  // ─── always_ff / always_comb / always_latch ───────────────────
  mod.always_blocks.forEach((always, i) => {
    const nid   = `always.${i}`
    const ports = []
    const isFf  = always.kind === 'Ff'

    if (isFf) {
      // RST ポート (WEST)
      if (always.reset) {
        const pid   = `${nid}.RST`
        const label = always.reset.active_low ? 'RST_N' : 'RST'
        ports.push({
          id: pid,
          labels: [{ text: label }],
          layoutOptions: { 'port.side': 'WEST' },
        })
        tap(always.reset.signal_name, nid, pid, 'sink')
      }

      // D 入力ポート: read_signals (WEST)
      for (const sig of (always.read_signals ?? [])) {
        const pid = `${nid}.D.${sig}`
        ports.push({
          id: pid,
          labels: [{ text: sig }],
          layoutOptions: { 'port.side': 'WEST' },
        })
        tap(sig, nid, pid, 'sink')
      }

      // CLK ポート (SOUTH)
      if (always.clock) {
        const pid = `${nid}.CLK`
        ports.push({
          id: pid,
          labels: [{ text: 'CLK' }],
          layoutOptions: { 'port.side': 'SOUTH' },
        })
        tap(always.clock.signal_name, nid, pid, 'sink')
      }

      // Q 出力ポート (EAST)
      for (const sig of always.driven_signals) {
        const pid = `${nid}.Q.${sig}`
        ports.push({
          id: pid,
          labels: [{ text: sig }],
          layoutOptions: { 'port.side': 'EAST' },
        })
        tap(sig, nid, pid, 'source')
      }
    } else {
      // Comb / Latch: read_signals が入力ポート (WEST)
      for (const sig of (always.read_signals ?? [])) {
        const pid = `${nid}.in.${sig}`
        ports.push({
          id: pid,
          labels: [{ text: sig }],
          layoutOptions: { 'port.side': 'WEST' },
        })
        tap(sig, nid, pid, 'sink')
      }

      // driven_signals が出力ポート (EAST)
      for (const sig of always.driven_signals) {
        const pid = `${nid}.out.${sig}`
        ports.push({
          id: pid,
          labels: [{ text: sig }],
          layoutOptions: { 'port.side': 'EAST' },
        })
        tap(sig, nid, pid, 'source')
      }
    }

    const kindLabel = isFf ? 'FF' : always.kind === 'Comb' ? 'COMB' : 'LATCH'
    children.push({
      id: nid,
      width: 80,
      height: Math.max(60, ports.length * 20 + 24),
      labels: [{ text: kindLabel }],
      ports,
      layoutOptions: {
        'portConstraints': 'FIXED_SIDE',
        'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
      },
    })
  })

  // ─── assign 文ノード ─────────────────────────────────────────
  mod.assigns.forEach((assign, i) => {
    const nid    = `assign.${i}`
    const outPid = `${nid}.out`
    const ports  = [{ id: outPid, layoutOptions: { 'port.side': 'EAST' } }]
    tap(assign.lhs, nid, outPid, 'source')

    // RHS から識別子を抽出して WEST 入力ポートに接続
    const rhsIdents = extractIdents(assign.rhs)
    for (const sig of rhsIdents) {
      const inPid = `${nid}.in.${sig}`
      ports.push({ id: inPid, layoutOptions: { 'port.side': 'WEST' } })
      tap(sig, nid, inPid, 'sink')
    }

    children.push({
      id: nid,
      width: 20,
      height: Math.max(20, rhsIdents.length * 12 + 8),
      labels: [],
      ports,
      layoutOptions: { 'portConstraints': 'FIXED_SIDE' },
    })
  })

  // ─── エッジ生成 ──────────────────────────────────────────────
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
      'elk.spacing.nodeNode': '28',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children,
    edges,
  }
}
