use sv_parser::{ModuleDeclarationAnsi, RefNode, SyntaxTree, unwrap_node};
use crate::types::{PortNode, PortDirection};
use crate::module::get_str;

pub fn lower_ports(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    _source: &str,
) -> Result<Vec<PortNode>, Box<dyn std::error::Error>> {
    let mut ports = Vec::new();

    for node in m {
        match node {
            // `input var logic hoge` — var キーワードあり
            RefNode::AnsiPortDeclarationVariable(port) => {
                let direction = extract_direction_var(port, tree)?;

                let name_node = unwrap_node!(port, PortIdentifier)
                    .ok_or("missing PortIdentifier")?;
                let name = get_str(tree, name_node)?;

                let data_type = extract_data_type_var(port, tree)?;

                ports.push(PortNode { name, direction, data_type });
            }

            // `input logic hoge` — var キーワードなし
            RefNode::AnsiPortDeclarationNet(port) => {
                let direction = extract_direction_net(port, tree)?;

                let name_node = unwrap_node!(port, PortIdentifier)
                    .ok_or("missing PortIdentifier")?;
                let name = get_str(tree, name_node)?;

                let data_type = extract_data_type_net(port, tree)?;

                ports.push(PortNode { name, direction, data_type });
            }

            _ => {}
        }
    }

    Ok(ports)
}

// ─── AnsiPortDeclarationVariable (var あり) ───────────────────────────────

fn extract_direction_var(
    port: &sv_parser::AnsiPortDeclarationVariable,
    _tree: &SyntaxTree,
) -> Result<PortDirection, Box<dyn std::error::Error>> {
    for node in port {
        if let RefNode::PortDirection(pd) = node {
            return match pd {
                sv_parser::PortDirection::Input(_)  => Ok(PortDirection::Input),
                sv_parser::PortDirection::Output(_) => Ok(PortDirection::Output),
                sv_parser::PortDirection::Inout(_)  => Ok(PortDirection::Inout),
                _ => Ok(PortDirection::Input),
            };
        }
    }
    Ok(PortDirection::Input)
}

fn extract_data_type_var(
    port: &sv_parser::AnsiPortDeclarationVariable,
    tree: &SyntaxTree,
) -> Result<String, Box<dyn std::error::Error>> {
    use sv_parser::unwrap_locate;
    for node in port {
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

// ─── AnsiPortDeclarationNet (var なし) ────────────────────────────────────

fn extract_direction_net(
    port: &sv_parser::AnsiPortDeclarationNet,
    _tree: &SyntaxTree,
) -> Result<PortDirection, Box<dyn std::error::Error>> {
    for node in port {
        if let RefNode::PortDirection(pd) = node {
            return match pd {
                sv_parser::PortDirection::Input(_)  => Ok(PortDirection::Input),
                sv_parser::PortDirection::Output(_) => Ok(PortDirection::Output),
                sv_parser::PortDirection::Inout(_)  => Ok(PortDirection::Inout),
                _ => Ok(PortDirection::Input),
            };
        }
    }
    Ok(PortDirection::Input)
}

fn extract_data_type_net(
    port: &sv_parser::AnsiPortDeclarationNet,
    tree: &SyntaxTree,
) -> Result<String, Box<dyn std::error::Error>> {
    use sv_parser::unwrap_locate;
    for node in port {
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
