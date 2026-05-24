import ELK from 'elkjs/lib/elk.bundled.js'
import { lower_sv } from '../wasm/sv_wasm.js'
import { buildElkGraph } from './elk-builder.js'
import { renderToSvg }   from './renderer.js'

// ─── デフォルトの SV ソース ──────────────────────────────────────
const DEFAULT_SV = `\
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

module top (
  input  var logic clk,
  input  var logic rst_n
);
  logic [7:0] cnt;

  counter #(
    .WIDTH(8)
  ) u_counter (
    .clk   (clk),
    .rst_n (rst_n),
    .count (cnt)
  );
endmodule
`

// ─── DOM refs ───────────────────────────────────────────────────
const statusEl    = document.getElementById('status')
const renderBtn   = document.getElementById('render-btn')
const moduleSelect = document.getElementById('module-select')
const sourceEl    = document.getElementById('sv-source')
const diagramWrap = document.getElementById('diagram-wrap')

sourceEl.value = DEFAULT_SV

// ─── ELK インスタンス ─────────────────────────────────────────
const elk = new ELK()

// ─── WASM 初期化 ─────────────────────────────────────────────
// --target bundler: vite-plugin-wasm がモジュールロード時に自動初期化する
// lower_sv は静的 import 済み。ページロード完了後すぐに使用可能。
function initWasm() {
  try {
    // lower_sv が使えるか確認（WAMSロード失敗時は例外を投げる）
    if (typeof lower_sv !== 'function') throw new Error('lower_sv not found')
    setStatus('準備完了', 'ok')
    renderBtn.disabled = false
  } catch (e) {
    setStatus(`WASM 初期化失敗: ${e.message}`, 'error')
    console.error(e)
  }
}

// ─── レンダリング ─────────────────────────────────────────────
async function render() {
  renderBtn.disabled = true
  setStatus('解析・レイアウト中...')

  try {
    // 1. sv-ast-lower (WASM) で SV → DiagramTree JSON
    const json = lower_sv(sourceEl.value)
    const tree = JSON.parse(json)

    // モジュール選択プルダウンを更新
    updateModuleSelect(tree.modules)

    const moduleIdx = parseInt(moduleSelect.value ?? '0', 10)

    // 2. DiagramTree → ELK グラフ
    const elkGraph = buildElkGraph(tree, moduleIdx)

    // 3. ELKjs でレイアウト計算
    const layout = await elk.layout(elkGraph)

    // 4. SVG レンダリング
    const svg = renderToSvg(layout)
    diagramWrap.innerHTML = ''
    diagramWrap.appendChild(svg)

    const nodeCount = tree.modules[moduleIdx].instances.length
      + tree.modules[moduleIdx].always_blocks.length
    setStatus(`OK — ${tree.modules.length} module(s), ${nodeCount} block(s)`, 'ok')
  } catch (e) {
    setStatus(`エラー: ${e.message}`, 'error')
    console.error(e)
  } finally {
    renderBtn.disabled = false
  }
}

// ─── モジュール選択 ───────────────────────────────────────────
function updateModuleSelect(modules) {
  const prev = moduleSelect.value
  moduleSelect.innerHTML = modules
    .map((m, i) => `<option value="${i}">${m.name}</option>`)
    .join('')
  // できれば直前の選択を維持
  if ([...moduleSelect.options].some(o => o.value === prev)) {
    moduleSelect.value = prev
  }
}

// ─── ユーティリティ ───────────────────────────────────────────
function setStatus(msg, cls = '') {
  statusEl.textContent = msg
  statusEl.className = cls
}

// ─── イベント ─────────────────────────────────────────────────
renderBtn.addEventListener('click', render)
moduleSelect.addEventListener('change', render)

// 起動
initWasm()
