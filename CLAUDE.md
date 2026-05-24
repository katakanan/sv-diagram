# CLAUDE.md — `sv-ast-lower` crate

## このcrateの目的

svlintを通過したSystemVerilogソースを `sv-parser` でパースし、
CST（Concrete Syntax Tree）から**ダイアグラム生成に特化した独自ツリー**へ変換する。

後続crateはこの出力ツリーだけを見ればよく、
sv-parserの巨大なRefNodeを直接触る必要がない。

---

## 前提条件（svlintで保証済みの制約）

このcrateに渡されるSVは `.svlint.toml` で以下が保証されている。
実装時は**これらを前提にして良い**。ガード節は不要。

| 保証内容 | 対応するsvlintルール |
|---|---|
| モジュール宣言は全てANSI形式 | `module_nonansi_forbidden` |
| `generate`/`endgenerate` キーワードなし | `keyword_forbidden_generate` |
| `wire`/`reg` なし、`logic` のみ | `keyword_forbidden_wire_reg` |
| `always` なし、`always_ff`/`always_comb`/`always_latch` のみ | `keyword_forbidden_always` |
| `for`/`if` に必ず `begin...end` あり | `for_with_begin`, `if_with_begin` |
| `generate for`/`generate if` に必ずラベルあり | `generate_for_with_label`, `generate_if_with_label` |
| `genvar` はループ内で宣言 | `genvar_declaration_in_loop` |
| `enum` に明示的な型あり | `enum_with_type` |
| `parameter`/`localparam` に明示的な型あり | `parameter_explicit_type`, `localparam_explicit_type` |
| `input`/`output` に `var` あり | `input_with_var`, `output_with_var` |
| `always_ff` 内はノンブロッキング代入のみ | `blocking_assignment_in_always_ff` |
| `always_comb` 内はブロッキング代入のみ | `non_blocking_assignment_in_always_comb` |
| `case` に必ず `default` あり | `case_default` |
| タブ文字なし | `tab_character` |

---

## ワークスペース構成

```
sv-diagram/                    ← ワークスペースルート
├── Cargo.toml                 ← [workspace] 定義
├── CLAUDE.md                  ← このファイル
├── .svlint.toml               ← svlintルール設定
└── crates/
    ├── sv-checker/            ← svlintを呼ぶcrate（実装済み）
    └── sv-ast-lower/          ← このcrate（これから実装）
        ├── Cargo.toml
        └── src/
            ├── lib.rs         ← 公開API
            ├── lower.rs       ← CST→DiagramTree 変換のエントリ
            ├── module.rs      ← モジュール宣言の変換
            ├── port.rs        ← ポート宣言の変換
            ├── instance.rs    ← モジュールインスタンスの変換
            ├── signal.rs      ← 信号宣言・assign の変換
            ├── always.rs      ← always_ff/comb/latch の変換
            └── types.rs       ← 出力ツリーの型定義（DiagramTree）
```

---

## Cargo.toml

```toml
[package]
name    = "sv-ast-lower"
version = "0.1.0"
edition = "2021"

[dependencies]
sv-parser  = "0.13.5"
thiserror  = "1"
serde      = { version = "1", features = ["derive"] }
```

---

## 出力型 — `src/types.rs`

sv-parserのCSTを捨てて、ダイアグラムが必要とする情報だけを持つ型。
**シリアライズ可能**にして後続crateがJSONで受け取れるようにする。

