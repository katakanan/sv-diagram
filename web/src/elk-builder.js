/**
 * DiagramTree (sv-ast-lower の出力) を ELKjs 入力グラフへ変換する
 *
 * 信号ルーティング方針:
 *   - モジュールの Input ポート      → ドライバ (ELK source)
 *   - モジュールの Output ポート     → シンク   (ELK target)
 *   - 子インスタンスの Input ポート  → シンク   (同 DiagramTree に定義があれば方向を参照)
 *   - 子インスタンスの Output ポート → ドライバ
 *   - AlwaysNode.driven_signals      → ドライバ (FF の Q 出力 / Comb の出力)
 *   - AssignNode.lhs                 → ドライバ
 */

/** @typedef {{ nodeId: string, portId: string }} Endpoint */

/**
 * @param {object} tree   - DiagramTree (JSON.parseされたもの)
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
    const nid = `always.${i}`
    const ports = []
    const isFf = always.kind === 'Ff'

    if (isFf) {
      // D 入力（何が繋がるかは信号解析で後から決定）
      ports.push({
        id: `${nid}.D`,
        labels: [{ text: 'D' }],
        layoutOptions: { 'port.side': 'WEST' },
      })
      // CLK
      if (always.clock) {
        const pid = `${nid}.CLK`
        ports.push({
          id: pid,
          labels: [{ text: 'CLK' }],
          layoutOptions: { 'port.side': 'SOUTH' },
        })
        tap(always.clock.signal_name, nid, pid, 'sink')
      }
      // RST
      if (always.reset) {
        const pid = `${nid}.RST`
        const label = always.reset.active_low ? 'RST_N' : 'RST'
        ports.push({
          id: pid,
          labels: [{ text: label }],
          layoutOptions: { 'port.side': 'WEST' },
        })
        tap(always.reset.signal_name, nid, pid, 'sink')
      }
      // Q 出力
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
      // Comb / Latch: driven_signals が出力ポート
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
    const nid = `assign.${i}`
    const pid = `${nid}.out`
    children.push({
      id: nid,
      width: 20, height: 20,
      labels: [],
      ports: [{ id: pid, layoutOptions: { 'port.side': 'EAST' } }],
      layoutOptions: { 'portConstraints': 'FIXED_SIDE' },
    })
    tap(assign.lhs, nid, pid, 'source')
  })

  // ─── エッジ生成 ──────────────────────────────────────────────
  // FF の D ポートを解決する:
  // driven_signals のうち FF が駆動するものが同時に他の場所でシンクなら接続
  for (const always of mod.always_blocks) {
    if (always.kind !== 'Ff') continue
    const ffIdx = mod.always_blocks.indexOf(always)
    const dPid = `always.${ffIdx}.D`

    // driven_signals (= Q 出力) が他のノードのシンクとしても登録されているものを探す
    // そのシンクの逆サイド (= ドライバ) を D ポートに繋ぐ
    for (const sig of always.driven_signals) {
      const wire = wires.get(sig)
      if (!wire) continue
      // Q 出力は自身が source なので除外し、外部 sinks が D に入る場合が多い
      // ここでは同名信号のドライバ (Q) をそのままフィードバックとして D に接続
      for (const src of wire.sources) {
        if (src.nodeId === `always.${ffIdx}`) continue // 自己は除外
        edges.push({
          id: `e${eid++}`,
          sources: [src.portId],
          targets: [dPid],
        })
      }
    }
  }

  // 通常の信号ルーティング
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
