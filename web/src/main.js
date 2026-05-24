import ELK from 'elkjs/lib/elk.bundled.js'
import { lower_sv } from '../wasm/sv_wasm.js'
import { buildElkGraph } from './elk-builder.js'
import { renderToSvg }   from './renderer.js'

// ─── デフォルトの SV ソース ──────────────────────────────────────
const DEFAULT_SV = `\
// ================================================================
// assign サンプル集
//
// mux2       : 単純な assign / 三項演算子
// priority4  : ネスト三項演算子（優先エンコーダ）
// ================================================================

// ─── 2入力マルチプレクサ ─────────────────────────────────────
module mux2 #(
  parameter int unsigned WIDTH = 8
)(
  input  var logic             sel,
  input  var logic [WIDTH-1:0] a,
  input  var logic [WIDTH-1:0] b,
  output var logic [WIDTH-1:0] y,
  output var logic [WIDTH-1:0] y_and,
  output var logic [WIDTH-1:0] y_or
);
  // 三項演算子による選択
  assign y     = sel ? a : b;
  // ビット演算
  assign y_and = a & b;
  assign y_or  = a | b;
endmodule

// ─── 4入力優先エンコーダ ──────────────────────────────────────
module priority4 (
  input  var logic [3:0] req,
  output var logic [1:0] grant,
  output var logic       valid
);
  // ネストした三項演算子
  assign grant = req[3] ? 2'd3 :
                 req[2] ? 2'd2 :
                 req[1] ? 2'd1 :
                          2'd0;
  // リダクション演算子
  assign valid = |req;
endmodule

// ================================================================
// 3ステージ パイプライン サンプル
//
// 階層:
//   pipeline_top
//     u_ctrl   : pipe_ctrl   (パイプライン制御)
//     u_stage1 : pipe_stage  (第1ステージ)
//     u_stage2 : pipe_stage  (第2ステージ)
//     u_stage3 : pipe_stage  (第3ステージ)
// ================================================================

// ─── パイプラインステージ（1段分）──────────────────────────────
module pipe_stage #(
  parameter int unsigned WIDTH = 8
)(
  input  var logic             clk,
  input  var logic             rst_n,
  input  var logic [WIDTH-1:0] din,
  input  var logic             valid_in,
  output var logic [WIDTH-1:0] dout,
  output var logic             valid_out
);
  logic [WIDTH-1:0] processed;
  logic [WIDTH-1:0] data_reg;
  logic             valid_reg;

  always_comb begin
    processed = din + 1;
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      data_reg  <= '0;
      valid_reg <= 1'b0;
    end else begin
      data_reg  <= processed;
      valid_reg <= valid_in;
    end
  end

  assign dout      = data_reg;
  assign valid_out = valid_reg;
endmodule

// ─── パイプラインコントローラ ────────────────────────────────
module pipe_ctrl (
  input  var logic clk,
  input  var logic rst_n,
  input  var logic start,
  input  var logic last_valid,
  output var logic valid_out,
  output var logic busy
);
  logic valid_r;
  logic busy_r;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      valid_r <= 1'b0;
      busy_r  <= 1'b0;
    end else begin
      valid_r <= start;
      busy_r  <= start & ~last_valid;
    end
  end

  assign valid_out = valid_r;
  assign busy      = busy_r;
endmodule

// ─── トップ: 3ステージパイプライン ──────────────────────────
module pipeline_top #(
  parameter int unsigned DATA_W  = 8,
  parameter int unsigned N_STAGE = 3
)(
  input  var logic              clk,
  input  var logic              rst_n,
  input  var logic [DATA_W-1:0] data_in,
  input  var logic              start,
  output var logic [DATA_W-1:0] data_out,
  output var logic              valid_out,
  output var logic              busy
);
  logic [DATA_W-1:0] s1_data;
  logic [DATA_W-1:0] s2_data;
  logic              ctrl_valid;
  logic              s1_valid;
  logic              s2_valid;

  pipe_ctrl u_ctrl (
    .clk        (clk),
    .rst_n      (rst_n),
    .start      (start),
    .last_valid (s2_valid),
    .valid_out  (ctrl_valid),
    .busy       (busy)
  );

  pipe_stage #(
    .WIDTH(DATA_W)
  ) u_stage1 (
    .clk       (clk),
    .rst_n     (rst_n),
    .din       (data_in),
    .valid_in  (ctrl_valid),
    .dout      (s1_data),
    .valid_out (s1_valid)
  );

  pipe_stage #(
    .WIDTH(DATA_W)
  ) u_stage2 (
    .clk       (clk),
    .rst_n     (rst_n),
    .din       (s1_data),
    .valid_in  (s1_valid),
    .dout      (s2_data),
    .valid_out (s2_valid)
  );

  pipe_stage #(
    .WIDTH(DATA_W)
  ) u_stage3 (
    .clk       (clk),
    .rst_n     (rst_n),
    .din       (s2_data),
    .valid_in  (s2_valid),
    .dout      (data_out),
    .valid_out (valid_out)
  );
endmodule
`