```rust
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

    /// ANSIポートリスト（svlint保証でこれしか存在しない）
    pub ports: Vec<PortNode>,

    /// パラメータ宣言（#(parameter ...)）
    pub parameters: Vec<ParameterNode>,

    /// モジュール内のローカル信号宣言
    pub signals: Vec<SignalNode>,

    /// モジュールインスタンス（子モジュール）
    pub instances: Vec<InstanceNode>,

    /// assign文
    pub assigns: Vec<AssignNode>,

    /// always_ff / always_comb / always_latch ブロック
    pub always_blocks: Vec<AlwaysNode>,

    /// generate for / generate if ブロック
    pub generates: Vec<GenerateNode>,
}

/// ポート（ANSIのみ）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortNode {
    pub name: String,
    pub direction: PortDirection,
    /// "logic [7:0]" など、型の文字列表現
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
    /// "int unsigned" など
    pub data_type: String,
    /// デフォルト値の文字列表現
    pub default_value: Option<String>,
}

/// ローカル信号宣言（logic [N:0] sig_name）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalNode {
    pub name: String,
    pub data_type: String,
    pub kind: SignalKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SignalKind {
    /// logic 変数（var logic）
    Variable,
    /// localparam
    LocalParam,
}

/// モジュールインスタンス
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceNode {
    /// インスタンス化されているモジュール名
    pub module_name: String,
    /// このインスタンスの名前
    pub instance_name: String,
    /// パラメータ上書き（#(.WIDTH(8))）
    pub param_overrides: Vec<ParamOverride>,
    /// ポート接続（.port(signal)）
    pub port_connections: Vec<PortConnection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamOverride {
    pub param_name: String,
    /// 値の文字列表現
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortConnection {
    pub port_name: String,
    /// 接続先信号名（空文字は未接続）
    pub signal: String,
}

/// assign文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignNode {
    /// 左辺の信号名
    pub lhs: String,
    /// 右辺の文字列表現
    pub rhs: String,
}

/// always_ff / always_comb / always_latch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlwaysNode {
    pub kind: AlwaysKind,
    /// always_ff のクロック信号名（always_combはNone）
    pub clock: Option<ClockInfo>,
    /// リセット信号名（あれば）
    pub reset: Option<ResetInfo>,
    /// このブロックで駆動している信号名一覧
    pub driven_signals: Vec<String>,
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
    /// generate for/if に付いたラベル（svlint保証で必ず存在）
    pub label: String,
    /// このgenerateブロック内のインスタンス
    pub instances: Vec<InstanceNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GenerateKind {
    For {
        /// ループ変数名
        var_name: String,
        /// 繰り返し数の文字列（パラメータ参照等を含む）
        range_str: String,
    },
    If {
        /// 条件式の文字列
        condition: String,
    },
}
```

---

## エントリポイント — `src/lib.rs`

```rust
mod always;
mod instance;
mod lower;
mod module;
mod port;
mod signal;
pub mod types;

use std::collections::HashMap;
use std::path::Path;
use sv_parser::parse_sv_str;
use thiserror::Error;
pub use types::DiagramTree;

#[derive(Debug, Error)]
pub enum LowerError {
    #[error("sv-parser failed: {0}")]
    ParseError(String),
    #[error("lowering failed: {0}")]
    LowerError(String),
}

/// SVソース文字列を DiagramTree に変換する
///
/// # 前提
/// `source` は sv-checker (svlint) を通過済みであること。
/// svlintの制約を前提に実装しているため、未チェックのSVを渡した場合の
/// 動作は保証しない。
pub fn lower(source: &str, filename: &str) -> Result<DiagramTree, LowerError> {
    let path = Path::new(filename);
    let defines = HashMap::new();
    let includes: Vec<std::path::PathBuf> = vec![];

    let (syntax_tree, _) = parse_sv_str(source, path, &defines, &includes, false, false)
        .map_err(|e| LowerError::ParseError(e.to_string()))?;

    lower::lower_tree(&syntax_tree, source)
        .map_err(|e| LowerError::LowerError(e.to_string()))
}
```

---

## 変換実装 — `src/lower.rs`

sv-parserのCSTをトラバースするエントリ。

```rust
use sv_parser::{RefNode, SyntaxTree};
use crate::types::{DiagramTree, ModuleNode};
use crate::module::lower_module_ansi;

pub fn lower_tree(
    tree: &SyntaxTree,
    source: &str,
) -> Result<DiagramTree, Box<dyn std::error::Error>> {
    let mut modules = Vec::new();

    for node in tree {
        // svlintで module_nonansi_forbidden を有効にしているため
        // ModuleDeclarationNonansi は存在しない → matchしない
        if let RefNode::ModuleDeclarationAnsi(m) = node {
            if let Some(module) = lower_module_ansi(m, tree, source)? {
                modules.push(module);
            }
        }
    }

    Ok(DiagramTree { modules })
}
```

---

## モジュール変換 — `src/module.rs`

