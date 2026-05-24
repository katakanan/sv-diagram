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
pub fn lower(source: &str, filename: &str) -> Result<DiagramTree, LowerError> {
    let path = Path::new(filename);
    let defines = HashMap::new();
    let includes: Vec<std::path::PathBuf> = vec![];

    let (syntax_tree, _) = parse_sv_str(source, path, &defines, &includes, false, false)
        .map_err(|e| LowerError::ParseError(e.to_string()))?;

    lower::lower_tree(&syntax_tree, source)
        .map_err(|e| LowerError::LowerError(e.to_string()))
}
