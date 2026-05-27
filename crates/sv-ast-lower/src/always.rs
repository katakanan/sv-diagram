use sv_parser::{ModuleDeclarationAnsi, RefNode, SyntaxTree, unwrap_node};
use crate::types::{AlwaysNode, AlwaysKind, ClockInfo, ResetInfo, EdgeKind, Expr, Stmt};
use crate::module::get_str;

pub fn lower_always_blocks(
    m: &ModuleDeclarationAnsi,
    tree: &SyntaxTree,
    source: &str,
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

            let clock_name = clock.as_ref().map(|c| c.signal_name.as_str());
            let reset_name = reset.as_ref().map(|r| r.signal_name.as_str());
            let read_signals = extract_read_signals(
                always, tree, &driven_signals, clock_name, reset_name,
            )?;

            let body = lower_body(always, tree, source, &kind);

            always_blocks.push(AlwaysNode {
                kind,
                clock,
                reset,
                driven_signals,
                read_signals,
                body,
            });
        }
    }

    Ok(always_blocks)
}

// ─── always kind ──────────────────────────────────────────────────────────

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

// ─── clock / reset ────────────────────────────────────────────────────────

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

// ─── driven / read signals ────────────────────────────────────────────────

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
                if let RefNode::BlockingAssignment(ba) = node {
                    if let Some(sig) = unwrap_node!(ba, SimpleIdentifier) {
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

fn extract_read_signals(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
    driven: &[String],
    clock_name: Option<&str>,
    reset_name: Option<&str>,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use std::collections::HashSet;

    let exclude: HashSet<&str> = driven.iter().map(String::as_str)
        .chain(clock_name)
        .chain(reset_name)
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut signals: Vec<String> = Vec::new();

    for node in always {
        if let RefNode::SimpleIdentifier(_) = node {
            if let Ok(name) = get_str(tree, node) {
                if !exclude.contains(name.as_str()) && !seen.contains(&name) {
                    seen.insert(name.clone());
                    signals.push(name);
                }
            }
        }
    }

    Ok(signals)
}

// ─── body AST ─────────────────────────────────────────────────────────────

/// always 本体を Vec<Stmt> に変換する（ベストエフォート）。
///
/// 戦略:
///   1. DFS で ConditionalStatement / NonblockingAssignment / BlockingAssignment を収集し
///      ソースオフセットを記録する。
///   2. ConditionalStatement のうち、他の CS の内部に含まれないものを「トップレベル」とし
///      再帰的に Stmt::If に変換する。
///   3. 直接（CS の外側に）現れる代入を Stmt::Nb/BAssign に変換する。
///   4. 変換できない部分は Stmt::NbAssign / Stmt::BAssign の rhs を Expr::Raw で保持する。
fn lower_body(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
    source: &str,
    kind: &AlwaysKind,
) -> Vec<Stmt> {
    use sv_parser::unwrap_locate;

    // ─ 全 ConditionalStatement と代入文を (offset, node) で収集 ──────
    let mut cond_items: Vec<(usize, usize)> = Vec::new(); // (start, end_hint)
    let mut nb_assigns: Vec<(usize, &sv_parser::NonblockingAssignment)> = Vec::new();
    let mut b_assigns:  Vec<(usize, &sv_parser::BlockingAssignment)>    = Vec::new();

    // 全 CS のオフセットを先に把握する（包含判定用）
    for node in always {
        if let RefNode::ConditionalStatement(cs) = node {
            if let Some(loc) = unwrap_locate!(cs) {
                // end_hint: CS 内の最大 offset を後で更新する仮値
                cond_items.push((loc.offset, loc.offset));
            }
        }
    }

    // 各 CS の「スパン末尾」を、その CS に含まれる最大トークン位置から推定する
    let mut cond_spans: Vec<(usize, usize)> = Vec::new(); // (start, end_exclusive)
    {
        // CS 開始位置をソートして管理
        let mut cs_starts: Vec<usize> = cond_items.iter().map(|(s, _)| *s).collect();
        cs_starts.sort();

        // DFS で各 CS の中にあるトークンを調べてスパンを計算する
        // 簡便のため: 各 CS のスパン = start ～ (次の CS start の直前 or always 末尾)
        // これは近似だが DFS 順で問題になるケースが少ない
        for node in always {
            if let RefNode::ConditionalStatement(cs) = node {
                if let Some(loc) = unwrap_locate!(cs) {
                    let cs_start = loc.offset;
                    // CS 内の全トークン末尾 = max(offset + len)
                    let mut max_end = cs_start + loc.len;
                    for sub in cs {
                        if let Some(sub_loc) = unwrap_locate!(sub) {
                            let end = sub_loc.offset + sub_loc.len;
                            if end > max_end { max_end = end; }
                        }
                    }
                    cond_spans.push((cs_start, max_end));
                }
            }
        }
    }

    // ─ 代入文を収集 ──────────────────────────────────────────────────
    for node in always {
        if let RefNode::NonblockingAssignment(nba) = &node {
            if let Some(loc) = unwrap_locate!(*nba) {
                nb_assigns.push((loc.offset, *nba));
            }
        }
        if let RefNode::BlockingAssignment(ba) = &node {
            if let Some(loc) = unwrap_locate!(*ba) {
                b_assigns.push((loc.offset, *ba));
            }
        }
    }

    // ─ 包含チェック: あるオフセットが別の CS スパン内にあるか ────────
    let inside_any_cs = |off: usize, self_start: Option<usize>| -> bool {
        cond_spans.iter().any(|(cs_s, cs_e)| {
            if let Some(ss) = self_start {
                if *cs_s == ss { return false; } // 自分自身のスパンは除外
            }
            off >= *cs_s && off < *cs_e
        })
    };

    // ─ トップレベルの CS を特定（他の CS に含まれないもの）──────────
    let top_cs_starts: Vec<usize> = cond_spans.iter()
        .filter(|(s, _)| !inside_any_cs(*s, Some(*s)))
        .map(|(s, _)| *s)
        .collect();

    // ─ トップレベルの代入（CS の外側）─────────────────────────────
    let top_nb: Vec<&sv_parser::NonblockingAssignment> = nb_assigns.iter()
        .filter(|(off, _)| !inside_any_cs(*off, None))
        .map(|(_, nba)| *nba)
        .collect();
    let top_b: Vec<&sv_parser::BlockingAssignment> = b_assigns.iter()
        .filter(|(off, _)| !inside_any_cs(*off, None))
        .map(|(_, ba)| *ba)
        .collect();

    // ─ 結果を組み立て ───────────────────────────────────────────────
    let mut stmts: Vec<Stmt> = Vec::new();

    // トップレベル CS を変換
    for cs_start in &top_cs_starts {
        // AlwaysConstruct DFS から該当 CS を再取得
        for node in always {
            if let RefNode::ConditionalStatement(cs) = node {
                if let Some(loc) = unwrap_locate!(cs) {
                    if loc.offset == *cs_start {
                        stmts.push(lower_cond(cs, tree, source, &cond_spans, kind));
                        break;
                    }
                }
            }
        }
    }

    // トップレベル代入
    for nba in top_nb {
        stmts.push(lower_nb_assign(nba, tree, source));
    }
    for ba in top_b {
        stmts.push(lower_b_assign(ba, tree, source));
    }

    stmts
}

/// ConditionalStatement → Stmt::If
fn lower_cond(
    cs: &sv_parser::ConditionalStatement,
    tree: &SyntaxTree,
    source: &str,
    all_spans: &[(usize, usize)],
    kind: &AlwaysKind,
) -> Stmt {
    use sv_parser::unwrap_locate;

    // ─ 自身のスパン ────────────────────────────────────────────────
    let cs_start = unwrap_locate!(cs)
        .map(|l| l.offset)
        .unwrap_or(0);

    // ─ 条件式: CondPredicate のソーステキストを Raw で取得 ─────────
    let cond = extract_cond_pred_raw(cs, source)
        .map(Expr::Raw)
        .unwrap_or(Expr::Raw("?".to_string()));

    // ─ else キーワードのオフセットを探す ──────────────────────────
    let else_off = find_else_offset(cs, tree);

    // ─ この CS 内の代入 / 子 CS を収集 ────────────────────────────
    let mut nb_here: Vec<(usize, &sv_parser::NonblockingAssignment)> = Vec::new();
    let mut b_here:  Vec<(usize, &sv_parser::BlockingAssignment)>    = Vec::new();
    let mut child_cs: Vec<(usize, &sv_parser::ConditionalStatement)> = Vec::new();

    for node in cs {
        match &node {
            RefNode::NonblockingAssignment(nba) => {
                if let Some(loc) = unwrap_locate!(*nba) {
                    nb_here.push((loc.offset, *nba));
                }
            }
            RefNode::BlockingAssignment(ba) => {
                if let Some(loc) = unwrap_locate!(*ba) {
                    b_here.push((loc.offset, *ba));
                }
            }
            RefNode::ConditionalStatement(child) => {
                if let Some(loc) = unwrap_locate!(*child) {
                    if loc.offset != cs_start {
                        child_cs.push((loc.offset, *child));
                    }
                }
            }
            _ => {}
        }
    }

    // 直接の子 CS (子 CS に含まれないもの)
    let direct_child_cs: Vec<_> = child_cs.iter()
        .filter(|(off, _)| {
            !child_cs.iter().any(|(cs_s, _)| {
                let cs_e = all_spans.iter().find(|(s, _)| *s == *cs_s).map(|(_, e)| *e).unwrap_or(*cs_s);
                *off != *cs_s && *off >= *cs_s && *off < cs_e
            })
        })
        .collect();

    // ─ then / else に振り分け ──────────────────────────────────────
    let split = |off: usize| -> bool {
        else_off.map(|e| off < e).unwrap_or(true)
    };

    let mut then_: Vec<Stmt> = Vec::new();
    let mut else_: Vec<Stmt> = Vec::new();

    // 代入
    for (off, nba) in &nb_here {
        // 子 CS に含まれていたら直接追加しない
        let in_child = direct_child_cs.iter().any(|(cs_s, _)| {
            let cs_e = all_spans.iter().find(|(s, _)| s == cs_s).map(|(_, e)| *e).unwrap_or(*cs_s);
            *off >= *cs_s && *off < cs_e
        });
        if in_child { continue; }
        let stmt = lower_nb_assign(*nba, tree, source);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }
    for (off, ba) in &b_here {
        let in_child = direct_child_cs.iter().any(|(cs_s, _)| {
            let cs_e = all_spans.iter().find(|(s, _)| s == cs_s).map(|(_, e)| *e).unwrap_or(*cs_s);
            *off >= *cs_s && *off < cs_e
        });
        if in_child { continue; }
        let stmt = lower_b_assign(*ba, tree, source);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }

    // 子 CS
    for (off, child) in &direct_child_cs {
        let stmt = lower_cond(child, tree, source, all_spans, kind);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }

    Stmt::If { cond, then_, else_ }
}

/// ConditionalStatement の CondPredicate（if の条件式）を source から取得する。
/// if (...) の括弧内テキストを返す。
fn extract_cond_pred_raw(
    cs: &sv_parser::ConditionalStatement,
    source: &str,
) -> Option<String> {
    use sv_parser::unwrap_locate;
    for node in cs {
        if let RefNode::CondPredicate(cp) = node {
            if let Some(loc) = unwrap_locate!(cp) {
                // CondPredicate の先頭から括弧内コンテンツを取得
                return Some(extract_paren_content(source, loc.offset));
            }
        }
    }
    None
}

/// `source[start..]` から括弧の中身（`if (` の直後）を取り出す。
/// start は `(` の直前のトークン先頭か `if` キーワード周辺を想定。
/// 実際には if文の条件 = `if (` ... `)` なので、最初の `(` から対応する `)` を探す。
fn extract_paren_content(source: &str, _start: usize) -> String {
    // CondPredicate 自体のオフセットから直接テキストを取る方が正確だが、
    // unwrap_locate! が単一トークンしか返さないため、
    // 安全な Raw フォールバックとしてトークン文字列のみを返す。
    // 詳細な実装は将来の拡張ポイント。
    source.get(_start..)
        .and_then(|s| {
            // '(' を探してネストカウントでペアを探す
            let paren_start = s.find('(')?;
            let inner = &s[paren_start + 1..];
            let mut depth = 1usize;
            let mut end = 0usize;
            for (i, c) in inner.char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 { end = i; break; }
                    }
                    _ => {}
                }
            }
            if depth == 0 { Some(inner[..end].trim().to_string()) }
            else { None }
        })
        .unwrap_or_default()
}

