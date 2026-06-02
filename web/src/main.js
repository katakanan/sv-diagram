import ELK from 'elkjs/lib/elk.bundled.js'
import { lower_sv, parse_vcd } from '../wasm/sv_wasm.js'
import { buildElkGraph } from './elk-builder.js'
import { renderToSvg }   from './renderer.js'
import { createWaveformViewer } from './waveform-viewer.js'
import { EditorView, basicSetup } from 'codemirror'
import { StreamLanguage }         from '@codemirror/language'
import { verilog }                from '@codemirror/legacy-modes/mode/verilog'

// ─── デフォルトの SV ソース ──────────────────────────────────────
const DEFAULT_SV = `\
\`timescale 1ns/1ps
// ─── Counter ─────────────────────────────────────────────────────
// WIDTH ビット幅の同期カウンター（非同期アクティブローリセット付き）
// sim/counter.sv と同一コード
// ─────────────────────────────────────────────────────────────────
module counter #(
  parameter int unsigned WIDTH = 8
)(
  input  var logic             clk,
  input  var logic             rst_n,
  output var logic [WIDTH-1:0] count
);

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      count <= '0;
    end else begin
      count <= count + 1;
    end
  end

endmodule

// ─── Counter テストベンチ ──────────────────────────────────────────
// VCD ファイルを生成してシミュレーション波形を保存する。
//
// シミュレーション手順:
//   iverilog -g2012 -o counter_sim counter_tb.sv counter.sv
//   vvp counter_sim
//   → counter.vcd が生成される
// ─────────────────────────────────────────────────────────────────
module counter_tb;

  // ─── 信号 ──────────────────────────────────────────────────────
  logic       clk   = 1'b0;
  logic       rst_n = 1'b0;
  logic [7:0] count;

  // ─── DUT インスタンス ──────────────────────────────────────────
  counter #(.WIDTH(8)) u_counter (
    .clk  (clk),
    .rst_n(rst_n),
    .count(count)
  );

  // ─── クロック生成（10 ns 周期 / 100 MHz 相当）──────────────────
  always #5 clk = ~clk;

  // ─── テストシーケンス ───────────────────────────────────────────
  initial begin
    \$dumpfile("counter.vcd");
    \$dumpvars(0, counter_tb);

    // ── リセット（3 サイクル）────────────────────────────────────
    rst_n = 1'b0;
    repeat(3) @(posedge clk);
    #1 rst_n = 1'b1;

    // ── カウントアップ（20 サイクル）────────────────────────────
    repeat(20) @(posedge clk);

    // ── リセット再印加（2 サイクル）────────────────────────────
    #1 rst_n = 1'b0;
    repeat(2) @(posedge clk);
    #1 rst_n = 1'b1;

    // ── 残り 10 サイクル ────────────────────────────────────────
    repeat(10) @(posedge clk);

    #1 \$finish;
  end

  // ─── モニタ（シミュレーションログ）────────────────────────────
  initial begin
    \$monitor("t=%0t  rst_n=%b  count=%0d", \$time, rst_n, count);
  end

endmodule
`

// ─── DOM refs ───────────────────────────────────────────────────
const statusEl     = document.getElementById('status')
const renderBtn    = document.getElementById('render-btn')
const backBtn      = document.getElementById('back-btn')
const moduleSelect = document.getElementById('module-select')
const diagramWrap  = document.getElementById('diagram-wrap')
const propsKindEl  = document.getElementById('props-kind')
const propsIdEl    = document.getElementById('props-id')
const propsBodyEl  = document.getElementById('props-body')

// ─── CodeMirror エディタ初期化 ────────────────────────────────────
const editor = new EditorView({
  doc: DEFAULT_SV,
  extensions: [
    basicSetup,
    StreamLanguage.define(verilog),
    EditorView.theme({
      // ベースカラーをページの白背景に合わせる
      '&': { background: '#fff' },
      '.cm-gutters': {
        background: '#f5f5f7',
        borderRight: '1px solid #e0e0e0',
        color: '#999',
      },
      '.cm-activeLineGutter': { background: '#eef0f8' },
      '.cm-activeLine':       { background: '#eef0f820' },
    }),
  ],
  parent: document.getElementById('sv-source-editor'),
})

// ─── ELK インスタンス ─────────────────────────────────────────
const elk = new ELK()

// ─── 階層ナビゲーション ───────────────────────────────────────
/** パース済みツリー（Renderボタンで更新） */
let currentTree      = null
/** 現在表示しているモジュールのインデックス */
let currentModuleIdx = 0
/** ドリルダウン履歴: { moduleIdx, moduleName }[] */
let navStack         = []

/** 最新レイアウト結果（ポート→エッジ逆引き用） */
let currentLayout = null

/**
 * ELK レイアウト結果からポート ID → エッジ ID 一覧のマップを構築する。
 * ext.* ノード選択時に接続エッジをハイライトするために使用。
 * @param {object} layout - elk.layout() の戻り値
 * @returns {Map<string, string[]>}
 */
function buildPortEdgeMap(layout) {
  const map = new Map()
  for (const edge of layout.edges ?? []) {
    for (const pid of [...(edge.sources ?? []), ...(edge.targets ?? [])]) {
      if (!map.has(pid)) map.set(pid, [])
      map.get(pid).push(edge.id)
    }
  }
  return map
}

