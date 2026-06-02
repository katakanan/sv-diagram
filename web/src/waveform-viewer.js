// ─── SVG 波形ビューワ ─────────────────────────────────────────────────────────
//
// Usage:
//   import { createWaveformViewer } from './waveform-viewer.js'
//
//   const ctrl = createWaveformViewer(containerEl, {
//     scope:        "counter_tb",
//     signals:      [{ name, id, width, changes: [[vcdTime, value], ...] }],
//     timescale_fs: 1_000_000,   // 1 VCD time unit = 1_000_000 fs (= 1 ns)
//     max_time:     350,          // 最大 VCD 時刻
//   })
//
//   ctrl.setCursor(timeFs)    // カーソルを指定時刻 (fs) に移動
//   ctrl.getCursor()          // 現在のカーソル時刻 (fs) を返す
//   ctrl.onCursorMove(fn)     // fn(timeFs) を登録 — カーソル移動時に呼ばれる
//   ctrl.update(newData)      // データを更新して再描画
//   ctrl.destroy()            // DOM・イベントリスナーをクリーンアップ

// ─── レイアウト定数 ──────────────────────────────────────────────────────────

const ROW_H      = 32    // 1 信号の行高さ (px)
const LABEL_W    = 128   // 信号名ラベルエリア幅 (px)
const VALUE_W    = 76    // カーソル位置の値表示エリア幅 (px)
const AXIS_H     = 22    // 時刻軸エリア高さ (px)
const WAVE_PAD   = 7     // 波形上下マージン (px) — hi = PAD, lo = ROW_H - PAD
const SLANT      = 5     // バス信号の遷移斜線幅 (px)
const MIN_PX_NS  = 0.2   // ピクセル/ns の下限
const MAX_PX_NS  = 20    // ピクセル/ns の上限

const SVG_NS = 'http://www.w3.org/2000/svg'

// ─── ユーティリティ ──────────────────────────────────────────────────────────

/** SVG 要素を作成 */
function svgEl(tag, attrs = {}, text = null) {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text !== null) e.textContent = text
  return e
}

/** VCD 時刻 → ナノ秒 */
function toNs(vcdTime, tsFs) { return vcdTime * tsFs / 1e6 }

/** ナノ秒 → 見やすい文字列 */
function fmtTime(ns) {
  if      (ns >= 1e6)  return `${(ns / 1e6).toFixed(1)} s`
  else if (ns >= 1e3)  return `${(ns / 1e3).toFixed(1)} µs`
  else if (ns >= 100)  return `${ns.toFixed(0)} ns`
  else if (ns >= 1)    return `${ns.toFixed(1)} ns`
  else                 return `${(ns * 1000).toFixed(0)} ps`
}

/** 時刻軸の tick 間隔を決める (nice number) */
function tickInterval(totalNs, targetTicks = 8) {
  if (totalNs <= 0) return 1
  const raw  = totalNs / targetTicks
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10
  return nice * mag
}

/** 2進文字列 → 16進文字列 (x/z を含む場合はそのまま) */
function binToHex(val) {
  if (!val || /[xzXZ]/.test(val)) return val ?? 'x'
  const n = parseInt(val, 2)
  return isNaN(n) ? val : `0x${n.toString(16).toUpperCase()}`
}

/** 値が不定 (x/z のみ) かどうか */
function isUnknown(val) { return !val || /^[xzXZ]+$/.test(val) }

/**
 * 信号の変化リストから、カーソル時刻における値を取得して表示用オブジェクトに変換する。
 * @param {{ width: number, changes: [number, string][] }} sig
 * @param {number} cFs      カーソル時刻 (fs)
 * @param {number} tsFs     timescale_fs
 * @returns {{ text: string, cls: string }}
 */
function getValDisplay(sig, cFs, tsFs) {
  const cVcd = cFs / tsFs   // カーソル時刻を VCD 時刻単位に変換
  let val = null
  for (const [t, v] of sig.changes) {
    if (t <= cVcd) val = v
    else break
  }
  if (val === null) return { text: '—', cls: 'wv-val-x' }
  if (sig.width === 1) {
    if (val === '1') return { text: '1', cls: 'wv-val-hi' }
    if (val === '0') return { text: '0', cls: 'wv-val-lo' }
    return { text: val, cls: 'wv-val-x' }
  }
  if (isUnknown(val)) return { text: 'x', cls: 'wv-val-x' }
  return { text: binToHex(val), cls: 'wv-val-hex' }
}

