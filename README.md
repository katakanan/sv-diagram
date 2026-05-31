# sv-diagram

SystemVerilog モジュールの **ロジック接続を視覚化** するブラウザアプリです。

## 概要

SV ソースをエディタに貼り付けると、モジュール内の信号の流れをリアルタイムにダイアグラムとして表示します。

- ポート・内部信号・インスタンス・`assign` 文・`always_ff`/`always_comb`/`always_latch` ブロックをノードとして配置
- クロック発振器（`always #N clk = ~clk`）や DC ドライバ、`initial begin...end` ブロックも可視化
- テストベンチ（ポートなしの `module tb;` 形式）にも対応

## ブラウザ完結

**サーバーは不要です。** Rust で実装したパーサ／ローワーを [wasm-pack](https://rustwasm.github.io/wasm-pack/) で WebAssembly にコンパイルし、ブラウザ上で直接動作します。SV ソースはローカルで処理され、外部に送信されません。

## 注意事項

> **このツールは「ロジックの接続を理解するための補助ツール」です。**
>
> 表示されるダイアグラムは、必ずしも設計の正確な動作・タイミング・合成結果を反映したものではありません。信号間のおおまかな接続関係を把握する用途を想定しており、フォーマル検証や合成ツールの代替にはなりません。

## 使い方

[GitHub Pages のデモページ](#) をブラウザで開き、左側のエディタに SystemVerilog ソースを入力するだけです。

## ローカル開発

### 必要なもの

- Rust (stable) + `wasm32-unknown-unknown` ターゲット
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Node.js 18+

### セットアップ

```bash
# WASM をビルド
cd web
npm run wasm

# 開発サーバー起動
npm install
npm run dev
```

### テスト

```bash
cargo test -p sv-ast-lower
```

## 技術スタック

| 役割 | 技術 |
|---|---|
| SV パーサ | [sv-parser](https://github.com/dalance/sv-parser) |
| レイアウトエンジン | [ELK.js](https://github.com/kieler/elkjs) |
| WASM バインディング | [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) |
| フロントエンド | Vite + Vanilla JS |

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照してください。