// ─── プロパティパネル ─────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** プロパティパネルを更新する */
function renderProps(kind, id, rows) {
  propsKindEl.textContent = kind
  propsIdEl.textContent   = id ? `— ${id}` : ''
  if (!rows || rows.length === 0) {
    propsBodyEl.innerHTML = '<span class="props-empty">ノードまたはエッジを選択してください</span>'
    return
  }
  propsBodyEl.innerHTML = rows.map(([k, v]) =>
    `<div class="props-row">
       <span class="props-key">${esc(k)}</span>
       <span class="props-val">${esc(v)}</span>
     </div>`
  ).join('')
}

/** グループノード ID からプロパティ行を返す */
function getGroupProps(groupId) {
  if (groupId.startsWith('group_comb.')) {
    // always_comb / always_latch グループ: group_comb.${i}
    const i  = parseInt(groupId.slice('group_comb.'.length))
    const mod = currentTree?.modules[currentModuleIdx]
    const ab  = mod?.always_blocks[i]
    if (!ab) return { kind: 'Comb Group', rows: [['id', groupId]] }
    const kind = ab.kind === 'Latch' ? 'Latch Group' : 'Comb Group'
    const rows = [
      ['type',   `always_${ab.kind.toLowerCase()}`],
      ['drives', ab.driven_signals.join(', ')],
    ]
    return { kind, rows }
  }

  // always_ff グループ: group.${i}.${sig}
  const key  = groupId.slice('group.'.length)
  const dotI = key.indexOf('.')
  const i    = parseInt(key.slice(0, dotI))
  const sig  = key.slice(dotI + 1)
  const mod  = currentTree?.modules[currentModuleIdx]
  const ab   = mod?.always_blocks[i]
  if (!ab) return { kind: 'FF Group', rows: [['id', groupId]] }

  const rows = [['signal', sig], ['type', 'FF Group (NEXT + DFF)']]
  if (ab.clock) {
    rows.push(['CLK', `${ab.clock.edge === 'Posedge' ? '↑' : '↓'} ${ab.clock.signal_name}`])
  }
  if (ab.reset) {
    rows.push(['RST', `${ab.reset.signal_name} (active-${ab.reset.active_low ? 'low' : 'high'})`])
  }
  if (ab.driven_signals?.length > 1) {
    rows.push(['block drives', ab.driven_signals.join(', ')])
  }
  return { kind: 'FF Group', rows }
}

/** ノード ID からプロパティ行を返す */
function getNodeProps(nodeId) {
  const mod = currentTree?.modules[currentModuleIdx]

  // ─ 外部ポート ─────────────────────────────────────────────────
  if (nodeId.startsWith('ext.')) {
    const portName = nodeId.slice(4)
    const port = mod?.ports.find(p => p.name === portName)
    if (!port) return { kind: 'Port', rows: [['id', nodeId]] }
    return {
      kind: `Port (${port.direction})`,
      rows: [
        ['name',      port.name],
        ['direction', port.direction],
        ['type',      port.data_type],
      ],
    }
  }

  // ─ モジュールインスタンス ──────────────────────────────────────
  if (nodeId.startsWith('inst.')) {
    const instName = nodeId.slice(5)
    const inst = mod?.instances.find(i => i.instance_name === instName)
    if (!inst) return { kind: 'Instance', rows: [['id', nodeId]] }
    const rows = [
      ['instance', inst.instance_name],
      ['module',   inst.module_name],
    ]
    for (const p of inst.param_overrides) {
      rows.push([`#${p.param_name}`, p.value])
    }
    for (const c of inst.port_connections) {
      rows.push([`.${c.port_name}`, c.signal || '(unconnected)'])
    }
    return { kind: 'Instance', rows }
  }

  // ─ FF 次状態ロジックノード ────────────────────────────────────
  if (nodeId.startsWith('ff_comb.')) {
    // ff_comb.{i}
    const idx = parseInt(nodeId.split('.')[1])
    const ab  = mod?.always_blocks[idx]
    if (!ab) return { kind: 'FF Next', rows: [['id', nodeId]] }
    const rows = [['kind', 'Next-state logic (combinational)']]
    if (ab.driven_signals.length > 0) rows.push(['drives',  ab.driven_signals.join(', ')])
    if (ab.read_signals?.length > 0)  rows.push(['reads',   ab.read_signals.join(', ')])
    return { kind: 'FF Next', rows }
  }

  // ─ FF レジスタノード ──────────────────────────────────────────
  if (nodeId.startsWith('ff_reg.')) {
    // ff_reg.{i}.{sig}
    const parts = nodeId.split('.')
    const idx   = parseInt(parts[1])
    const sig   = parts.slice(2).join('.')
    const ab    = mod?.always_blocks[idx]
    if (!ab) return { kind: 'DFF', rows: [['id', nodeId]] }
    const rows = [['signal', sig], ['type', 'D flip-flop']]
    if (ab.clock) {
      rows.push(['CLK', `${ab.clock.edge === 'Posedge' ? '↑' : '↓'} ${ab.clock.signal_name}`])
    }
    if (ab.reset) {
      rows.push(['RST', `${ab.reset.signal_name} (active-${ab.reset.active_low ? 'low' : 'high'})`])
    }
    return { kind: 'DFF', rows }
  }

  // ─ always ブロック (comb/latch) ───────────────────────────────
  if (nodeId.startsWith('always.')) {
    const idx = parseInt(nodeId.slice(7))
    const ab  = mod?.always_blocks[idx]
    if (!ab) return { kind: 'Always', rows: [['id', nodeId]] }
    const rows = [['kind', ab.kind]]
    if (ab.driven_signals.length > 0) rows.push(['drives', ab.driven_signals.join(', ')])
    if (ab.read_signals?.length > 0)  rows.push(['reads',  ab.read_signals.join(', ')])
    return { kind: `Always ${ab.kind}`, rows }
  }

  // ─ assign / MUX ──────────────────────────────────────────────
  if (nodeId.startsWith('assign.')) {
    const parts    = nodeId.split('.')
    const assignIdx = parseInt(parts[1])
    const assign   = mod?.assigns[assignIdx]
    if (parts.length >= 3 && parts[2].startsWith('m')) {
      // MUX ノード
      return {
        kind: 'MUX',
        rows: assign
          ? [['assign', `${assign.lhs} = ${assign.rhs}`], ['mux', parts[2]]]
          : [['id', nodeId]],
      }
    }
    if (!assign) return { kind: 'Assign', rows: [['id', nodeId]] }
    return {
      kind: 'Assign',
      rows: [
        ['lhs', assign.lhs],
        ['rhs', assign.rhs],
      ],
    }
  }

  // ─ 定数ノード ────────────────────────────────────────────────
  if (nodeId.startsWith('const.')) {
    const node = currentLayout?.children?.find(c => c.id === nodeId)
    return {
      kind: 'Constant',
      rows: [['value', node?.labels?.[0]?.text ?? nodeId.slice(6)]],
    }
  }

  return { kind: 'Node', rows: [['id', nodeId]] }
}

