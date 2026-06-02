# sv-diagram

A browser-based tool to **visualize logic connections** in SystemVerilog modules.

## Overview

Paste your SV source into the editor and instantly see the signal flow inside each module as an interactive diagram.

- Ports, internal signals, instances, `assign` statements, and `always_ff`/`always_comb`/`always_latch` blocks are rendered as nodes
- Clock oscillators (`always #N clk = ~clk`), DC drivers, and `initial begin...end` blocks are also visualized
- Testbenches (port-less `module tb;` style) are supported

## Waveform Viewer

Load a VCD file to view signal waveforms alongside the diagram.

- 1-bit and bus signals rendered as an SVG timing diagram
- Time cursor with live signal value display
- Zoom in/out on the time axis
- **Bidirectional highlight**: click an edge in the diagram to highlight the matching waveform row, or click a signal name in the waveform to highlight the corresponding edges
- Signal values at the cursor time are overlaid on each diagram edge

A sample `counter.vcd` is loaded automatically on startup — just click **▶ Render** to see everything at once.

## Runs Entirely in the Browser

**No server required.** The parser and lowering pass are written in Rust and compiled to WebAssembly via [wasm-pack](https://rustwasm.github.io/wasm-pack/). All SV source and VCD data is processed locally and never sent anywhere.

## Disclaimer

> **This tool is intended as a visual aid for understanding logic connections.**
>
> The diagrams do not necessarily reflect the exact behavior, timing, or synthesis results of a design. It is meant for getting a rough overview of signal connectivity and is not a substitute for formal verification or synthesis tools.

## Usage

Open the [GitHub Pages demo](https://katakanan.github.io/sv-diagram/) in your browser and paste your SystemVerilog source into the left-hand editor.

## Local Development

### Requirements

- Rust (stable) + `wasm32-unknown-unknown` target
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Node.js 18+

### Setup

```bash
# Build WASM
cd web
npm run wasm

# Start dev server
npm install
npm run dev
```

### Tests

```bash
cargo test -p sv-ast-lower
```

## Tech Stack

| Role | Technology |
|---|---|
| SV parser | [sv-parser](https://github.com/dalance/sv-parser) |
| Layout engine | [ELK.js](https://github.com/kieler/elkjs) |
| WASM bindings | [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) |
| Frontend | Vite + Vanilla JS |

## License

MIT License — see [LICENSE](LICENSE) for details.
