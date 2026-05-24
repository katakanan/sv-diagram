use sv_parser::{ModuleDeclarationAnsi, RefNode, SyntaxTree, unwrap_node};
use crate::types::{AlwaysNode, AlwaysKind, ClockInfo, ResetInfo, EdgeKind};
use crate::module::get_str;

pub fn lower_always_blocks(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    _source: &str,
) -> Result<Vec<AlwaysNode>, Box<dyn std::error::Error>> {
    let mut always_blocks = Vec::new();

    for node in m {
        if let RefNode::AlwaysConstruct(always) = node {
            let kind = extract_always_kind(always, tree)?;

            let (clock, reset) = if kind == AlwaysKind::Ff {
                extract_clock_reset(always, tree)?
            } else {
                (None, None)
            };

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
    tree: &SyntaxTree,
) -> Result<AlwaysKind, Box<dyn std::error::Error>> {
    use sv_parser::unwrap_locate;
    for node in always {
        if let RefNode::AlwaysKeyword(kw) = node {
            if let Some(loc) = unwrap_locate!(kw) {
                match tree.get_str(loc) {
                    Some("always_ff")    => return Ok(AlwaysKind::Ff),
                    Some("always_comb")  => return Ok(AlwaysKind::Comb),
                    Some("always_latch") => return Ok(AlwaysKind::Latch),
                    _ => {}
                }
            }
        }
    }
    Ok(AlwaysKind::Comb)
}

fn extract_clock_reset(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
) -> Result<(Option<ClockInfo>, Option<ResetInfo>), Box<dyn std::error::Error>> {
    let mut clock = None;
    let mut reset = None;

    for node in always {
        if let RefNode::EventExpressionExpression(expr) = node {
            let edge_kind = extract_edge_kind(expr, tree);
            let edge_kind = match edge_kind {
                Some(e) => e,
                None => continue,
            };

            let sig_node = match unwrap_node!(expr, SimpleIdentifier) {
                Some(n) => n,
                None => continue,
            };
            let sig_name = get_str(tree, sig_node)?;

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

fn extract_edge_kind(
    expr: &sv_parser::EventExpressionExpression,
    tree: &SyntaxTree,
) -> Option<EdgeKind> {
    use sv_parser::unwrap_locate;
    for node in expr {
        if let RefNode::EdgeIdentifier(e) = node {
            if let Some(loc) = unwrap_locate!(e) {
                match tree.get_str(loc) {
                    Some("posedge") => return Some(EdgeKind::Posedge),
                    Some("negedge") => return Some(EdgeKind::Negedge),
                    _ => {}
                }
            }
        }
    }
    None
}

fn extract_driven_signals(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
    kind: &AlwaysKind,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let mut signals: Vec<String> = Vec::new();

    for node in always {
        match kind {
            AlwaysKind::Ff => {
                if let RefNode::NonblockingAssignment(nba) = node {
                    if let Some(sig) = unwrap_node!(nba, SimpleIdentifier) {
                        if let Ok(name) = get_str(tree, sig) {
                            if !signals.contains(&name) {
                                signals.push(name);
                            }
                        }
                    }
                }
            }
            AlwaysKind::Comb | AlwaysKind::Latch => {
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