/** エッジ ID からプロパティ行を返す */
function getEdgeProps(edgeId) {
  const edge = currentLayout?.edges?.find(e => e.id === edgeId)
  if (!edge) return { kind: 'Edge', rows: [['id', edgeId]] }
  const rows = []
  if (edge.sources?.length)  rows.push(['from', edge.sources.join(', ')])
  if (edge.targets?.length)  rows.push(['to',   edge.targets.join(', ')])
  return { kind: 'Edge', rows }
}

function updateBackBtn() {
  if (navStack.length === 0) {
    backBtn.disabled    = true
    backBtn.textContent = '↑ 上位階層'
  } else {
    backBtn.disabled    = false
    const parent        = navStack[navStack.length - 1]
    backBtn.textContent = `↑ ${parent.moduleName}`
  }
}

/**
 * エディタを指定モジュールの宣言行にスクロールする。
 * CodeMirror 6 の EditorView.scrollIntoView effect を使用。
 * @param {string} moduleName
 */
function scrollEditorToModule(moduleName) {
  if (!moduleName) return
  const text = editor.state.doc.toString()
  // "module <name>" を行頭近くで探す（空白・コメント後を考慮）
  const re  = new RegExp(`(?:^|\\n)[^\\n]*\\bmodule\\s+${moduleName}\\b`)
  const m   = re.exec(text)
  if (!m) return
  // マッチ文字列の中の "module" キーワードの絶対オフセット
  const pos = m.index + m[0].indexOf('module')
  editor.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
  })
}

// ─── ノード・エッジ選択 ───────────────────────────────────────
let selectedNodeId = null
let selectedEdgeId = null

/** ポート ID 一覧から接続エッジをすべてハイライトする */
function highlightEdgesForPorts(portIds) {
  if (!currentLayout || portIds.length === 0) return
  const portMap = buildPortEdgeMap(currentLayout)
  for (const pid of portIds) {
    for (const eid of portMap.get(pid) ?? []) {
      diagramWrap.querySelector(`.edge[data-id="${eid}"]`)?.classList.add('selected')
    }
  }
}

function selectNode(nodeId) {
  // 前の選択をすべて解除
  diagramWrap.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'))
  diagramWrap.querySelectorAll('.edge.selected').forEach(e => e.classList.remove('selected'))
  diagramWrap.querySelectorAll('.group-bg-item.selected').forEach(g => g.classList.remove('selected'))
  selectedNodeId = nodeId ?? null
  selectedEdgeId = null

  if (!selectedNodeId) {
    renderProps('Properties', '', [])
    waveViewer?.highlightSignal(null)
    return
  }

  // ── グループノード選択: 内部ノードをすべて選択した場合と同じ動作 ──
  if (selectedNodeId.startsWith('group.') || selectedNodeId.startsWith('group_comb.')) {
    // グループ背景をハイライト
    diagramWrap.querySelector(`.group-bg-item[data-id="${selectedNodeId}"]`)?.classList.add('selected')

    // 内部子ノードを特定してハイライト
    let childIds = []
    if (selectedNodeId.startsWith('group_comb.')) {
      // always_comb/latch: group_comb.${i} → always.${i}.* の全ノード
      const i      = selectedNodeId.slice('group_comb.'.length)
      const prefix = `always.${i}.`
      childIds = (currentLayout?.children ?? [])
        .filter(c => c.id.startsWith(prefix))
        .map(c => c.id)
    } else {
      // always_ff: group.${i}.${sig} → ff_comb.${key} + ff_reg.${key}
      const key = selectedNodeId.slice('group.'.length)
      childIds  = [`ff_comb.${key}`, `ff_reg.${key}`]
    }

    for (const cid of childIds) {
      diagramWrap.querySelector(`.node[data-id="${cid}"]`)?.classList.add('selected')
    }

    // 全子ノードの全ポートに繋がるエッジをハイライト
    const nodes   = currentLayout?.children ?? []
    const portIds = childIds.flatMap(cid =>
      nodes.find(c => c.id === cid)?.ports?.map(p => p.id) ?? []
    )
    highlightEdgesForPorts(portIds)

    const { kind, rows } = getGroupProps(selectedNodeId)
    renderProps(kind, selectedNodeId, rows)
    return
  }

  // ── 通常ノード選択 ───────────────────────────────────────────────
  diagramWrap.querySelector(`.node[data-id="${selectedNodeId}"]`)?.classList.add('selected')

  const { kind, rows } = getNodeProps(selectedNodeId)
  renderProps(kind, selectedNodeId, rows)

  let portIds = []
  if (selectedNodeId.startsWith('ext.')) {
    portIds = [`${selectedNodeId}.p`]
  } else if (selectedNodeId.startsWith('const.')) {
    portIds = [`${selectedNodeId}.out`]
  } else if (selectedNodeId.startsWith('ff_comb.') || selectedNodeId.startsWith('ff_reg.')) {
    portIds = (currentLayout?.children ?? [])
      .find(c => c.id === selectedNodeId)
      ?.ports?.map(p => p.id) ?? []
  }
  highlightEdgesForPorts(portIds)
}

