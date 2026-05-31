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