// ─── 波形パス構築 ─────────────────────────────────────────────────────────────

/**
 * 1ビット信号の SVG path d 文字列を生成する。
 * @param {[number, string][]} changes  [[vcdTime, '0'|'1'|'x'|'z'], ...]
 * @param {number} tsFs     timescale_fs
 * @param {number} totalNs  総時間 (ns)
 * @param {number} ppn      pixels per ns
 * @returns {string}
 */
function build1BitPath(changes, tsFs, totalNs, ppn) {
  const hi   = WAVE_PAD
  const lo   = ROW_H - WAVE_PAD
  const mid  = ROW_H / 2
  const endX = totalNs * ppn

  if (!changes || changes.length === 0) {
    return `M0,${mid} H${endX}`
  }

  const pts   = []
  let   prevY = mid   // 最初は不定

  for (const [t, v] of changes) {
    const x  = Math.min(toNs(t, tsFs) * ppn, endX)
    const ny = v === '1' ? hi : v === '0' ? lo : mid

    if (pts.length === 0) {
      pts.push(`M0,${prevY}`)
    }
    pts.push(`H${x.toFixed(2)}`)
    if (ny !== prevY) pts.push(`V${ny}`)
    prevY = ny
  }

  // 末端まで延ばす
  pts.push(`H${endX.toFixed(2)}`)

  return pts.join(' ')
}

/**
 * バス信号の波形要素群を SVG グループ g に追加する。
 * @param {[number, string][]} changes
 * @param {number} tsFs
 * @param {number} totalNs
 * @param {number} ppn
 * @param {SVGGElement} g   追加先の <g>
 */
function buildBusWave(changes, tsFs, totalNs, ppn, g) {
  const hi   = WAVE_PAD
  const lo   = ROW_H - WAVE_PAD
  const mid  = ROW_H / 2
  const endX = totalNs * ppn

  if (!changes || changes.length === 0) {
    g.appendChild(svgEl('line', { x1: 0, y1: mid, x2: endX, y2: mid, class: 'wv-x' }))
    return
  }

  // セグメント境界 (px 単位)
  const xs = changes.map(([t]) => Math.min(toNs(t, tsFs) * ppn, endX))
  xs.push(endX)

  // 先頭不定区間
  if (xs[0] > 0.5) {
    g.appendChild(svgEl('line', { x1: 0, y1: mid, x2: xs[0].toFixed(2), y2: mid, class: 'wv-x' }))
  }

  for (let i = 0; i < changes.length; i++) {
    const val = changes[i][1]
    const x0  = xs[i]
    const x1  = xs[i + 1]
    const w   = x1 - x0

    if (isUnknown(val)) {
      g.appendChild(svgEl('line', {
        x1: x0.toFixed(2), y1: mid,
        x2: x1.toFixed(2), y2: mid,
        class: 'wv-x',
      }))
      continue
    }

    // 斜線幅 (セグメント幅の半分を超えない)
    const sl = Math.min(SLANT, w / 2)
    const sx = (x0 + sl).toFixed(2)   // 左斜線終点
    const ex = (x1 - sl).toFixed(2)   // 右斜線始点
    const x0s = x0.toFixed(2)
    const x1s = x1.toFixed(2)

    // 塗りつぶし
    g.appendChild(svgEl('path', {
      d: `M${x0s},${mid} L${sx},${hi} H${ex} L${x1s},${mid} L${ex},${lo} H${sx} Z`,
      class: 'wv-bus-fill',
    }))
    // 上辺
    g.appendChild(svgEl('path', {
      d: `M${x0s},${mid} L${sx},${hi} H${ex} L${x1s},${mid}`,
      class: 'wv-bus-edge', fill: 'none',
    }))
    // 下辺
    g.appendChild(svgEl('path', {
      d: `M${x0s},${mid} L${sx},${lo} H${ex} L${x1s},${mid}`,
      class: 'wv-bus-edge', fill: 'none',
    }))

    // 値テキスト (十分な幅がある場合のみ)
    const innerW = parseFloat(ex) - parseFloat(sx)
    if (innerW > 14) {
      const tx = (parseFloat(sx) + innerW / 2).toFixed(2)
      g.appendChild(svgEl('text', {
        x: tx, y: mid,
        class: 'wv-bus-val',
        'text-anchor':       'middle',
        'dominant-baseline': 'middle',
      }, binToHex(val)))
    }
  }
}