function selectEdge(edgeId) {
  diagramWrap.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'))
  diagramWrap.querySelectorAll('.edge.selected').forEach(e => e.classList.remove('selected'))
  diagramWrap.querySelectorAll('.group-bg-item.selected').forEach(g => g.classList.remove('selected'))
  selectedNodeId = null
  selectedEdgeId = edgeId ?? null

  if (selectedEdgeId) {
    // 選択エッジのソースポートを共有する全エッジをハイライト（分岐ワイヤー対応）
    const portMap = buildPortEdgeMap(currentLayout)
    const edge    = currentLayout?.edges?.find(e => e.id === selectedEdgeId)

    const relatedIds = new Set([selectedEdgeId])
    if (edge) {
      for (const srcPid of edge.sources ?? []) {
        for (const eid of portMap.get(srcPid) ?? []) {
          relatedIds.add(eid)
        }
      }
    }
    for (const eid of relatedIds) {
      diagramWrap.querySelector(`.edge[data-id="${eid}"]`)?.classList.add('selected')
    }

    const { kind, rows } = getEdgeProps(selectedEdgeId)
    renderProps(kind, selectedEdgeId, rows)

    // 対応する波形行をハイライト
    waveViewer?.highlightSignal(edge?._signal ?? null)
  } else {
    renderProps('Properties', '', [])
    waveViewer?.highlightSignal(null)
  }
}

// ─── パン（ドラッグ移動）─────────────────────────────────────
const PAN_PAD  = 24    // renderer.js の STYLE.padding と同値
let panOffset  = { x: 0, y: 0 }
let zoom       = 1.0
let isPanning  = false
let panStart   = { x: 0, y: 0 }
/** mousedown から mousemove が 4px 超えたら true → click イベントを無視する */
let panMoved   = false

const ZOOM_MIN    = 0.1
const ZOOM_MAX    = 8.0
const ZOOM_FACTOR = 1.12   // ホイール1ノッチあたりの倍率

function applyTransform() {
  const g = diagramWrap.querySelector('.sv-content')
  if (!g) return
  const tx = PAN_PAD + panOffset.x
  const ty = PAN_PAD + panOffset.y
  g.setAttribute('transform', `translate(${tx},${ty}) scale(${zoom})`)
}

diagramWrap.addEventListener('mousedown', e => {
  if (e.button !== 0) return
  isPanning = true
  panMoved  = false
  panStart  = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y }
  diagramWrap.classList.add('panning')
  e.preventDefault()
})

window.addEventListener('mousemove', e => {
  if (!isPanning) return
  const dx = e.clientX - (panStart.x + panOffset.x)
  const dy = e.clientY - (panStart.y + panOffset.y)
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) panMoved = true
  panOffset = { x: e.clientX - panStart.x, y: e.clientY - panStart.y }
  applyTransform()
})

window.addEventListener('mouseup', () => {
  if (!isPanning) return
  isPanning = false
  diagramWrap.classList.remove('panning')
  // panMoved はここではリセットしない → 直後の click イベントで参照するため
})

// ─── ホイール: ズーム（カーソル位置を中心に拡縮）────────────────
diagramWrap.addEventListener('wheel', e => {
  e.preventDefault()
  const rect    = diagramWrap.getBoundingClientRect()
  const mx      = e.clientX - rect.left   // ダイアグラム内のマウス座標
  const my      = e.clientY - rect.top

  const delta   = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * delta))
  const ratio   = newZoom / zoom

  // カーソル位置が変わらないよう平行移動を補正する
  // 変換: translate(PAN_PAD + panOffset.x, ...) scale(zoom)
  // カーソル下のコンテンツ座標: cx = (mx - PAN_PAD - panOffset.x) / zoom
  // ズーム後に同じ位置になるには:
  //   PAN_PAD + newPanX + cx * newZoom = mx
  //   newPanX = (mx - PAN_PAD)(1 - ratio) + panOffset.x * ratio
  panOffset = {
    x: (mx - PAN_PAD) * (1 - ratio) + panOffset.x * ratio,
    y: (my - PAN_PAD) * (1 - ratio) + panOffset.y * ratio,
  }
  zoom = newZoom
  applyTransform()
}, { passive: false })

