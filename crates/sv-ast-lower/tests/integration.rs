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
}

#[test]
fn test_signal_declarations() {
    let tree = lower(TOP_SV, "top.sv").expect("lower failed");
    let m = &tree.modules[0];

    assert_eq!(m.signals.len(), 1);
    assert_eq!(m.signals[0].name, "cnt");
    assert_eq!(m.signals[0].kind, SignalKind::Variable);
}