```rust
use sv_parser::{
    ModuleDeclarationAnsi, RefNode, SyntaxTree,
    unwrap_node,
};
use crate::types::ModuleNode;
use crate::port::lower_ports;
use crate::instance::lower_instances;
use crate::signal::lower_signals_and_assigns;
use crate::always::lower_always_blocks;

pub fn lower_module_ansi(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    source: &str,
) -> Result<Option<ModuleNode>, Box<dyn std::error::Error>> {
    // モジュール名を取得
    // ModuleDeclarationAnsi → ModuleAnsiHeader → ModuleIdentifier
    let name_node = unwrap_node!(m, ModuleIdentifier)
        .ok_or("missing ModuleIdentifier")?;
    let name = get_str(tree, name_node)?;

    // ポートリスト（ANSIのみ）
    let ports = lower_ports(m, tree, source)?;

    // パラメータ（後で実装）
    let parameters = vec![];

    // 本体の信号宣言・assign・インスタンス・always
    let (signals, assigns) = lower_signals_and_assigns(m, tree, source)?;
    let instances = lower_instances(m, tree, source)?;
    let always_blocks = lower_always_blocks(m, tree, source)?;

    Ok(Some(ModuleNode {
        name,
        ports,
        parameters,
        signals,
        instances,
        assigns,
        always_blocks,
        generates: vec![], // フェーズ2で実装
    }))
}

/// RefNodeから元のソース文字列を取得するヘルパー
pub fn get_str(tree: &SyntaxTree, node: RefNode) -> Result<String, Box<dyn std::error::Error>> {
    // sv-parserのLocateを使ってソース文字列から対応部分を切り出す
    // unwrap_locate! マクロで最初のLocateを取得する
    use sv_parser::unwrap_locate;
    let locate = unwrap_locate!(node.clone())
        .ok_or("no Locate found")?;
    let s = tree.get_str(locate)
        .ok_or("get_str failed")?;
    Ok(s.to_string())
}
```

---

## ポート変換 — `src/port.rs`

svlintで `module_nonansi_forbidden` が保証されているため
`AnsiPortDeclarationVariable` のみを処理すればよい。
`AnsiPortDeclarationNet` は `input_with_var`/`output_with_var` で排除済み。

```rust
use sv_parser::{
    ModuleDeclarationAnsi, RefNode, SyntaxTree,
    unwrap_node,
};
use crate::types::{PortNode, PortDirection};
use crate::module::get_str;

pub fn lower_ports(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    source: &str,
) -> Result<Vec<PortNode>, Box<dyn std::error::Error>> {
    let mut ports = Vec::new();

    for node in m {
        // svlint `input_with_var`/`output_with_var` により
        // AnsiPortDeclarationVariable のみ出現する（Netは出ない）
        if let RefNode::AnsiPortDeclarationVariable(port) = node {
            // 方向の取得
            // PortDirection ノードは PortDirectionInput / Output / Inout
            let direction = extract_direction(port, tree)?;

            // ポート名
            let name_node = unwrap_node!(port, PortIdentifier)
                .ok_or("missing PortIdentifier")?;
            let name = get_str(tree, name_node)?;

            // データ型文字列（"logic [7:0]" など）
            // DataTypeVector → 'logic' + PackedDimension
            let data_type = extract_data_type_str(port, tree, source)?;

            ports.push(PortNode { name, direction, data_type });
        }
    }

    Ok(ports)
}

fn extract_direction(
    port: &sv_parser::AnsiPortDeclarationVariable,
    tree: &SyntaxTree,
) -> Result<PortDirection, Box<dyn std::error::Error>> {
    for node in port {
        match node {
            RefNode::PortDirectionInput(_)  => return Ok(PortDirection::Input),
            RefNode::PortDirectionOutput(_) => return Ok(PortDirection::Output),
            RefNode::PortDirectionInout(_)  => return Ok(PortDirection::Inout),
            _ => {}
        }
    }
    // デフォルトはInput（前のポートから継承される場合があるが、
    // このcrate ではシンプルにInputとして扱う）
    Ok(PortDirection::Input)
}

fn extract_data_type_str(
    port: &sv_parser::AnsiPortDeclarationVariable,
    tree: &SyntaxTree,
    source: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    // DataTypeVector ノードを探して元ソースから切り出す
    // svlint `keyword_forbidden_wire_reg` により logic のみ
    for node in port {
        if let RefNode::DataTypeVector(dt) = node {
            // DataTypeVector の Locate 範囲をソースから取得
            use sv_parser::unwrap_locate;
            if let Some(loc) = unwrap_locate!(RefNode::DataTypeVector(dt.clone())) {
                if let Some(s) = tree.get_str(loc) {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    // 型情報がない場合は "logic" とする
    Ok("logic".to_string())
}
```