// ─── クリック: ノード・エッジ選択 ────────────────────────────
diagramWrap.addEventListener('click', e => {
  if (panMoved) { panMoved = false; return }  // ドラッグ後のクリックは無視
  const nodeEl  = e.target.closest('.node')
  const edgeEl  = e.target.closest('.edge')
  const groupEl = e.target.closest('.group-bg-item')
  if (nodeEl) {
    // 通常ノード（グループ内ノードを含む）が優先
    selectEdge(null)
    selectNode(nodeEl.dataset.id)
  } else if (edgeEl) {
    selectNode(null)
    selectEdge(edgeEl.dataset.id)
  } else if (groupEl) {
    // グループ背景のパディング領域をクリック
    selectEdge(null)
    selectNode(groupEl.dataset.id)
  } else {
    selectNode(null)
    selectEdge(null)
  }
})

// ─── ダブルクリック: インスタンスにドリルダウン ───────────────
diagramWrap.addEventListener('dblclick', async e => {
  if (!currentTree) return
  const nodeEl = e.target.closest('.node')
  if (!nodeEl) return
  const nodeId = nodeEl.dataset.id
  if (!nodeId?.startsWith('inst.')) return

  // インスタンス名 → モジュール名を解決
  const instanceName = nodeId.slice(5)   // 'inst.' を除く
  const curModule    = currentTree.modules[currentModuleIdx]
  const instance     = curModule?.instances.find(i => i.instance_name === instanceName)
  if (!instance) return

  // tree 内に対応モジュールがあるか確認（なければブラックボックス）
  const targetIdx = currentTree.modules.findIndex(m => m.name === instance.module_name)
  if (targetIdx < 0) {
    setStatus(`"${instance.module_name}" はこのファイル内に定義がありません`, 'error')
    return
  }

  // 現在位置をスタックに積んでドリルダウン
  // instanceName も保存して VCD スコープパスの復元に使う
  navStack.push({ moduleIdx: currentModuleIdx, moduleName: curModule.name, instanceName })
  updateBackBtn()
  moduleSelect.value = String(targetIdx)
  await renderModule(targetIdx)
  scrollEditorToModule(instance.module_name)
})

// ─── 戻るボタン: 上位階層へ ───────────────────────────────────
backBtn.addEventListener('click', async () => {
  if (navStack.length === 0) return
  const { moduleIdx } = navStack.pop()
  updateBackBtn()
  moduleSelect.value = String(moduleIdx)
  await renderModule(moduleIdx)
  scrollEditorToModule(currentTree.modules[moduleIdx].name)
})

// ─── WASM 初期化 ─────────────────────────────────────────────
function initWasm() {
  try {
    if (typeof lower_sv !== 'function') throw new Error('lower_sv not found')
    setStatus('準備完了', 'ok')
    renderBtn.disabled = false
  } catch (e) {
    setStatus(`WASM 初期化失敗: ${e.message}`, 'error')
    console.error(e)
  }
}

// ─── コンパウンドノード平坦化 ────────────────────────────────────

/**
 * ELK レイアウト結果のコンパウンドノード（children を持つノード）を平坦化する。
 * - 子ノードの x/y を絶対座標に変換
 * - コンパウンド内部エッジのセクション座標を絶対化して root edges に昇格
 * - コンパウンドノード自体に _isGroup フラグを付与（背景描画用）
 * @param {object} layout - elk.layout() の戻り値
 * @returns {object}       平坦化済みレイアウト
 */
function flattenLayout(layout) {
  const flatNodes = []
  const flatEdges = [...(layout.edges ?? [])]

  function flatten(container, ox, oy) {
    for (const node of container.children ?? []) {
      const ax = (node.x ?? 0) + ox
      const ay = (node.y ?? 0) + oy

      if (node.children?.length > 0) {
        // コンパウンドノード → 背景グループとして追加
        flatNodes.push({
          ...node,
          x: ax, y: ay,
          children: undefined,
          edges:    undefined,
          _isGroup: true,
        })
        // 子ノードを再帰展開
        flatten(node, ax, ay)
        // 内部エッジをルート絶対座標に変換して追加
        for (const edge of node.edges ?? []) {
          flatEdges.push(offsetEdgeSections(edge, ax, ay))
        }
      } else {
        flatNodes.push({ ...node, x: ax, y: ay })
      }
    }
  }

  flatten(layout, 0, 0)
  return { ...layout, children: flatNodes, edges: flatEdges }
}

/** エッジセクションの全座標を (dx, dy) だけオフセットする */
function offsetEdgeSections(edge, dx, dy) {
  return {
    ...edge,
    sections: (edge.sections ?? []).map(sec => ({
      ...sec,
      startPoint: { x: sec.startPoint.x + dx, y: sec.startPoint.y + dy },
      endPoint:   { x: sec.endPoint.x   + dx, y: sec.endPoint.y   + dy },
      bendPoints: (sec.bendPoints ?? []).map(bp => ({ x: bp.x + dx, y: bp.y + dy })),
    })),
  }
}

// ─── モジュール単体レンダリング ─────────────────────────────────
/** currentTree の moduleIdx 番目のモジュールをレイアウト→SVG描画する */
async function renderModule(moduleIdx) {
  currentModuleIdx = moduleIdx
  panOffset        = { x: 0, y: 0 }
  zoom             = 1.0
  selectedNodeId   = null
  selectedEdgeId   = null

  try {
    const elkGraph  = buildElkGraph(currentTree, moduleIdx)
    const rawLayout = await elk.layout(elkGraph)
    const layout    = flattenLayout(rawLayout)  // コンパウンドを平坦化
    currentLayout  = layout                     // ポート→エッジ逆引き用に保持
    const svg      = renderToSvg(layout)
    diagramWrap.innerHTML = ''
    diagramWrap.appendChild(svg)

    const m         = currentTree.modules[moduleIdx]
    const nodeCount = m.instances.length + m.always_blocks.length
    setStatus(`OK — ${currentTree.modules.length} module(s), ${nodeCount} block(s)`, 'ok')

    // モジュール切り替え後に波形ビューワも更新
    refreshWaveformViewer()
  } catch (e) {
    setStatus(`エラー: ${e.message}`, 'error')
    console.error(e)
  }
}

