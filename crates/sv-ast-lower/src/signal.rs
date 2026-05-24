use sv_parser::{ModuleDeclarationAnsi, RefNode, SyntaxTree, unwrap_node};
use crate::types::{SignalNode, SignalKind, AssignNode};
use crate::module::get_str;

pub fn lower_signals_and_assigns(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    _source: &str,
) -> Result<(Vec<SignalNode>, Vec<AssignNode>), Box<dyn std::error::Error>> {
    let mut signals = Vec::new();
    let mut assigns = Vec::new();

    for node in m {
        match node {
            RefNode::DataDeclarationVariable(decl) => {
                let data_type = extract_data_type_str_from_decl(decl, tree)?;

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

            RefNode::ContinuousAssignNet(ca) => {
                for node in ca {
                    if let RefNode::NetAssignment(na) = node {
                        let lhs_node = unwrap_node!(na, SimpleIdentifier)
                            .ok_or("missing lhs in assign")?;
                        let lhs = get_str(tree, lhs_node)?;

                        let rhs = extract_rhs_from_net_assign(na, tree)?;

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
    use sv_parser::unwrap_locate;
    for node in decl {
        if let RefNode::DataTypeVector(dt) = node {
            if let Some(loc) = unwrap_locate!(dt) {
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
            if let Some(loc) = unwrap_locate!(dt) {
                if let Some(s) = tree.get_str(loc) {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    Ok("int".to_string())
}

fn extract_rhs_from_net_assign(
    na: &sv_parser::NetAssignment,
    tree: &SyntaxTree,
) -> Result<String, Box<dyn std::error::Error>> {
    use sv_parser::Locate;

    for outer in na {
        if let RefNode::Expression(expr) = outer {
            // Expression 内の全 Locate を走査してスパン全体を求める。
            // unwrap_locate! は先頭トークンしか返さないため、
            // 複数トークンの式（a + b、sel ? a : b 等）ではスパンが足りない。
            let mut min_offset = usize::MAX;
            let mut max_end    = 0usize;

            for inner in expr {
                if let RefNode::Locate(loc) = inner {
                    if loc.offset < min_offset { min_offset = loc.offset; }
                    let end = loc.offset + loc.len;
                    if end > max_end { max_end = end; }
                }
            }

            if min_offset < usize::MAX && max_end > min_offset {
                let span = Locate { offset: min_offset, len: max_end - min_offset, line: 0 };
                if let Some(s) = tree.get_str(&span) {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    Ok(String::new())
}