---

## インスタンス変換 — `src/instance.rs`

```rust
use sv_parser::{
    ModuleDeclarationAnsi, RefNode, SyntaxTree,
    unwrap_node,
};
use crate::types::{InstanceNode, PortConnection, ParamOverride};
use crate::module::get_str;

pub fn lower_instances(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    source: &str,
) -> Result<Vec<InstanceNode>, Box<dyn std::error::Error>> {
    let mut instances = Vec::new();

    for node in m {
        if let RefNode::ModuleInstantiation(inst) = node {
            // モジュール名（インスタンス化されているモジュール）
            let mod_name_node = unwrap_node!(inst, ModuleIdentifier)
                .ok_or("missing ModuleIdentifier in instantiation")?;
            let module_name = get_str(tree, mod_name_node)?;

            // HierarchicalInstance が個々のインスタンスを表す
            // 1つのModuleInstantiationに複数のHierarchicalInstanceが
            // 存在する場合があるが、通常は1つ
            for hi_node in inst {
                if let RefNode::HierarchicalInstance(hi) = hi_node {
                    // インスタンス名
                    let inst_name_node = unwrap_node!(hi, InstanceIdentifier)
                        .ok_or("missing InstanceIdentifier")?;
                    let instance_name = get_str(tree, inst_name_node)?;

                    // ポート接続リスト（名前付き接続のみ）
                    // svlintで整形されたコードは通常 .port(signal) 形式
                    let port_connections = extract_port_connections(hi, tree)?;

                    // パラメータ上書き
                    let param_overrides = extract_param_overrides(inst, tree)?;

                    instances.push(InstanceNode {
                        module_name: module_name.clone(),
                        instance_name,
                        param_overrides,
                        port_connections,
                    });
                }
            }
        }
    }

    Ok(instances)
}

fn extract_port_connections(
    hi: &sv_parser::HierarchicalInstance,
    tree: &SyntaxTree,
) -> Result<Vec<PortConnection>, Box<dyn std::error::Error>> {
    let mut connections = Vec::new();

    for node in hi {
        // 名前付きポート接続: .port_name(signal)
        if let RefNode::NamedPortConnectionIdentifier(conn) = node {
            // PortIdentifier = ポート名
            let port_name_node = unwrap_node!(conn, PortIdentifier)
                .ok_or("missing PortIdentifier")?;
            let port_name = get_str(tree, port_name_node)?;

            // 括弧内の式 = 接続信号
            // Expression → Primary → HierarchicalIdentifier など複数経路があるが
            // 単純な信号名接続が大半のためSimpleIdentifierを探す
            let signal = unwrap_node!(conn, SimpleIdentifier)
                .and_then(|n| get_str(tree, n).ok())
                .unwrap_or_default();

            connections.push(PortConnection { port_name, signal });
        }
    }

    Ok(connections)
}

fn extract_param_overrides(
    inst: &sv_parser::ModuleInstantiation,
    tree: &SyntaxTree,
) -> Result<Vec<ParamOverride>, Box<dyn std::error::Error>> {
    let mut overrides = Vec::new();

    for node in inst {
        if let RefNode::NamedParameterAssignment(p) = node {
            let param_node = unwrap_node!(p, ParameterIdentifier)
                .ok_or("missing ParameterIdentifier")?;
            let param_name = get_str(tree, param_node)?;

            // 値は ConstantParamExpression 以下の文字列として取得
            let value = unwrap_node!(p, SimpleIdentifier)
                .or_else(|| unwrap_node!(p, IntegralNumber))
                .and_then(|n| get_str(tree, n).ok())
                .unwrap_or_default();

            overrides.push(ParamOverride { param_name, value });
        }
    }

    Ok(overrides)
}
```

---

## always変換 — `src/always.rs`

svlintで `keyword_forbidden_always` が保証されているため
`always_ff` / `always_comb` / `always_latch` の3種類のみ処理する。