// ─── 全体レンダリング（SVパース込み）────────────────────────────
async function render() {
  renderBtn.disabled = true
  setStatus('解析・レイアウト中...')
  navStack  = []
  panOffset = { x: 0, y: 0 }
  zoom      = 1.0
  updateBackBtn()

  try {
    const json  = lower_sv(editor.state.doc.toString())
    currentTree = JSON.parse(json)

    updateModuleSelect(currentTree.modules)
    const moduleIdx = parseInt(moduleSelect.value ?? '0', 10)
    await renderModule(moduleIdx)
  } catch (e) {
    setStatus(`エラー: ${e.message}`, 'error')
    console.error(e)
  } finally {
    renderBtn.disabled = false
  }
}

// ─── モジュール選択プルダウン更新 ────────────────────────────
function updateModuleSelect(modules) {
  const prev = moduleSelect.value
  moduleSelect.innerHTML = modules
    .map((m, i) => `<option value="${i}">${m.name}</option>`)
    .join('')
  if ([...moduleSelect.options].some(o => o.value === prev)) {
    moduleSelect.value = prev
  }
}

// ─── ユーティリティ ───────────────────────────────────────────
function setStatus(msg, cls = '') {
  statusEl.textContent = msg
  statusEl.className   = cls
}

// ─── イベント ─────────────────────────────────────────────────
renderBtn.addEventListener('click', render)

moduleSelect.addEventListener('change', async () => {
  if (!currentTree) return
  // 手動でモジュールを切り替えたときはナビ履歴をリセット
  navStack = []
  updateBackBtn()
  const idx = parseInt(moduleSelect.value, 10)
  await renderModule(idx)
  scrollEditorToModule(currentTree.modules[idx].name)
})

// ─── VCD 読み込み ─────────────────────────────────────────────────
/** 警告なしで読み込むファイルサイズの上限 (5 MB) */
const VCD_WARN_BYTES = 5 * 1024 * 1024

/** 現在読み込まれている VcdData (null = 未読み込み) */
let currentVcd = null

const vcdFileInput  = document.getElementById('vcd-file-input')
const vcdInfoEl     = document.getElementById('vcd-info')
const vcdWarnBanner = document.getElementById('vcd-warn-banner')
const vcdWarnText   = document.getElementById('vcd-warn-text')
const vcdWarnOk     = document.getElementById('vcd-warn-ok')
const vcdWarnCancel = document.getElementById('vcd-warn-cancel')

/** VCD ステータス表示を更新する */
function setVcdInfo(msg, cls = '') {
  vcdInfoEl.textContent = msg
  vcdInfoEl.className   = cls
}

/** 警告バナーを隠す */
function hideVcdWarn() {
  vcdWarnBanner.classList.remove('visible')
  vcdWarnText.textContent = ''
}

/** VCD テキストを WASM でパースして currentVcd に格納する */
async function loadVcdText(text, fileName) {
  setVcdInfo('解析中...', '')
  try {
    const json = parse_vcd(text)
    currentVcd = JSON.parse(json)

    const sigCount = currentVcd.signals.length
    // タイムスケール (fs 単位) × max_time → ns に変換して表示
    const ns = (currentVcd.max_time * currentVcd.timescale_fs / 1_000_000).toFixed(1)
    setVcdInfo(`${fileName} — ${sigCount} 信号, 最大 ${ns} ns`, 'ok')

    // VCD 読み込み完了 → 波形ビューワを自動表示
    showWaveformViewer()
  } catch (e) {
    currentVcd = null
    setVcdInfo(`エラー: ${e.message ?? e}`, 'error')
    console.error('VCD parse error', e)
  }
}

// ─── DEV モード: sim/counter.vcd をワンクリックで読み込むボタンを追加 ──
if (import.meta.env.DEV) {
  // デバッグコンソールから波形抽出を呼べるよう公開
  window._extractWaveforms = extractWaveformsForCurrentModule

  const debugBtn = document.createElement('button')
  debugBtn.id          = 'vcd-debug-btn'
  debugBtn.textContent = '🔧 counter.vcd'
  debugBtn.title       = 'sim/counter.vcd をデバッグ用に読み込む (dev only)'
  document.getElementById('vcd-controls').appendChild(debugBtn)

  debugBtn.addEventListener('click', async () => {
    debugBtn.disabled = true
    setVcdInfo('読み込み中...', '')
    try {
      const res = await fetch('/debug-sim/counter.vcd')
      if (!res.ok) throw new Error(`HTTP ${res.status} — sim/counter.vcd が見つかりません。\nbash sim/run_sim.sh を実行してください。`)
      const text = await res.text()
      await loadVcdText(text, 'counter.vcd (debug)')
    } catch (e) {
      setVcdInfo(`エラー: ${e.message}`, 'error')
    } finally {
      debugBtn.disabled = false
    }
  })
}

