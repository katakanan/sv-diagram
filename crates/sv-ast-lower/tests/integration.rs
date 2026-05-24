use sv_ast_lower::{lower, types::*};

const COUNTER_SV: &str = r#"
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
"#;

const TOP_SV: &str = r#"
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
"#;

#[test]
fn test_counter_module() {
    let tree = lower(COUNTER_SV, "counter.sv").expect("lower failed");
    assert_eq!(tree.modules.len(), 1);

    let m = &tree.modules[0];
    assert_eq!(m.name, "counter");

    assert_eq!(m.ports.len(), 3);
    assert_eq!(m.ports[0].name, "clk");
    assert_eq!(m.ports[0].direction, PortDirection::Input);
    assert_eq!(m.ports[2].name, "count");
    assert_eq!(m.ports[2].direction, PortDirection::Output);

    assert_eq!(m.always_blocks.len(), 1);
    assert_eq!(m.always_blocks[0].kind, AlwaysKind::Ff);
    assert!(m.always_blocks[0].clock.is_some());
    let clk = m.always_blocks[0].clock.as_ref().unwrap();
    assert_eq!(clk.signal_name, "clk");
    assert_eq!(clk.edge, EdgeKind::Posedge);

    let rst = m.always_blocks[0].reset.as_ref().unwrap();
    assert_eq!(rst.signal_name, "rst_n");
    assert!(rst.active_low);
}

#[test]
fn test_top_module_instances() {
    let tree = lower(TOP_SV, "top.sv").expect("lower failed");
    let m = &tree.modules[0];
    assert_eq!(m.name, "top");

    assert_eq!(m.instances.len(), 1);
    let inst = &m.instances[0];
    assert_eq!(inst.module_name, "counter");
    assert_eq!(inst.instance_name, "u_counter");

    assert_eq!(inst.param_overrides.len(), 1);
    assert_eq!(inst.param_overrides[0].param_name, "WIDTH");
    assert_eq!(inst.param_overrides[0].value, "8");

    assert_eq!(inst.port_connections.len(), 3);
    let clk_conn = inst.port_connections.iter().find(|c| c.port_name == "clk").unwrap();
    assert_eq!(clk_conn.signal, "clk");
    // ポート名と信号名が異なる場合のテスト（.count(cnt)）
    // 修正前はポート名 "count" が signal に入ってしまうバグがあった
    let count_conn = inst.port_connections.iter().find(|c| c.port_name == "count").unwrap();
    assert_eq!(count_conn.signal, "cnt");
}

#[test]
fn test_signal_declarations() {
    let tree = lower(TOP_SV, "top.sv").expect("lower failed");
    let m = &tree.modules[0];

    assert_eq!(m.signals.len(), 1);
    assert_eq!(m.signals[0].name, "cnt");
    assert_eq!(m.signals[0].kind, SignalKind::Variable);
}

// ─── assign テスト群 ──────────────────────────────────────────────

/// 単純な1対1の信号代入
#[test]
fn test_assign_simple() {
    let sv = r#"
module t (
  input  var logic clk,
  output var logic y
);
  logic x;
  assign y = x;
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];
    assert_eq!(m.assigns.len(), 1);
    assert_eq!(m.assigns[0].lhs, "y");
    assert_eq!(m.assigns[0].rhs, "x");
}

/// ビット幅付き信号の複数 assign
#[test]
fn test_assign_multiple() {
    let sv = r#"
module t (
  input  var logic [7:0] a,
  input  var logic [7:0] b,
  output var logic [7:0] sum,
  output var logic [7:0] diff
);
  assign sum  = a + b;
  assign diff = a - b;
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];
    assert_eq!(m.assigns.len(), 2);

    let sum_a = m.assigns.iter().find(|a| a.lhs == "sum").unwrap();
    assert_eq!(sum_a.rhs, "a + b");

    let diff_a = m.assigns.iter().find(|a| a.lhs == "diff").unwrap();
    assert_eq!(diff_a.rhs, "a - b");
}

/// 三項演算子を含む assign
#[test]
fn test_assign_ternary() {
    let sv = r#"
module t (
  input  var logic       sel,
  input  var logic [7:0] a,
  input  var logic [7:0] b,
  output var logic [7:0] y
);
  assign y = sel ? a : b;
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];
    assert_eq!(m.assigns.len(), 1);
    assert_eq!(m.assigns[0].lhs, "y");
    assert_eq!(m.assigns[0].rhs, "sel ? a : b");
}

/// ネストした三項演算子 (優先エンコーダ)
#[test]
fn test_assign_ternary_nested() {
    let sv = r#"
module t (
  input  var logic [3:0] req,
  output var logic [1:0] grant
);
  assign grant = req[3] ? 2'd3 :
                 req[2] ? 2'd2 :
                 req[1] ? 2'd1 :
                          2'd0;
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];
    assert_eq!(m.assigns.len(), 1);
    assert_eq!(m.assigns[0].lhs, "grant");
    // RHS が空でないこと、および先頭トークンが "req" であることを確認
    assert!(!m.assigns[0].rhs.is_empty());
    assert!(m.assigns[0].rhs.contains("req"));
}

/// ビット演算を含む assign
#[test]
fn test_assign_bitwise() {
    let sv = r#"
module t (
  input  var logic [7:0] a,
  input  var logic [7:0] b,
  input  var logic       en,
  output var logic [7:0] y,
  output var logic       any_bit
);
  assign y       = (a & b) | {8{en}};
  assign any_bit = |a;
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];
    assert_eq!(m.assigns.len(), 2);

    let y_a = m.assigns.iter().find(|a| a.lhs == "y").unwrap();
    assert!(y_a.rhs.contains('&'));
    assert!(y_a.rhs.contains('|'));

    let any_a = m.assigns.iter().find(|a| a.lhs == "any_bit").unwrap();
    assert!(any_a.rhs.contains('|'));
    assert!(any_a.rhs.contains('a'));
}