// ─── メイン API ──────────────────────────────────────────────────────────────

/**
 * コンテナ要素に SVG 波形ビューワを生成する。
 *
 * @param {HTMLElement} container  表示先の DOM 要素
 * @param {object}      data
 *   @param {string}            data.scope
 *   @param {WaveSignal[]}      data.signals   [{name, id, width, changes}]
 *   @param {number}            data.timescale_fs
 *   @param {number}            data.max_time
 *
 * @returns {{ setCursor, getCursor, onCursorMove, update, destroy }}
 */
export function createWaveformViewer(container, data) {
  // ─── 状態 ──────────────────────────────────────────────────────
  let currentData    = data
  let ppn            = 1        // pixels per ns (再計算で更新)
  let zoomFactor     = 1.0      // ユーザーが操作する時間軸ズーム倍率
  let cursorFs       = 0        // カーソル時刻 (fs 単位)
  const moveListeners  = []
  const clickListeners = []     // 信号名クリック時コールバック
  const cleanups     = []       // destroy 時に解除するイベントリスナー

  const ZOOM_STEP = 1.5
  const ZOOM_MAX  = 64
  const ZOOM_MIN  = 1 / 32

  // ─── DOM 骨格 ──────────────────────────────────────────────────
  container.innerHTML = ''
  container.classList.add('wv-root')

  //  ┌─────────────────────────────────────────────┐
  //  │  wv-header  (スコープ名 + カーソル時刻)     │
  //  ├────────────┬────────────────────────────────┤
  //  │ wv-labels  │  wv-wave-scroll                │
  //  │ (固定幅)   │  (横スクロール可)              │
  //  └────────────┴────────────────────────────────┘

  const headerEl  = document.createElement('div')
  headerEl.className = 'wv-header'
  container.appendChild(headerEl)

  // ヘッダー内: スコープ名 + カーソル時刻テキスト
  const headerText = document.createElement('span')
  headerText.className = 'wv-header-text'
  headerEl.appendChild(headerText)

  // ヘッダー内: ズームボタン群
  const zoomWrap = document.createElement('div')
  zoomWrap.className = 'wv-zoom-wrap'
  ;[['−', () => { zoomFactor = Math.max(zoomFactor / ZOOM_STEP, ZOOM_MIN); render() }],
    ['1:1', () => { zoomFactor = 1.0; render() }],
    ['+', () => { zoomFactor = Math.min(zoomFactor * ZOOM_STEP, ZOOM_MAX); render() }],
  ].forEach(([label, fn]) => {
    const btn = document.createElement('button')
    btn.className   = 'wv-zoom-btn'
    btn.textContent = label
    btn.addEventListener('click', fn)
    zoomWrap.appendChild(btn)
  })
  headerEl.appendChild(zoomWrap)

  const bodyEl = document.createElement('div')
  bodyEl.className = 'wv-body'
  container.appendChild(bodyEl)

  const labelWrap = document.createElement('div')
  labelWrap.className = 'wv-label-wrap'
  bodyEl.appendChild(labelWrap)

  // ラベル行クリック → 信号名コールバック
  labelWrap.addEventListener('click', e => {
    const rect = labelWrap.getBoundingClientRect()
    const i    = Math.floor((e.clientY - rect.top) / ROW_H)
    if (i >= 0 && i < currentData.signals.length) {
      const sigName = currentData.signals[i].name
      for (const fn of clickListeners) fn(sigName)
    }
  })

  // 値表示エリア（カーソル位置の信号値）— ラベルと波形の間
  const valueWrap = document.createElement('div')
  valueWrap.className = 'wv-value-wrap'
  bodyEl.appendChild(valueWrap)

  const waveScroll = document.createElement('div')
  waveScroll.className = 'wv-wave-scroll'
  bodyEl.appendChild(waveScroll)

  // ─── レンダリング ──────────────────────────────────────────────
  function render() {
    const { scope, signals, timescale_fs, max_time } = currentData
    const nSigs   = signals.length
    const totalNs = toNs(max_time, timescale_fs)

    // pixels/ns を算出: コンテナ幅に合わせた基準値 × ズーム倍率
    const availW  = waveScroll.clientWidth || 600
    const basePpn = Math.max(MIN_PX_NS, Math.min(MAX_PX_NS, (availW - 24) / Math.max(totalNs, 1)))
    ppn = basePpn * zoomFactor

    const totalPx = totalNs * ppn
    const svgW    = Math.max(totalPx + 32, availW)
    const svgH    = nSigs * ROW_H + AXIS_H

    // ── ラベル SVG ─────────────────────────────────────────────
    const lsvg = svgEl('svg', {
      width:  LABEL_W,
      height: svgH,
      class:  'wv-label-svg',
    })

    signals.forEach((sig, i) => {
      // 行背景
      lsvg.appendChild(svgEl('rect', {
        x: 0, y: i * ROW_H,
        width: LABEL_W, height: ROW_H,
        class: `wv-row-bg ${i % 2 ? 'odd' : 'even'}`,
      }))
      // ラベルテキスト
      lsvg.appendChild(svgEl('text', {
        x: LABEL_W - 8,
        y: i * ROW_H + ROW_H / 2,
        class: 'wv-label',
        'text-anchor':       'end',
        'dominant-baseline': 'middle',
      }, sig.width > 1 ? `${sig.name}[${sig.width - 1}:0]` : sig.name))
      // 区切り線
      if (i > 0) {
        lsvg.appendChild(svgEl('line', {
          x1: 0, y1: i * ROW_H, x2: LABEL_W, y2: i * ROW_H,
          class: 'wv-sep',
        }))
      }
    })

    // ラベル行ハイライトオーバーレイ
    signals.forEach((_, i) => {
      lsvg.appendChild(svgEl('rect', {
        'data-hlrow': i,
        x: 0, y: i * ROW_H,
        width: LABEL_W, height: ROW_H,
        class: 'wv-hl-rect',
        visibility: 'hidden',
        'pointer-events': 'none',
      }))
    })

    // 時刻軸下部の空白行（高さを wsvg に合わせるため）
    lsvg.appendChild(svgEl('rect', {
      x: 0, y: nSigs * ROW_H,
      width: LABEL_W, height: AXIS_H,
      class: 'wv-axis-bg',
    }))

    // ── 波形 SVG ───────────────────────────────────────────────
    const wsvg = svgEl('svg', {
      width:  svgW,
      height: svgH,
      class:  'wv-wave-svg',
    })

    // 行背景
    signals.forEach((_, i) => {
      wsvg.appendChild(svgEl('rect', {
        x: 0, y: i * ROW_H,
        width: svgW, height: ROW_H,
        class: `wv-row-bg ${i % 2 ? 'odd' : 'even'}`,
      }))
    })

    // グリッド線 (信号エリア)
    const dt = tickInterval(totalNs)
    for (let t = dt; t <= totalNs + dt * 0.01; t += dt) {
      const x = t * ppn
      wsvg.appendChild(svgEl('line', {
        x1: x.toFixed(2), y1: 0,
        x2: x.toFixed(2), y2: nSigs * ROW_H,
        class: 'wv-grid',
      }))
    }

    // 行区切り線
    signals.forEach((_, i) => {
      if (i > 0) {
        wsvg.appendChild(svgEl('line', {
          x1: 0, y1: i * ROW_H, x2: svgW, y2: i * ROW_H,
          class: 'wv-sep',
        }))
      }
    })

    // 波形
    signals.forEach((sig, i) => {
      const g = svgEl('g', {
        transform: `translate(0,${i * ROW_H})`,
        'data-sig': sig.name,
      })
      if (sig.width === 1) {
        g.appendChild(svgEl('path', {
          d: build1BitPath(sig.changes, timescale_fs, totalNs, ppn),
          class: 'wv-1bit',
          fill: 'none',
        }))
      } else {
        buildBusWave(sig.changes, timescale_fs, totalNs, ppn, g)
      }
      wsvg.appendChild(g)
    })

    // 時刻軸
    const axisG = svgEl('g', {
      transform: `translate(0,${nSigs * ROW_H})`,
      class: 'wv-axis',
    })
    wsvg.appendChild(axisG)

    axisG.appendChild(svgEl('rect', {
      x: 0, y: 0, width: svgW, height: AXIS_H,
      class: 'wv-axis-bg',
    }))
    axisG.appendChild(svgEl('line', {
      x1: 0, y1: 0, x2: svgW, y2: 0,
      class: 'wv-axis-base',
    }))

    for (let t = 0; t <= totalNs + dt * 0.01; t += dt) {
      const x    = (t * ppn).toFixed(2)
      const anchor = t === 0 ? 'start' : 'middle'
      axisG.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: 5, class: 'wv-tick' }))
      axisG.appendChild(svgEl('text', {
        x, y: 7,
        class: 'wv-tick-label',
        'dominant-baseline': 'hanging',
        'text-anchor':        anchor,
      }, fmtTime(t)))
    }

    // ハイライト行オーバーレイ（各行に 1 枚、visibility で制御）
    signals.forEach((_, i) => {
      wsvg.appendChild(svgEl('rect', {
        'data-hlrow': i,
        x: 0, y: i * ROW_H,
        width: svgW, height: ROW_H,
        class: 'wv-hl-rect',
        visibility: 'hidden',
        'pointer-events': 'none',
      }))
    })

    // カーソル (最前面)
    const cursorG = svgEl('g', { class: 'wv-cursor', id: 'wv-cursor' })
    const cx = ((cursorFs / 1e6) * ppn).toFixed(2)
    cursorG.appendChild(svgEl('line', {
      id: 'wv-cline',
      x1: cx, y1: 0, x2: cx, y2: nSigs * ROW_H + AXIS_H,
      class: 'wv-cursor-line',
    }))
    cursorG.appendChild(svgEl('polygon', {
      id: 'wv-chead',
      points: `${cx - 5},0 ${parseFloat(cx) + 5},0 ${cx},8`,
      class: 'wv-cursor-head',
    }))
    wsvg.appendChild(cursorG)

    // ── ヘッダー更新 ──────────────────────────────────────────
    updateHeader()

    // ── 値表示 SVG ────────────────────────────────────────────
    const vsvg = svgEl('svg', {
      width:  VALUE_W,
      height: svgH,
      class:  'wv-value-svg',
    })
    signals.forEach((sig, i) => {
      vsvg.appendChild(svgEl('rect', {
        x: 0, y: i * ROW_H,
        width: VALUE_W, height: ROW_H,
        class: `wv-row-bg ${i % 2 ? 'odd' : 'even'}`,
      }))
      if (i > 0) {
        vsvg.appendChild(svgEl('line', {
          x1: 0, y1: i * ROW_H, x2: VALUE_W, y2: i * ROW_H,
          class: 'wv-sep',
        }))
      }
      const { text, cls } = getValDisplay(sig, cursorFs, timescale_fs)
      vsvg.appendChild(svgEl('text', {
        id: `wv-val-${i}`,
        x: 6,
        y: i * ROW_H + ROW_H / 2,
        class: `wv-val-text ${cls}`,
        'dominant-baseline': 'middle',
      }, text))
    })
    // 値列ハイライトオーバーレイ
    signals.forEach((_, i) => {
      vsvg.appendChild(svgEl('rect', {
        'data-hlrow': i,
        x: 0, y: i * ROW_H,
        width: VALUE_W, height: ROW_H,
        class: 'wv-hl-rect',
        visibility: 'hidden',
        'pointer-events': 'none',
      }))
    })

    // 時刻軸行の背景（高さを合わせる）
    vsvg.appendChild(svgEl('rect', {
      x: 0, y: nSigs * ROW_H,
      width: VALUE_W, height: AXIS_H,
      class: 'wv-axis-bg',
    }))

    // ── DOM に反映 ────────────────────────────────────────────
    labelWrap.innerHTML = ''
    labelWrap.appendChild(lsvg)

    waveScroll.innerHTML = ''
    waveScroll.appendChild(wsvg)

    valueWrap.innerHTML = ''
    valueWrap.appendChild(vsvg)

    // ── マウスイベント (カーソルドラッグ) ───────────────────
    function xToFs(clientX) {
      const rect = wsvg.getBoundingClientRect()
      const x    = clientX - rect.left
      const ns   = x / ppn
      return Math.max(0, Math.min(toNs(max_time, timescale_fs) * 1e6, ns * 1e6))
    }

    let dragging = false

    const onDown = e => {
      dragging = true
      moveCursor(xToFs(e.clientX))
      e.preventDefault()
    }
    const onMove = e => {
      if (!dragging) return
      moveCursor(xToFs(e.clientX))
    }
    const onUp   = () => { dragging = false }

    wsvg.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)

    // 前回の wave イベントリスナーを解除してから新しいものを登録
    const last = cleanups[cleanups.length - 1]
    if (last?.isWaveCleanup) {
      last.fn()
      cleanups.pop()
    }
    cleanups.push({
      isWaveCleanup: true,
      fn: () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup',   onUp)
      },
    })
  }

  // ─── カーソル移動（軽量更新 — SVG 再生成なし）──────────────
  function moveCursor(timeFs) {
    cursorFs = timeFs
    updateCursorDom()
    updateValueDisplay()
    updateHeader()
    for (const fn of moveListeners) fn(timeFs)
  }

  /** カーソル位置の各信号値を更新する（SVG 再生成なし） */
  function updateValueDisplay() {
    const { signals, timescale_fs } = currentData
    signals.forEach((sig, i) => {
      const el = valueWrap.querySelector(`#wv-val-${i}`)
      if (!el) return
      const { text, cls } = getValDisplay(sig, cursorFs, timescale_fs)
      el.textContent = text
      el.setAttribute('class', `wv-val-text ${cls}`)
    })
  }

  function updateCursorDom() {
    const cx = ((cursorFs / 1e6) * ppn).toFixed(2)
    const line = waveScroll.querySelector('#wv-cline')
    const head = waveScroll.querySelector('#wv-chead')
    if (line) {
      line.setAttribute('x1', cx)
      line.setAttribute('x2', cx)
    }
    if (head) {
      head.setAttribute('points', `${parseFloat(cx) - 5},0 ${parseFloat(cx) + 5},0 ${cx},8`)
    }
  }

  function updateHeader() {
    const { scope } = currentData
    const ns = (cursorFs / 1e6).toFixed(2)
    headerText.textContent = `${scope}  |  t = ${ns} ns`
  }

  // ─── 行ハイライト ─────────────────────────────────────────────
  /**
   * 指定した信号名の行をハイライトする。null で全解除。
   * @param {string|null} name
   */
  function highlightSignal(name) {
    // 全ハイライトを解除
    for (const wrap of [labelWrap, valueWrap, waveScroll]) {
      wrap.querySelectorAll('.wv-hl-rect').forEach(r => r.setAttribute('visibility', 'hidden'))
    }
    if (!name) return
    const idx = currentData.signals.findIndex(s => s.name === name)
    if (idx < 0) return
    for (const wrap of [labelWrap, valueWrap, waveScroll]) {
      wrap.querySelector(`.wv-hl-rect[data-hlrow="${idx}"]`)
          ?.setAttribute('visibility', 'visible')
    }
  }

  // ─── 初回描画 ─────────────────────────────────────────────────
  render()

  // ─── 公開 API ─────────────────────────────────────────────────
  return {
    /** カーソルを指定時刻 (fs) に移動する */
    setCursor(timeFs) {
      cursorFs = timeFs
      updateCursorDom()
      updateValueDisplay()
      updateHeader()
    },

    /** 現在のカーソル時刻 (fs) を返す */
    getCursor() { return cursorFs },

    /** カーソル移動時に呼ばれるコールバックを登録する */
    onCursorMove(fn) { moveListeners.push(fn) },

    /** 信号名ラベルクリック時に呼ばれるコールバックを登録する */
    onSignalClick(fn) { clickListeners.push(fn) },

    /** 指定した信号名の行をハイライトする（null で全解除） */
    highlightSignal(name) { highlightSignal(name) },

    /** データを更新して再描画する */
    update(newData) {
      currentData = newData
      render()
    },

    /** ビューワを破棄してリスナーを解除する */
    destroy() {
      for (const c of cleanups) {
        if (typeof c === 'function') c()
        else if (c?.fn) c.fn()
      }
      cleanups.length = 0
      container.innerHTML = ''
      container.classList.remove('wv-root')
    },
  }
}
