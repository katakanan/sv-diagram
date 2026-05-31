#!/bin/bash
# ─── Counter シミュレーション実行スクリプト ─────────────────────────
# 使い方:
#   bash sim/run_sim.sh
# または sim/ ディレクトリ内で:
#   bash run_sim.sh
#
# 出力: sim/counter.vcd
# 前提: iverilog / vvp がインストールされていること
#   Ubuntu: sudo apt install iverilog
# ────────────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/2] コンパイル中..."
iverilog -g2012 -o counter_sim counter_tb.sv counter.sv

echo "[2/2] シミュレーション実行中..."
vvp counter_sim

echo ""
echo "完了: ${SCRIPT_DIR}/counter.vcd が生成されました"