```rust
use sv_parser::{
    ModuleDeclarationAnsi, RefNode, SyntaxTree,
    unwrap_node,
};
use crate::types::{AlwaysNode, AlwaysKind, ClockInfo, ResetInfo, EdgeKind};
use crate::module::get_str;

pub fn lower_always_blocks(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    source: &str,
) -> Result<Vec<AlwaysNode>, Box<dyn std::error::Error>> {
    let mut always_blocks = Vec::new();

    for node in m {
        if let RefNode::AlwaysConstruct(always) = node {
            // AlwaysKeyword で種別が確定する（svlint保証）
            let kind = extract_always_kind(always)?;

            let (clock, reset) = if kind == AlwaysKind::Ff {
                extract_clock_reset(always, tree)?
            } else {
                (None, None)
            };

            // このブロックで <= 代入されている信号名を収集
            let driven_signals = extract_driven_signals(always, tree, &kind)?;

            always_blocks.push(AlwaysNode {
                kind,
                clock,
                reset,
                driven_signals,
            });
        }
    }

    Ok(always_blocks)
}

fn extract_always_kind(
    always: &sv_parser::AlwaysConstruct,
) -> Result<AlwaysKind, Box<dyn std::error::Error>> {
    for node in always {
        match node {
            RefNode::AlwaysKeyword(kw) => {
                // AlwaysKeyword の nodes フィールドの Keyword を見る
                // keyword_forbidden_always でplain alwaysは排除済み
                // ここではAlwaysKeyword内のtokenで判断
                // sv-parserはAlwaysFf/Comb/LatchをAlwaysKeyword内で区別する
                // 実際のノード構造はAlwaysKeyword(nodes: (Keyword,))
                // Keywordの文字列で"always_ff"等を判断する
                return Ok(AlwaysKind::Ff); // ← 要実装: 実際はKeyword文字列で判断
            }
            _ => {}
        }
    }
    Ok(AlwaysKind::Comb)
}

fn extract_clock_reset(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
) -> Result<(Option<ClockInfo>, Option<ResetInfo>), Box<dyn std::error::Error>> {
    // always_ff @(posedge clk or negedge rst_n)
    // EventExpressionOr の中に EventExpressionExpression が2つ入る
    // 各々に EdgeIdentifier (posedge/negedge) と HierarchicalIdentifier がある

    let mut clock = None;
    let mut reset = None;

    for node in always {
        if let RefNode::EventExpressionExpression(expr) = node {
            let edge_kind = if unwrap_node!(expr, EdgeIdentifierPosedge).is_some() {
                EdgeKind::Posedge
            } else if unwrap_node!(expr, EdgeIdentifierNegedge).is_some() {
                EdgeKind::Negedge
            } else {
                continue;
            };

            let sig_node = match unwrap_node!(expr, SimpleIdentifier) {
                Some(n) => n,
                None => continue,
            };
            let sig_name = get_str(tree, sig_node)?;

            // 慣例: negedge はリセット、posedge はクロック
            // rst/reset を含む名前もリセット判定
            let lower = sig_name.to_lowercase();
            if edge_kind == EdgeKind::Negedge
                || lower.contains("rst")
                || lower.contains("reset")
            {
                reset = Some(ResetInfo {
                    signal_name: sig_name,
                    active_low: edge_kind == EdgeKind::Negedge,
                });
            } else {
                clock = Some(ClockInfo {
                    signal_name: sig_name,
                    edge: edge_kind,
                });
            }
        }
    }

    Ok((clock, reset))
}

fn extract_driven_signals(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
    kind: &AlwaysKind,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let mut signals = Vec::new();

    for node in always {
        match kind {
            AlwaysKind::Ff => {
                // always_ff: ノンブロッキング代入 <=
                // NonblockingAssignment の左辺
                if let RefNode::NonblockingAssignmentVariable(lhs) = node {
                    if let Some(sig) = unwrap_node!(lhs, SimpleIdentifier) {
                        if let Ok(name) = get_str(tree, sig) {
                            if !signals.contains(&name) {
                                signals.push(name);
                            }
                        }
                    }
                }
            }
            AlwaysKind::Comb | AlwaysKind::Latch => {
                // always_comb/latch: ブロッキング代入 =
                if let RefNode::BlockingAssignmentVariable(lhs) = node {
                    if let Some(sig) = unwrap_node!(lhs, SimpleIdentifier) {
                        if let Ok(name) = get_str(tree, sig) {
                            if !signals.contains(&name) {
                                signals.push(name);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(signals)
}
```

