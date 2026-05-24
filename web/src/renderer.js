/**
 * ELKjs のレイアウト結果を SVG DOM 要素に変換する
 *
 * ELKjs 座標系:
 *   node.x/y        : 親グラフ座標系での左上位置
 *   port.x/y        : 親ノードの左上からの相対位置
 *   edge section    : グラフ座標系 (絶対座標)
 */

const NS = 'http://www.w3.org/2000/svg'

const STYLE = {
  nodeFill:        '#dde3ff',
  nodeStroke:      '#5566cc',
  nodeStrokeWidth: 1.5,
  extFill:         '#eef0ff',
  extStroke:       '#8899cc',
  portFill:        '#5566cc',
  portSize:        8,
  edgeStroke:      '#5566cc',
  edgeWidth:       1.5,
  labelFont:       'monospace',
  labelSize:       12,
  subLabelSize:    10,
  padding:         24,
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const c of children) e.appendChild(c)
  return e
}
function text(str, x, y, { size = STYLE.labelSize, anchor = 'middle', fill = '#1d1d1f', bold = false } = {}) {
  const t = el('text', { x, y, 'text-anchor': anchor, 'font-family': STYLE.labelFont,
    'font-size': size, fill, 'font-weight': bold ? '600' : '400' })
  t.textContent = str
  return t
}

/**
 * @param {object} layout - elk.layout() の戻り値
 * @returns {SVGElement}
 */
export function renderToSvg(layout) {
  const pad = STYLE.padding

  // バウンディングボックスを計算
  let maxX = 0, maxY = 0
  for (const n of layout.children ?? []) {
    maxX = Math.max(maxX, (n.x ?? 0) + (n.width ?? 0))
    maxY = Math.max(maxY, (n.y ?? 0) + (n.height ?? 0))
  }
  const W = maxX + pad * 2
  const H = maxY + pad * 2

  const svg = el('svg', {
    width: W, height: H,
    viewBox: `0 0 ${W} ${H}`,
    style: 'background:#fafafa',
  })

  // ─── defs: 矢印マーカー ───────────────────────────────────────
  const defs = el('defs')
  defs.innerHTML = `
    <marker id="arr" markerWidth="8" markerHeight="8"
            refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L8,3 z" fill="${STYLE.edgeStroke}"/>
    </marker>
    <marker id="arr-fb" markerWidth="8" markerHeight="8"
            refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L8,3 z" fill="${STYLE.edgeStroke}" opacity="0.5"/>
    </marker>
  `
  svg.appendChild(defs)

  // ─── エッジ（ノードの背面に描画）────────────────────────────
  const edgeGroup = el('g', { class: 'edges' })
  for (const edge of layout.edges ?? []) {
    for (const sec of edge.sections ?? []) {
      const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x + pad},${p.y + pad}`).join(' ')
      edgeGroup.appendChild(el('path', {
        d,
        stroke: STYLE.edgeStroke,
        'stroke-width': STYLE.edgeWidth,
        fill: 'none',
        'marker-end': 'url(#arr)',
        'stroke-linejoin': 'round',
      }))
    }
  }
  svg.appendChild(edgeGroup)

  // ─── ノード ──────────────────────────────────────────────────
  const nodeGroup = el('g', { class: 'nodes' })

  for (const node of layout.children ?? []) {
    const nx = (node.x ?? 0) + pad
    const ny = (node.y ?? 0) + pad
    const nw = node.width  ?? 0
    const nh = node.height ?? 0

    const isExt = node.id.startsWith('ext.')
    const fill   = isExt ? STYLE.extFill   : STYLE.nodeFill
    const stroke = isExt ? STYLE.extStroke : STYLE.nodeStroke

    const g = el('g', { class: 'node', 'data-id': node.id })

    // 矩形
    g.appendChild(el('rect', {
      x: nx, y: ny, width: nw, height: nh,
      fill, stroke, 'stroke-width': STYLE.nodeStrokeWidth, rx: 3,
    }))

    // ラベル (外部ポートは矩形内中央、インスタンスは内部上部)
    const labels = node.labels ?? []
    if (isExt && labels[0]) {
      // 小さいボックス内に収める
      g.appendChild(text(labels[0].text, nx + nw / 2, ny + nh / 2 + 4))
    } else {
      if (labels[0]) {
        g.appendChild(text(labels[0].text, nx + nw / 2, ny + 14, { bold: true }))
      }
      if (labels[1]) {
        g.appendChild(text(labels[1].text, nx + nw / 2, ny + 26, {
          size: STYLE.subLabelSize, fill: '#666',
        }))
      }
    }

    // ポート
    for (const port of node.ports ?? []) {
      const px = nx + (port.x ?? 0)
      const py = ny + (port.y ?? 0)
      const ps = STYLE.portSize

      // ポート矩形
      g.appendChild(el('rect', {
        x: px - ps / 2, y: py - ps / 2,
        width: ps, height: ps,
        fill: STYLE.portFill, rx: 1,
      }))

      // ポートラベル（インスタンスのみ表示）
      if (!isExt && port.labels?.[0]) {
        const side = port.layoutOptions?.['port.side'] ?? 'WEST'
        const lx = side === 'WEST' ? px + ps : px - ps
        const anchor = side === 'WEST' ? 'start' : 'end'
        g.appendChild(text(port.labels[0].text, lx, py + 4, {
          size: 10, anchor, fill: '#333',
        }))
      }
    }

    nodeGroup.appendChild(g)
  }

  svg.appendChild(nodeGroup)
  return svg
}
