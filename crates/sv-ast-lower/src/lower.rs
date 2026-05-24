use sv_parser::{RefNode, SyntaxTree};
use crate::types::{DiagramTree, ModuleNode};
use crate::module::lower_module_ansi;

pub fn lower_tree(
    tree: &SyntaxTree,
    source: &str,
) -> Result<DiagramTree, Box<dyn std::error::Error>> {
    let mut modules: Vec<ModuleNode> = Vec::new();

    for node in tree {
        if let RefNode::ModuleDeclarationAnsi(m) = node {
            if let Some(module) = lower_module_ansi(m, tree, source)? {
                modules.push(module);
            }
        }
    }

    Ok(DiagramTree { modules })
}
