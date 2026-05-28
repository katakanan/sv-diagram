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
  constFill:       '#fffbe6',   // 定数ノード: 薄い黄色
  constStroke:     '#c8a020',
  portFill:        '#5566cc',
  portSize:        8,
  edgeStroke:      '#5566cc',
  edgeWidth:       1.5,
  // エディタと同じプログラミングフォント。リガチャは style 属性で無効化する。
  labelFont:       "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  labelSize:       12,
  subLabelSize:    11,
  padding:         24,
  jumpRadius:      5,           // ジャンプオーバー半円の半径 (px)
}

// リガチャ無効化スタイル（SVG text 要素に共通適用）
const NO_LIGATURES = "font-variant-ligatures: none; font-feature-settings: 'liga' 0, 'calt' 0;"

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const c of children) e.appendChild(c)
  return e
}
function text(str, x, y, { size = STYLE.labelSize, anchor = 'middle', fill = '#1d1d1f', bold = false } = {}) {
  const t = el('text', {
    x, y,
    'text-anchor':  anchor,
    'font-family':  STYLE.labelFont,
    'font-size':    size,
    fill,
    'font-weight':  bold ? '600' : '400',
    'letter-spacing': '0.3',
    style:          NO_LIGATURES,
  })
  t.textContent = str
  return t
}

// ─── ジャンプオーバー ─────────────────────────────────────────────

/**
 * 全エッジから直線セグメントを収集する。
 * @returns {{ x1,y1,x2,y2, ei,si,pi, isH }[]}
 */
function collectAllSegments(edges) {
  const segs = []
  edges.forEach((edge, ei) => {
    ;(edge.sections ?? []).forEach((sec, si) => {
      const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]
      for (let pi = 0; pi < pts.length - 1; pi++) {
        const p1 = pts[pi], p2 = pts[pi + 1]
        const isH = Math.abs(p1.y - p2.y) < 0.5
        const isV = Math.abs(p1.x - p2.x) < 0.5
        if (isH || isV) {
          segs.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ei, si, pi, isH })
        }
      }
    })
  })
  return segs
}

/**
 * 水平セグメントが異なるエッジの垂直セグメントと交差する X 座標を求める。
 *
 * 端点共有（接続点）は EPS でガード、近接交差は半円が重なるため除去する。
 *
 * @returns {Map<string, number[]>}  key = "ei-si-pi"、値は昇順ソート済み
 */
function buildCrossingMap(segs) {
  const map   = new Map()
  const hSegs = segs.filter(s =>  s.isH)
  const vSegs = segs.filter(s => !s.isH)
  const EPS   = 1.5
  const R     = STYLE.jumpRadius

  for (const h of hSegs) {
    const hMinX = Math.min(h.x1, h.x2)
    const hMaxX = Math.max(h.x1, h.x2)
    const hy    = h.y1   // 水平なので y1 == y2
    const xs    = []

    for (const v of vSegs) {
      if (h.ei === v.ei) continue           // 同一エッジ内は接続点として扱う
      const vx    = v.x1                    // 垂直なので x1 == x2
      const vMinY = Math.min(v.y1, v.y2)
      const vMaxY = Math.max(v.y1, v.y2)
      if (vx > hMinX + EPS && vx < hMaxX - EPS &&
          hy > vMinY + EPS && hy < vMaxY - EPS) {
        xs.push(vx)
      }
    }
    if (xs.length === 0) continue

    xs.sort((a, b) => a - b)

    // 半円が重なる近接クロッシングを除去
    const deduped = [xs[0]]
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - deduped[deduped.length - 1] > R * 2 + 1) deduped.push(xs[i])
    }
    map.set(`${h.ei}-${h.si}-${h.pi}`, deduped)
  }
  return map
}

/**
 * 水平セグメントのパス文字列を生成する（交差点に上向き半円アークを挿入）。
 * 先頭の M コマンドは呼び出し元が出力済みであること。
 *
 * @param {number}   x1       - セグメント開始 X
 * @param {number}   y1       - セグメント Y（水平なので始点・終点共通）
 * @param {number}   x2       - セグメント終了 X
 * @param {number[]|undefined} crossXs - 交差 X 座標の昇順配列
 */
function buildHSegPath(x1, y1, x2, crossXs) {
  if (!crossXs || crossXs.length === 0) return `L${x2},${y1}`

  const R      = STYLE.jumpRadius
  const dir    = x2 >= x1 ? 1 : -1
  // 進行方向に合わせて交差点を並び替える
  const sorted = dir > 0 ? crossXs : [...crossXs].reverse()
  const parts  = []

  for (const cx of sorted) {
    // 半円手前まで直線
    parts.push(`L${cx - dir * R},${y1}`)
    // 上向き半円: sweep=0 (counterclockwise) → SVG y 下向き座標系で上方向
    parts.push(`A${R},${R} 0 0 0 ${cx + dir * R},${y1}`)
  }
  parts.push(`L${x2},${y1}`)
  return parts.join(' ')
}

/**
 * @param {object} layout - elk.layout() の戻り値
 * @returns {SVGElement}
 */