// ─── DOM refs ───────────────────────────────────────────────────
const statusEl     = document.getElementById('status')
const renderBtn    = document.getElementById('render-btn')
const backBtn      = document.getElementById('back-btn')
const moduleSelect = document.getElementById('module-select')
const sourceEl     = document.getElementById('sv-source')
const diagramWrap  = document.getElementById('diagram-wrap')

sourceEl.value = DEFAULT_SV

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

// ─── ノード・エッジ選択 ───────────────────────────────────────
let selectedNodeId = null
let selectedEdgeId = null

function selectNode(nodeId) {
  // 前の選択をすべて解除
  diagramWrap.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'))
  diagramWrap.querySelectorAll('.edge.selected').forEach(e => e.classList.remove('selected'))
  selectedNodeId = nodeId ?? null
  selectedEdgeId = null

  if (!selectedNodeId) return

  // ノードをハイライト
  diagramWrap.querySelector(`.node[data-id="${selectedNodeId}"]`)?.classList.add('selected')

  // ext.* ポートノードなら接続エッジも全てハイライト
  if (selectedNodeId.startsWith('ext.') && currentLayout) {
    const portId  = `${selectedNodeId}.p`
    const portMap = buildPortEdgeMap(currentLayout)
    for (const eid of portMap.get(portId) ?? []) {
      diagramWrap.querySelector(`.edge[data-id="${eid}"]`)?.classList.add('selected')
    }
  }
}

function selectEdge(edgeId) {
  diagramWrap.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'))
  diagramWrap.querySelectorAll('.edge.selected').forEach(e => e.classList.remove('selected'))
  selectedNodeId = null
  selectedEdgeId = edgeId ?? null
  if (selectedEdgeId) {
    diagramWrap.querySelector(`.edge[data-id="${selectedEdgeId}"]`)?.classList.add('selected')
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
  const nodeEl = e.target.closest('.node')
  const edgeEl = e.target.closest('.edge')
  if (nodeEl) {
    selectEdge(null)
    selectNode(nodeEl.dataset.id)
  } else if (edgeEl) {
    selectNode(null)
    selectEdge(edgeEl.dataset.id)
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
  navStack.push({ moduleIdx: currentModuleIdx, moduleName: curModule.name })
  updateBackBtn()
  moduleSelect.value = String(targetIdx)
  await renderModule(targetIdx)
})

// ─── 戻るボタン: 上位階層へ ───────────────────────────────────
backBtn.addEventListener('click', async () => {
  if (navStack.length === 0) return
  const { moduleIdx } = navStack.pop()
  updateBackBtn()
  moduleSelect.value = String(moduleIdx)
  await renderModule(moduleIdx)
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

// ─── モジュール単体レンダリング ─────────────────────────────────
/** currentTree の moduleIdx 番目のモジュールをレイアウト→SVG描画する */
async function renderModule(moduleIdx) {
  currentModuleIdx = moduleIdx
  panOffset        = { x: 0, y: 0 }
  zoom             = 1.0
  selectedNodeId   = null
  selectedEdgeId   = null

  try {
    const elkGraph = buildElkGraph(currentTree, moduleIdx)
    const layout   = await elk.layout(elkGraph)
    currentLayout  = layout                  // ポート→エッジ逆引き用に保持
    const svg      = renderToSvg(layout)
    diagramWrap.innerHTML = ''
    diagramWrap.appendChild(svg)

    const m         = currentTree.modules[moduleIdx]
    const nodeCount = m.instances.length + m.always_blocks.length
    setStatus(`OK — ${currentTree.modules.length} module(s), ${nodeCount} block(s)`, 'ok')
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
    const json  = lower_sv(sourceEl.value)
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
  await renderModule(parseInt(moduleSelect.value, 10))
})

// 起動
updateBackBtn()
initWasm()
