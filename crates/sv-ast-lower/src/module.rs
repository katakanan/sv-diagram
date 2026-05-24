use sv_parser::{ModuleDeclarationAnsi, RefNode, SyntaxTree, unwrap_node};
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
    let name_node = unwrap_node!(m, ModuleIdentifier)
        .ok_or("missing ModuleIdentifier")?;
    let name = get_str(tree, name_node)?;

    let ports = lower_ports(m, tree, source)?;
    let parameters = vec![];
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
        generates: vec![],
    }))
}

pub fn get_str(tree: &SyntaxTree, node: RefNode) -> Result<String, Box<dyn std::error::Error>> {
    use sv_parser::unwrap_locate;
    let locate = unwrap_locate!(node.clone()).ok_or("no Locate found")?;
    let s = tree.get_str(locate).ok_or("get_str failed")?;
    Ok(s.to_string())
}
