import ELK from 'elkjs/lib/elk.bundled.js'
import { lower_sv } from '../wasm/sv_wasm.js'
import { buildElkGraph } from './elk-builder.js'
import { renderToSvg }   from './renderer.js'

// ─── デフォルトの SV ソース ──────────────────────────────────────
const DEFAULT_SV = `\
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

// ─── ノード選択 ───────────────────────────────────────────────
let selectedNodeId = null

function selectNode(nodeId) {
  diagramWrap.querySelectorAll('.node.selected')
    .forEach(n => n.classList.remove('selected'))
  selectedNodeId = nodeId ?? null
  if (selectedNodeId) {
    diagramWrap.querySelector(`.node[data-id="${selectedNodeId}"]`)
      ?.classList.add('selected')
  }
}

// ─── パン（ドラッグ移動）─────────────────────────────────────
const PAN_PAD  = 24    // renderer.js の STYLE.padding と同値
let panOffset  = { x: 0, y: 0 }
let isPanning  = false
let panStart   = { x: 0, y: 0 }
/** mousedown から mousemove が 4px 超えたら true → click イベントを無視する */
let panMoved   = false

function applyPan() {
  const g = diagramWrap.querySelector('.sv-content')
  if (!g) return
  g.setAttribute('transform',
    `translate(${PAN_PAD + panOffset.x},${PAN_PAD + panOffset.y})`)
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
  applyPan()
})

window.addEventListener('mouseup', () => {
  if (!isPanning) return
  isPanning = false
  diagramWrap.classList.remove('panning')
  // panMoved はここではリセットしない → 直後の click イベントで参照するため
})

// ─── クリック: ノード選択 ─────────────────────────────────────
diagramWrap.addEventListener('click', e => {
  if (panMoved) { panMoved = false; return }  // ドラッグ後のクリックは無視
  const nodeEl = e.target.closest('.node')
  selectNode(nodeEl?.dataset.id ?? null)
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
  selectedNodeId   = null

  try {
    const elkGraph = buildElkGraph(currentTree, moduleIdx)
    const layout   = await elk.layout(elkGraph)
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
