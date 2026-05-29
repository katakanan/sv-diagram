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

/// negedge clk でも CLK としてパースされることを確認
#[test]
fn test_negedge_clk_is_clock() {
    let sv = r#"
module neg_clk (
  input  var logic clk,
  input  var logic arst_n,
  input  var logic d,
  output var logic q
);
  always_ff @(negedge clk or negedge arst_n) begin
    if (!arst_n) begin
      q <= 1'b0;
    end else begin
      q <= d;
    end
  end
endmodule
"#;
    let tree = lower(sv, "neg_clk.sv").unwrap();
    let m = &tree.modules[0];
    let ab = &m.always_blocks[0];

    // negedge clk → 名前に "clk" を含むのでクロックとして認識
    let clk = ab.clock.as_ref().expect("clock should be Some");
    assert_eq!(clk.signal_name, "clk");
    assert_eq!(clk.edge, EdgeKind::Negedge);

    // arst_n → リセットとして認識
    let rst = ab.reset.as_ref().expect("reset should be Some");
    assert_eq!(rst.signal_name, "arst_n");
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

/// `var` キーワードなしのポート宣言 (`input logic hoge`)
#[test]
fn test_port_without_var() {
    let sv = r#"
module t (
  input  logic       clk,
  input  logic       rst_n,
  output logic [7:0] data_out
);
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];

    assert_eq!(m.ports.len(), 3);

    let clk = &m.ports[0];
    assert_eq!(clk.name, "clk");
    assert_eq!(clk.direction, PortDirection::Input);

    let rst = &m.ports[1];
    assert_eq!(rst.name, "rst_n");
    assert_eq!(rst.direction, PortDirection::Input);

    let dout = &m.ports[2];
    assert_eq!(dout.name, "data_out");
    assert_eq!(dout.direction, PortDirection::Output);
    // ビット幅付き型が取れているか
    assert!(dout.data_type.contains("logic"), "data_type was: {}", dout.data_type);
}

/// var あり・なし混在ポート
#[test]
fn test_port_mixed_var() {
    let sv = r#"
module t (
  input  var logic clk,
  input      logic rst_n,
  output var logic y
);
endmodule
"#;
    let tree = lower(sv, "t.sv").unwrap();
    let m = &tree.modules[0];

    assert_eq!(m.ports.len(), 3);
    assert_eq!(m.ports[0].name, "clk");
    assert_eq!(m.ports[0].direction, PortDirection::Input);
    assert_eq!(m.ports[1].name, "rst_n");
    assert_eq!(m.ports[1].direction, PortDirection::Input);
    assert_eq!(m.ports[2].name, "y");
    assert_eq!(m.ports[2].direction, PortDirection::Output);
}

/// always_ff の body AST が生成されるか
#[test]
fn test_always_ff_body_ast() {
    let tree = lower(COUNTER_SV, "counter.sv").unwrap();
    let m = &tree.modules[0];
    let ab = &m.always_blocks[0];

    // body は空でない
    assert!(!ab.body.is_empty(), "always_ff body should not be empty");

    // トップレベルに Stmt::If があるはず (if (!rst_n) begin...end else begin...end)
    let has_if = ab.body.iter().any(|s| matches!(s, Stmt::If { .. }));
    assert!(has_if, "expected Stmt::If in body, got: {:?}", ab.body);

    // driven_signals に count が含まれる
    assert!(ab.driven_signals.contains(&"count".to_string()));
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

/// always_comb の case 文が Stmt::Case に変換されるか
#[test]
fn test_always_comb_case_body() {
    let sv = r#"
module ctrl(
  input  var logic [1:0] op,
  output var logic [1:0] alu_op,
  output var logic       ctrl_out
);
  always_comb begin
    case (op)
      2'b00: begin alu_op = 2'b00; ctrl_out = 1'b1; end
      2'b01: begin alu_op = 2'b01; ctrl_out = 1'b0; end
      2'b10: begin alu_op = 2'b10; ctrl_out = 1'b0; end
      default: begin alu_op = 2'b00; ctrl_out = 1'b0; end
    endcase
  end
endmodule
"#;
    let tree = lower(sv, "ctrl.sv").unwrap();
    let m    = &tree.modules[0];
    assert_eq!(m.always_blocks.len(), 1);
    let ab   = &m.always_blocks[0];
    assert_eq!(ab.kind, AlwaysKind::Comb);

    // body の先頭に Case があること
    assert_eq!(ab.body.len(), 1, "body should have exactly 1 top-level stmt");
    let case_stmt = &ab.body[0];
    match case_stmt {
        Stmt::Case { sel, items, default_ } => {
            // セレクタが "op"
            match sel {
                Expr::Ident(s) => assert_eq!(s, "op"),
                other => panic!("expected Ident(op), got {:?}", other),
            }
            // non-default アイテムが 3 つ
            assert_eq!(items.len(), 3, "expected 3 non-default items, got {:?}", items.len());
            // 各アイテムに alu_op への代入があること
            for item in items {
                let has_alu_op = item.stmts.iter().any(|s| matches!(s, Stmt::BAssign { lhs, .. } if lhs == "alu_op"));
                assert!(has_alu_op, "item {:?} missing alu_op assignment", item.pattern);
            }
            // default_ に代入があること
            assert!(!default_.is_empty(), "default_ should not be empty");
        }
        other => panic!("expected Stmt::Case, got {:?}", other),
    }
}

/// always_ff の case 文が Stmt::Case に変換されるか（if の中の case）
#[test]
fn test_always_ff_case_in_if() {
    let sv = r#"
module regfile(
  input  var logic       clk,
  input  var logic       rst_n,
  input  var logic [1:0] rd,
  input  var logic [7:0] wd,
  input  var logic       we
);
  logic [7:0] r0;
  logic [7:0] r1;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      r0 <= '0;
      r1 <= '0;
    end else begin
      if (we) begin
        case (rd)
          2'd0: r0 <= wd;
          2'd1: r1 <= wd;
          default: r0 <= '0;
        endcase
      end
    end
  end
endmodule
"#;
    let tree = lower(sv, "regfile.sv").unwrap();
    let m    = &tree.modules[0];
    let ab   = &m.always_blocks[0];

    // body の先頭は If(rst_n)
    assert!(!ab.body.is_empty());
    let top = &ab.body[0];
    let else_body = match top {
        Stmt::If { else_, .. } => else_,
        other => panic!("expected Stmt::If, got {:?}", other),
    };

    // else-branch の先頭は If(we)
    assert!(!else_body.is_empty());
    let we_if = &else_body[0];
    let we_then = match we_if {
        Stmt::If { then_, .. } => then_,
        other => panic!("expected Stmt::If(we), got {:?}", other),
    };

    // If(we) の then に Case(rd) があること
    assert!(!we_then.is_empty(), "If(we).then_ should not be empty");
    let case_stmt = &we_then[0];
    match case_stmt {
        Stmt::Case { sel, items, .. } => {
            match sel {
                Expr::Ident(s) => assert_eq!(s, "rd"),
                other => panic!("expected Ident(rd), got {:?}", other),
            }
            assert_eq!(items.len(), 2); // 2'd0 and 2'd1
        }
        other => panic!("expected Stmt::Case inside if(we), got {:?}", other),
    }
}