/** ファイル選択時のハンドラ */
vcdFileInput.addEventListener('change', async () => {
  const file = vcdFileInput.files[0]
  if (!file) return
  hideVcdWarn()

  if (file.size > VCD_WARN_BYTES) {
    // 大きいファイル → バナーで確認を求める
    const mb = (file.size / 1024 / 1024).toFixed(1)
    vcdWarnText.textContent =
      `⚠️ ファイルサイズが ${mb} MB あります。読み込みに時間がかかる場合があります。`
    vcdWarnBanner.classList.add('visible')

    // 確認ボタン
    const onOk = async () => {
      cleanup()
      hideVcdWarn()
      const text = await file.text()
      await loadVcdText(text, file.name)
    }
    const onCancel = () => {
      cleanup()
      hideVcdWarn()
      vcdFileInput.value = ''   // 選択をリセット
      setVcdInfo('ファイルが選択されていません', '')
    }
    const cleanup = () => {
      vcdWarnOk.removeEventListener('click', onOk)
      vcdWarnCancel.removeEventListener('click', onCancel)
    }
    vcdWarnOk.addEventListener('click', onOk)
    vcdWarnCancel.addEventListener('click', onCancel)
  } else {
    // 小さいファイル → 即読み込み
    const text = await file.text()
    await loadVcdText(text, file.name)
  }
})

// ─── VCD ↔ ダイアグラム 階層マッチング ───────────────────────────
/**
 * 現在表示中のモジュールに対応する VCD スコープパスを返す。
 *
 * navStack の各エントリに保存された instanceName を辿ることで、
 * 階層ドリルダウンに対応したスコープを組み立てる。
 *
 * 例:
 *   counter_tb を表示中 (navStack=[])
 *     → "counter_tb"
 *   counter_tb.u_counter にドリルダウン中
 *   (navStack=[{moduleName:'counter_tb', instanceName:'u_counter'}])
 *     → "counter_tb.u_counter"
 */
function buildVcdScope() {
  if (!currentTree) return null
  const mod = currentTree.modules[currentModuleIdx]
  if (navStack.length === 0) return mod.name

  // ルートのモジュール名 + 各ドリルダウン時のインスタンス名を連結
  let scope = navStack[0].moduleName
  for (const entry of navStack) {
    if (entry.instanceName) scope += '.' + entry.instanceName
  }
  return scope
}

/**
 * 現在表示中のモジュール階層に対応する波形データを VCD から抽出する。
 *
 * @returns {{ scope: string, signals: WaveSignal[] } | null}
 *
 * WaveSignal = {
 *   name:    string,          // 信号名
 *   id:      string,          // VCD ID コード
 *   width:   number,          // ビット幅
 *   changes: [number, string][] // (time_fs, value) 昇順
 * }
 */
export function extractWaveformsForCurrentModule() {
  if (!currentVcd || !currentTree) return null

  const mod   = currentTree.modules[currentModuleIdx]
  const scope = buildVcdScope()

  // 現在モジュールの信号名セット（ポート + ローカル信号）
  const sigNames = new Set([
    ...mod.ports.map(p => p.name),
    ...mod.signals.map(s => s.name),
  ])

  // ① スコープが完全一致する信号を優先
  let matched = currentVcd.signals.filter(s =>
    s.scope === scope && sigNames.has(s.name)
  )

  // ② スコープ一致なし → 名前一致のみでフォールバック（テストベンチ等）
  if (matched.length === 0) {
    matched = currentVcd.signals.filter(s => sigNames.has(s.name))
  }

  const result = matched.map(s => ({
    name:    s.name,
    id:      s.id,
    width:   s.width,
    changes: currentVcd.value_changes[s.id] ?? [],
  }))

  return { scope, signals: result }
}

// ─── 波形ビューワ ─────────────────────────────────────────────────────────────

const waveformPane      = document.getElementById('waveform-pane')
const waveformContainer = document.getElementById('waveform-container')
const waveformCloseBtn  = document.getElementById('waveform-close-btn')

/** 現在の createWaveformViewer コントローラ (null = 未作成) */
let waveViewer = null

/**
 * 波形ビューワを開いて現在の階層の波形を表示する。
 * VCD が未読み込みの場合は何もしない。
 */
function showWaveformViewer() {
  if (!currentVcd || !currentTree) return

  const waveData = extractWaveformsForCurrentModule()
  if (!waveData || waveData.signals.length === 0) return

  const viewerData = {
    ...waveData,
    timescale_fs: currentVcd.timescale_fs,
    max_time:     currentVcd.max_time,
  }

  waveformPane.classList.add('visible')

  // requestAnimationFrame で1フレーム待ち、ブラウザがレイアウトを確定させてから
  // clientWidth を取得する（初回表示時に 0 になるのを防ぐ）
  requestAnimationFrame(() => {
    if (!waveViewer) {
      waveViewer = createWaveformViewer(waveformContainer, viewerData)
      // カーソル移動 → エッジ値オーバーレイ更新
      waveViewer.onCursorMove(updateEdgeValueOverlays)
      // 信号名クリック → 対応エッジをハイライト
      waveViewer.onSignalClick(sigName => {
        highlightEdgesBySignal(sigName)
        waveViewer.highlightSignal(sigName)
      })
    } else {
      waveViewer.update(viewerData)
    }
    buildEdgeValueOverlays()
  })
}

/** 波形ビューワのデータを更新する（表示中の場合のみ）*/
function refreshWaveformViewer() {
  if (!waveformPane.classList.contains('visible')) return
  showWaveformViewer()
}

waveformCloseBtn.addEventListener('click', () => {
  waveformPane.classList.remove('visible')
  edgeOverlayGroup?.remove()
  edgeOverlayGroup = null
})