/// "else" キーワードのソースオフセットを CS 内から探す。
fn find_else_offset(
    cs: &sv_parser::ConditionalStatement,
    tree: &SyntaxTree,
) -> Option<usize> {
    use sv_parser::unwrap_locate;
    for node in cs {
        if let RefNode::Keyword(kw) = node {
            if let Some(loc) = unwrap_locate!(kw) {
                if tree.get_str(loc) == Some("else") {
                    return Some(loc.offset);
                }
            }
        }
    }
    None
}

// ─── 個別代入の変換 ───────────────────────────────────────────────────────

fn lower_nb_assign(
    nba: &sv_parser::NonblockingAssignment,
    tree: &SyntaxTree,
    source: &str,
) -> Stmt {
    // LHS: 最初の SimpleIdentifier
    let lhs = unwrap_node!(nba, SimpleIdentifier)
        .and_then(|n| get_str(tree, n).ok())
        .unwrap_or_default();

    // RHS: Expression ノードのスパンを source から切り出す
    let rhs = extract_expr_from_nb(nba, tree, source);

    Stmt::NbAssign { lhs, rhs }
}

fn lower_b_assign(
    ba: &sv_parser::BlockingAssignment,
    tree: &SyntaxTree,
    source: &str,
) -> Stmt {
    let lhs = unwrap_node!(ba, SimpleIdentifier)
        .and_then(|n| get_str(tree, n).ok())
        .unwrap_or_default();
    let rhs = extract_expr_from_b(ba, tree, source);
    Stmt::BAssign { lhs, rhs }
}

