use sv_parser::{RefNode, SyntaxTree};
use crate::types::{DiagramTree, ModuleNode};
use crate::module::{lower_module_ansi, lower_module_nonansi};

pub fn lower_tree(
    tree: &SyntaxTree,
    source: &str,
) -> Result<DiagramTree, Box<dyn std::error::Error>> {
    let mut modules: Vec<ModuleNode> = Vec::new();

    for node in tree {
        match node {
            // ANSI 形式: module foo #(...) (...);
            RefNode::ModuleDeclarationAnsi(m) => {
                if let Some(module) = lower_module_ansi(m, tree, source)? {
                    modules.push(module);
                }
            }
            // 非 ANSI 形式: module foo; (括弧なし、テストベンチ等)
            RefNode::ModuleDeclarationNonansi(m) => {
                if let Some(module) = lower_module_nonansi(m, tree, source)? {
                    modules.push(module);
                }
            }
            _ => {}
        }
    }

    Ok(DiagramTree { modules })
}
