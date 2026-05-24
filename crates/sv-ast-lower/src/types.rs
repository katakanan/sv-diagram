use serde::{Deserialize, Serialize};

/// ファイル全体のトップレベル出力
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramTree {
    pub modules: Vec<ModuleNode>,
}

/// 1つのモジュール
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleNode {
    pub name: String,
    pub ports: Vec<PortNode>,
    pub parameters: Vec<ParameterNode>,
    pub signals: Vec<SignalNode>,
    pub instances: Vec<InstanceNode>,
    pub assigns: Vec<AssignNode>,
    pub always_blocks: Vec<AlwaysNode>,
    pub generates: Vec<GenerateNode>,
}

/// ポート（ANSIのみ）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortNode {
    pub name: String,
    pub direction: PortDirection,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PortDirection {
    Input,
    Output,
    Inout,
}

/// パラメータ（#パラメータリストのもの）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterNode {
    pub name: String,
    pub data_type: String,
    pub default_value: Option<String>,
}

/// ローカル信号宣言
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalNode {
    pub name: String,
    pub data_type: String,
    pub kind: SignalKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SignalKind {
    Variable,
    LocalParam,
}

/// モジュールインスタンス
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceNode {
    pub module_name: String,
    pub instance_name: String,
    pub param_overrides: Vec<ParamOverride>,
    pub port_connections: Vec<PortConnection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamOverride {
    pub param_name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortConnection {
    pub port_name: String,
    pub signal: String,
}

/// assign文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignNode {
    pub lhs: String,
    pub rhs: String,
}

/// always_ff / always_comb / always_latch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlwaysNode {
    pub kind: AlwaysKind,
    pub clock: Option<ClockInfo>,
    pub reset: Option<ResetInfo>,
    /// このブロックが駆動（書き込む）信号名一覧
    pub driven_signals: Vec<String>,
    /// このブロックが参照（読み取る）信号名一覧
    /// clk・rst は除外済み、driven_signals の信号も除外済み
    pub read_signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AlwaysKind {
    Ff,
    Comb,
    Latch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockInfo {
    pub signal_name: String,
    pub edge: EdgeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EdgeKind {
    Posedge,
    Negedge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResetInfo {
    pub signal_name: String,
    pub active_low: bool,
}

/// generate ブロック（for または if）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateNode {
    pub kind: GenerateKind,
    pub label: String,
    pub instances: Vec<InstanceNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GenerateKind {
    For {
        var_name: String,
        range_str: String,
    },
    If {
        condition: String,
    },
}
