// ─── Counter ───────────────────────────────────────────────────────
// WIDTH ビット幅の同期カウンター（非同期アクティブローリセット付き）
//
// svlint ルール準拠:
//   - ANSI ポート宣言 (module_nonansi_forbidden)
//   - input/output に var あり (input_with_var, output_with_var)
//   - always_ff のみ使用 (keyword_forbidden_always)
//   - ノンブロッキング代入のみ (blocking_assignment_in_always_ff)
// ───────────────────────────────────────────────────────────────────
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