// ─── 波形→ダイアグラム ハイライト ────────────────────────────────────────────

/**
 * 指定した信号名に対応するエッジをダイアグラム上でハイライトする。
 * waveformの信号名クリック時に呼ばれる。
 */
function highlightEdgesBySignal(sigName) {
  // 既存の選択を解除
  diagramWrap.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'))
  diagramWrap.querySelectorAll('.edge.selected').forEach(e => e.classList.remove('selected'))
  diagramWrap.querySelectorAll('.group-bg-item.selected').forEach(g => g.classList.remove('selected'))
  selectedNodeId = null
  selectedEdgeId = null
  renderProps('Properties', '', [])

  if (!currentLayout || !sigName) return

  // _signal が一致するエッジをすべてハイライト
  for (const edge of currentLayout.edges ?? []) {
    if (edge._signal === sigName) {
      diagramWrap.querySelector(`.edge[data-id="${edge.id}"]`)?.classList.add('selected')
    }
  }
}

// ─── エッジ値オーバーレイ ─────────────────────────────────────────────────────

let edgeOverlayGroup = null

/** ELKエッジのセクション群から視覚的な中点を返す */
function edgeMidpoint(edge) {
  const allPts = []
  for (const sec of edge.sections ?? []) {
    allPts.push(sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint)
  }
  // 連続する重複点を除去
  const pts = allPts.filter(
    (p, i) => i === 0 || p.x !== allPts[i - 1].x || p.y !== allPts[i - 1].y
  )
  if (pts.length === 0) return null
  return pts[Math.floor((pts.length - 1) / 2)]
}

/** sigName の timeFs 時点の値を文字列で返す（VCD未読み込みなら ''）*/
function signalValueAtCursor(sigName, timeFs) {
  if (!currentVcd) return ''
  const waveData = extractWaveformsForCurrentModule()
  const sig = waveData?.signals.find(s => s.name === sigName)
  if (!sig) return ''
  const cVcd = timeFs / currentVcd.timescale_fs
  let val = null
  for (const [t, v] of sig.changes) {
    if (t <= cVcd) val = v
    else break
  }
  if (val === null) return ''
  if (sig.width === 1) return val
  if (/[xz]/i.test(val)) return 'x'
  const n = parseInt(val, 2)
  return isNaN(n) ? val : '0x' + n.toString(16).toUpperCase()
}

/** ダイアグラムの .sv-content 上に値オーバーレイグループを生成する */
function buildEdgeValueOverlays() {
  edgeOverlayGroup?.remove()
  edgeOverlayGroup = null
  if (!currentLayout || !currentVcd) return
  const content = diagramWrap.querySelector('.sv-content')
  if (!content) return

  const NS = 'http://www.w3.org/2000/svg'
  edgeOverlayGroup = document.createElementNS(NS, 'g')
  edgeOverlayGroup.setAttribute('class', 'edge-val-overlays')
  edgeOverlayGroup.setAttribute('pointer-events', 'none')
  content.appendChild(edgeOverlayGroup)

  for (const edge of currentLayout.edges ?? []) {
    if (!edge._signal) continue
    const mid = edgeMidpoint(edge)
    if (!mid) continue

    const g = document.createElementNS(NS, 'g')
    g.dataset.signal = edge._signal
    g.setAttribute('transform', `translate(${mid.x.toFixed(1)},${mid.y.toFixed(1)})`)

    const bg = document.createElementNS(NS, 'rect')
    bg.setAttribute('class', 'edge-val-bg')
    bg.setAttribute('rx', '3')

    const text = document.createElementNS(NS, 'text')
    text.setAttribute('class', 'edge-val-text')
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'middle')
    text.setAttribute('y', '-12')

    g.appendChild(bg)
    g.appendChild(text)
    edgeOverlayGroup.appendChild(g)
  }

  updateEdgeValueOverlays(waveViewer?.getCursor() ?? 0)
}

/** カーソル移動のたびに各エッジの値テキストを更新する */
function updateEdgeValueOverlays(timeFs = 0) {
  if (!edgeOverlayGroup) return
  for (const g of edgeOverlayGroup.querySelectorAll('g[data-signal]')) {
    const val    = signalValueAtCursor(g.dataset.signal, timeFs)
    const textEl = g.querySelector('.edge-val-text')
    const bgEl   = g.querySelector('.edge-val-bg')
    if (!textEl) continue
    textEl.textContent = val
    const W = Math.max(16, val.length * 7 + 8)
    bgEl?.setAttribute('x', (-W / 2).toFixed(1))
    bgEl?.setAttribute('y', '-20')
    bgEl?.setAttribute('width', String(W))
    bgEl?.setAttribute('height', '15')
    g.setAttribute('visibility', val ? 'visible' : 'hidden')
  }
}

// VCD コントロールに「波形表示」ボタンを追加
const showWaveBtn = document.createElement('button')
showWaveBtn.id          = 'show-wave-btn'
showWaveBtn.textContent = '📊 波形'
showWaveBtn.title       = '波形ビューワを表示'
showWaveBtn.style.cssText = `
  background: #555; color: #fff; border: none; border-radius: 5px;
  padding: 4px 10px; font-size: 11px; cursor: pointer; white-space: nowrap; flex-shrink: 0;
`
showWaveBtn.addEventListener('click', showWaveformViewer)
document.getElementById('vcd-controls').appendChild(showWaveBtn)

// ─── 起動 ─────────────────────────────────────────────────────────────────────
updateBackBtn()
initWasm()