---

## 信号宣言・assign変換 — `src/signal.rs`

```rust
use sv_parser::{
    ModuleDeclarationAnsi, RefNode, SyntaxTree,
    unwrap_node,
};
use crate::types::{SignalNode, SignalKind, AssignNode};
use crate::module::get_str;

pub fn lower_signals_and_assigns(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    source: &str,
) -> Result<(Vec<SignalNode>, Vec<AssignNode>), Box<dyn std::error::Error>> {
    let mut signals = Vec::new();
    let mut assigns = Vec::new();

    for node in m {
        match node {
            // ローカル信号宣言: logic [N:0] sig_name;
            // keyword_forbidden_wire_reg でlogicのみ、
            // DataDeclarationVariable として現れる
            RefNode::DataDeclarationVariable(decl) => {
                let data_type = extract_data_type_str_from_decl(decl, tree)?;

                // 複数の変数名が1宣言に入ることがある (a, b, c)
                for node in decl {
                    if let RefNode::VariableDeclAssignment(va) = node {
                        if let Some(name_node) = unwrap_node!(va, VariableIdentifier) {
                            let name = get_str(tree, name_node)?;
                            signals.push(SignalNode {
                                name,
                                data_type: data_type.clone(),
                                kind: SignalKind::Variable,
                            });
                        }
                    }
                }
            }

            // localparam宣言
            RefNode::LocalParameterDeclarationParam(lp) => {
                let data_type = extract_lp_type_str(lp, tree)?;
                for node in lp {
                    if let RefNode::ParamAssignment(pa) = node {
                        if let Some(name_node) = unwrap_node!(pa, ParameterIdentifier) {
                            let name = get_str(tree, name_node)?;
                            signals.push(SignalNode {
                                name,
                                data_type: data_type.clone(),
                                kind: SignalKind::LocalParam,
                            });
                        }
                    }
                }
            }

            // assign文: assign a = b & c;
            // ContinuousAssignVariable として現れる
            // (keyword_forbidden_wire_reg でNetAssignは排除済み)
            RefNode::ContinuousAssignVariable(ca) => {
                for node in ca {
                    if let RefNode::VariableAssignment(va) = node {
                        // 左辺
                        let lhs_node = unwrap_node!(va, SimpleIdentifier)
                            .ok_or("missing lhs in assign")?;
                        let lhs = get_str(tree, lhs_node)?;

                        // 右辺（Expression全体を文字列として取得）
                        let rhs = extract_rhs_str(va, tree, source)?;

                        assigns.push(AssignNode { lhs, rhs });
                    }
                }
            }

            _ => {}
        }
    }

    Ok((signals, assigns))
}

fn extract_data_type_str_from_decl(
    decl: &sv_parser::DataDeclarationVariable,
    tree: &SyntaxTree,
) -> Result<String, Box<dyn std::error::Error>> {
    // DataTypeVector を探してソース文字列から取得
    use sv_parser::unwrap_locate;
    for node in decl {
        if let RefNode::DataTypeVector(dt) = node {
            if let Some(loc) = unwrap_locate!(RefNode::DataTypeVector(dt.clone())) {
                if let Some(s) = tree.get_str(loc) {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    Ok("logic".to_string())
}

fn extract_lp_type_str(
    lp: &sv_parser::LocalParameterDeclarationParam,
    tree: &SyntaxTree,
) -> Result<String, Box<dyn std::error::Error>> {
    use sv_parser::unwrap_locate;
    for node in lp {
        if let RefNode::DataTypeVector(dt) = node {
            if let Some(loc) = unwrap_locate!(RefNode::DataTypeVector(dt.clone())) {
                if let Some(s) = tree.get_str(loc) {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    Ok("int".to_string())
}

fn extract_rhs_str(
    va: &sv_parser::VariableAssignment,
    tree: &SyntaxTree,
    source: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    // Expression全体をLocateで範囲取得してソースから切り出す
    use sv_parser::unwrap_locate;
    for node in va {
        if let RefNode::Expression(expr) = node {
            if let Some(loc) = unwrap_locate!(RefNode::Expression(expr.clone())) {
                if let Some(s) = tree.get_str(loc) {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    Ok(String::new())
}
```

