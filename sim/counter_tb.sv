`timescale 1ns/1ps
// ─── Counter テストベンチ ──────────────────────────────────────────
// VCD ファイルを生成してシミュレーション波形を保存する。
//
// シミュレーション手順:
//   iverilog -g2012 -o counter_sim counter_tb.sv counter.sv
//   vvp counter_sim
//   → counter.vcd が生成される
// ───────────────────────────────────────────────────────────────────
module counter_tb;

  // ─── 信号 ────────────────────────────────────────────────────────
  logic       clk   = 1'b0;
  logic       rst_n = 1'b0;
  logic [7:0] count;

  // ─── DUT インスタンス ────────────────────────────────────────────
  counter #(.WIDTH(8)) u_counter (
    .clk  (clk),
    .rst_n(rst_n),
    .count(count)
  );

  // ─── クロック生成（10 ns 周期 / 100 MHz 相当）───────────────────
  always #5 clk = ~clk;

  // ─── テストシーケンス ─────────────────────────────────────────────
  initial begin
    $dumpfile("counter.vcd");
    $dumpvars(0, counter_tb);

    // ── リセット（3 サイクル）──────────────────────────────────────
    rst_n = 1'b0;
    repeat(3) @(posedge clk);
    #1 rst_n = 1'b1;     // クロック立上り直後に解除（セットアップ余裕あり）

    // ── カウントアップ（20 サイクル）──────────────────────────────
    repeat(20) @(posedge clk);

    // ── リセット再印加（2 サイクル）──────────────────────────────
    #1 rst_n = 1'b0;
    repeat(2) @(posedge clk);
    #1 rst_n = 1'b1;

    // ── 残り 10 サイクル ──────────────────────────────────────────
    repeat(10) @(posedge clk);

    #1 $finish;
  end

  // ─── モニタ（シミュレーションログ）──────────────────────────────
  initial begin
    $monitor("t=%0t  rst_n=%b  count=%0d", $time, rst_n, count);
  end

endmodule
