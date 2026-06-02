// ─── Counter ─────────────────────────────────────────────────────
// WIDTH ビット幅の同期カウンター（非同期アクティブローリセット付き）
// sim/counter.sv と同一コード
// ─────────────────────────────────────────────────────────────────
module counter #(
  parameter WIDTH = 8
)(
  input  wire             clk,
  input  wire             rst_n,
  output reg  [WIDTH-1:0] count
);

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      count <= '0;
    end else begin
      count <= count + 1;
    end
  end

endmodule