export function renderToSvg(layout) {
  const pad = STYLE.padding

  // SVG はコンテナ全体を占有する
  const svg = el('svg', {
    width: '100%', height: '100%',
    style: 'background:#fafafa; display:block;',
  })

  // ─── defs: 矢印マーカー ───────────────────────────────────────
  // markerUnits="userSpaceOnUse" + viewBox でストローク幅が変わっても
  // 矢印サイズを固定する（strokeWidth 基準だと選択時に拡大してしまう）
  const defs = el('defs')
  defs.innerHTML = `
    <marker id="arr" viewBox="0 0 8 8" markerWidth="12" markerHeight="12"
            refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L0,6 L8,3 z" fill="${STYLE.edgeStroke}"/>
    </marker>
    <marker id="arr-fb" viewBox="0 0 8 8" markerWidth="12" markerHeight="12"
            refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L0,6 L8,3 z" fill="${STYLE.edgeStroke}" opacity="0.5"/>
    </marker>
  `
  svg.appendChild(defs)

  // ─── コンテンツグループ（パン操作で translate が変わる）──────
  const content = el('g', {
    class: 'sv-content',
    transform: `translate(${pad},${pad})`,
  })

  // ─── クロッシング検出 ─────────────────────────────────────────
  const allSegs     = collectAllSegments(layout.edges ?? [])
  const crossingMap = buildCrossingMap(allSegs)

  // ─── エッジ（ノードの背面に描画）────────────────────────────
  const edgeGroup = el('g', { class: 'edges' })

  for (const [ei, edge] of (layout.edges ?? []).entries()) {
    for (const [si, sec] of (edge.sections ?? []).entries()) {
      const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]
      let d = `M${pts[0].x},${pts[0].y}`

      for (let pi = 0; pi < pts.length - 1; pi++) {
        const p1  = pts[pi]
        const p2  = pts[pi + 1]
        const isH = Math.abs(p1.y - p2.y) < 0.5

        if (isH) {
          const crossXs = crossingMap.get(`${ei}-${si}-${pi}`)
          d += ' ' + buildHSegPath(p1.x, p1.y, p2.x, crossXs)
        } else {
          d += ` L${p2.x},${p2.y}`
        }
      }

      // エッジグループ: data-id でクリック選択できるようにする
      const eg = el('g', { class: 'edge', 'data-id': edge.id ?? `e${ei}` })

      // 透明な太いヒットエリア（細い線でも容易にクリックできるよう）
      eg.appendChild(el('path', {
        d,
        stroke: 'transparent',
        'stroke-width': 10,
        fill: 'none',
        'pointer-events': 'stroke',
      }))

      // 表示用パス（ポインターイベントはヒットエリアに委ねる）
      eg.appendChild(el('path', {
        d,
        class: 'edge-line',
        stroke: STYLE.edgeStroke,
        'stroke-width': STYLE.edgeWidth,
        fill: 'none',
        'marker-end': 'url(#arr)',
        'stroke-linejoin': 'round',
        'pointer-events': 'none',
      }))

      edgeGroup.appendChild(eg)
    }
  }

  content.appendChild(edgeGroup)

  // ─── ノード ──────────────────────────────────────────────────
  const nodeGroup = el('g', { class: 'nodes' })

  for (const node of layout.children ?? []) {
    const nx = node.x ?? 0
    const ny = node.y ?? 0
    const nw = node.width  ?? 0
    const nh = node.height ?? 0

    const isExt    = node.id.startsWith('ext.')
    const isConst  = node.id.startsWith('const.')
    const isFfReg  = node.id.startsWith('ff_reg.')
    const isFfComb = node.id.startsWith('ff_comb.')
    const fill    = isExt    ? STYLE.extFill
                  : isConst  ? STYLE.constFill
                  : isFfReg  ? '#e8f4e8'   // 薄い緑: DFF レジスタ
                  : isFfComb ? '#f0f8e8'   // 薄い黄緑: 次状態ロジック
                  :            STYLE.nodeFill
    const stroke  = isExt    ? STYLE.extStroke
                  : isConst  ? STYLE.constStroke
                  : isFfReg  ? '#3a8a3a'
                  : isFfComb ? '#6a9a3a'
                  :            STYLE.nodeStroke

    const isInstNode = node.id.startsWith('inst.')
    const g = el('g', {
      class: 'node' + (isInstNode ? ' inst-module' : ''),
      'data-id': node.id,
    })

    // 背景矩形（選択・ホバーの対象）
    g.appendChild(el('rect', {
      x: nx, y: ny, width: nw, height: nh,
      fill, stroke, 'stroke-width': STYLE.nodeStrokeWidth, rx: 3,
      class: 'node-bg',
    }))

    // ラベル (外部ポート・定数は矩形内中央、インスタンスは内部上部)
    const labels = node.labels ?? []
    if ((isExt || isConst) && labels[0]) {
      g.appendChild(text(labels[0].text, nx + nw / 2, ny + nh / 2 + 4,
        { size: STYLE.subLabelSize, fill: isConst ? '#7a6010' : '#1d1d1f' }))
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

      // 定数ノードはポートドットを描かない
      if (!isConst) {
        // 通常のポートドット（境界上の正方形）は常に描画
        g.appendChild(el('rect', {
          x: px - ps / 2, y: py - ps / 2,
          width: ps, height: ps,
          fill: STYLE.portFill, rx: 1,
        }))
        // ff_reg の CLK ポート: ノード内側にクロック三角形を追加描画
        // WEST ポートの px はノード左辺と一致するため、
        // 底辺を px に置いて先端をノード内部（+x 方向）へ向ける
        if (isFfReg && port.labels?.[0]?.text === 'CLK') {
          const ts = ps * 2   // 三角形サイズ（ポートドットの2倍）
          g.appendChild(el('polygon', {
            points: [
              `${px},${py - ts / 2}`,   // 左上（ノード左辺）
              `${px},${py + ts / 2}`,   // 左下（ノード左辺）
              `${px + ts},${py}`,       // 右先端（ノード内部）
            ].join(' '),
            fill: 'none',
            stroke: STYLE.portFill,
            'stroke-width': 1.5,
          }))
        }
      }

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

  content.appendChild(nodeGroup)
  svg.appendChild(content)
  return svg
}