/// NonblockingAssignment の RHS を Expr に変換する。
fn extract_expr_from_nb(
    nba: &sv_parser::NonblockingAssignment,
    tree: &SyntaxTree,
    source: &str,
) -> Expr {
    use sv_parser::unwrap_locate;
    // Expression ノードのトークン先頭 + max 末尾でスパンを取る
    let mut min_off = usize::MAX;
    let mut max_end = 0usize;
    let mut found   = false;

    for node in nba {
        if let RefNode::Expression(_) = &node {
            // 最初の Expression に限定（LHS の expression が先に来ることがあるため
            // "<=" の後の expression のみを取りたい）
            // 簡便のため: 全 Expression トークンのスパンを取り最大を RHS と見なす
            found = true;
        }
        if found {
            if let Some(loc) = unwrap_locate!(node.clone()) {
                if loc.offset < min_off { min_off = loc.offset; }
                let end = loc.offset + loc.len;
                if end > max_end { max_end = end; }
            }
        }
    }

    if min_off < usize::MAX {
        if let Some(s) = source.get(min_off..max_end) {
            let trimmed = s.trim().to_string();
            if !trimmed.is_empty() {
                return build_expr_simple(&trimmed);
            }
        }
    }

    // フォールバック: 全 SimpleIdentifier / IntegralNumber から再構成
    fallback_expr(nba, tree)
}