---

## テスト — `tests/integration.rs`

```rust
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

    // ポートチェック
    assert_eq!(m.ports.len(), 3);
    assert_eq!(m.ports[0].name, "clk");
    assert_eq!(m.ports[0].direction, PortDirection::Input);
    assert_eq!(m.ports[2].name, "count");
    assert_eq!(m.ports[2].direction, PortDirection::Output);

    // always_ffチェック
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

    // インスタンスチェック
    assert_eq!(m.instances.len(), 1);
    let inst = &m.instances[0];
    assert_eq!(inst.module_name, "counter");
    assert_eq!(inst.instance_name, "u_counter");

    // パラメータ上書きチェック
    assert_eq!(inst.param_overrides.len(), 1);
    assert_eq!(inst.param_overrides[0].param_name, "WIDTH");
    assert_eq!(inst.param_overrides[0].value, "8");

    // ポート接続チェック
    assert_eq!(inst.port_connections.len(), 3);
    let clk_conn = inst.port_connections.iter().find(|c| c.port_name == "clk").unwrap();
    assert_eq!(clk_conn.signal, "clk");
}

#[test]
fn test_signal_declarations() {
    let tree = lower(TOP_SV, "top.sv").expect("lower failed");
    let m = &tree.modules[0];

    // `logic [7:0] cnt;` が取れているか
    assert_eq!(m.signals.len(), 1);
    assert_eq!(m.signals[0].name, "cnt");
    assert_eq!(m.signals[0].kind, SignalKind::Variable);
}
```

---

## 実装上の注意点

### sv-parserのイテレータの挙動
`for node in m { ... }` は `ModuleDeclarationAnsi` 全体をDFSでトラバースする。
深いノードまで降りるため、**同じノードを複数回処理しないように注意**。
例えば `ModuleInstantiation` をキャッチした後、
その中でさらに `ModuleIdentifier` を探す場合は
`for node in inst { ... }` と入れ子にする。

### `unwrap_locate!` マクロ
型情報をソース文字列として取得する最も単純な方法。
`RefNode::DataTypeVector` 等をそのまま渡すと
そのノードの開始Locateが返る。
ただし**終端Locateは返らない**ため、
完全な文字列範囲を取りたい場合は
`tree.get_str(locate)` の返値が途中で切れることがある。
複雑な型表現（`logic [WIDTH-1:0]`等）は
ノードのトラバースで各トークンを連結する方が確実。

### AlwaysKeywordの種別判定
`AlwaysKeyword` は内部に `Keyword` 構造体を持ち、
`Keyword.nodes.0` がLocateになる。
`tree.get_str(locate)` で `"always_ff"` 等の文字列が得られるので
それでmatchする:

```rust
RefNode::AlwaysKeyword(kw) => {
    use sv_parser::unwrap_locate;
    if let Some(loc) = unwrap_locate!(RefNode::AlwaysKeyword(kw.clone())) {
        match tree.get_str(loc) {
            Some("always_ff")    => return Ok(AlwaysKind::Ff),
            Some("always_comb")  => return Ok(AlwaysKind::Comb),
            Some("always_latch") => return Ok(AlwaysKind::Latch),
            _ => {}
        }
    }
}
```

### EdgeIdentifier の正しいノード名
sv-parser 0.13.5 では `EdgeIdentifierPosedge` / `EdgeIdentifierNegedge` ではなく
`EdgeIdentifier` 1種類で、内部のKeywordで判断する場合がある。
コンパイルエラーが出たら `RefNode::EdgeIdentifier(e)` でキャッチして
`tree.get_str(locate)` で `"posedge"` / `"negedge"` を確認すること。

---

## 実装順序

```
1. src/types.rs を作成 → cargo check
2. src/lib.rs, src/lower.rs の骨格 → cargo check
3. src/module.rs → cargo check
4. src/port.rs → cargo test test_counter_module (ポートのみ確認)
5. src/instance.rs → cargo test test_top_module_instances
6. src/signal.rs → cargo test test_signal_declarations
7. src/always.rs → cargo test test_counter_module (always確認)
8. cargo test で全テストグリーン確認
```