fn extract_expr_from_b(
    ba: &sv_parser::BlockingAssignment,
    tree: &SyntaxTree,
    source: &str,
) -> Expr {
    use sv_parser::unwrap_locate;
    let mut min_off = usize::MAX;
    let mut max_end = 0usize;
    let mut found   = false;

    for node in ba {
        if let RefNode::Expression(_) = &node { found = true; }
        if found {
            if let Some(loc) = unwrap_locate!(node.clone()) {
                if loc.offset < min_off { min_off = loc.offset; }
                let end = loc.offset + loc.len;
                if end > max_end { max_end = end; }
            }
        }
    }

    if min_off < usize::MAX {
        if let Some(s) = source.get(min_off..max_end) {
            let trimmed = s.trim().to_string();
            if !trimmed.is_empty() {
                return build_expr_simple(&trimmed);
            }
        }
    }

    fallback_expr(ba, tree)
}

/// 単純な識別子 or リテラルなら Ident/Lit、それ以外は Raw を返す。
fn build_expr_simple(s: &str) -> Expr {
    let s = s.trim();
    // 単純識別子: [a-zA-Z_][a-zA-Z0-9_$]*
    if s.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    {
        return Expr::Ident(s.to_string());
    }
    Expr::Raw(s.to_string())
}

/// NonblockingAssignment 内の SimpleIdentifier / IntegralNumber から Expr を推測する。
fn fallback_expr<'a, T>(node: T, tree: &SyntaxTree) -> Expr
where
    T: IntoIterator<Item = RefNode<'a>>,
{
    let mut parts = Vec::new();
    for n in node {
        match &n {
            RefNode::SimpleIdentifier(_) => {
                if let Ok(s) = get_str(tree, n) { parts.push(s); }
            }
            RefNode::IntegralNumber(_) | RefNode::UnbasedUnsizedLiteral(_) => {
                if let Ok(s) = get_str(tree, n) { parts.push(s); }
            }
            _ => {}
        }
    }
    if parts.len() == 1 {
        build_expr_simple(&parts[0])
    } else if parts.is_empty() {
        Expr::Raw(String::new())
    } else {
        Expr::Raw(parts.join(" "))
    }
}
