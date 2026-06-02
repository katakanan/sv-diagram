use sv_parser::{RefNode, SyntaxTree, unwrap_node};
use crate::types::{AlwaysNode, AlwaysKind, ClockInfo, ResetInfo, EdgeKind, Expr, Stmt};
use crate::module::get_str;

/// `ModuleDeclarationAnsi` と `ModuleDeclarationNonansi` の両方に対応できるよう
/// HRTB (Higher-Rank Trait Bound) を使って汎用化している。
pub fn lower_always_blocks<M>(
    m: &M,
    tree: &SyntaxTree,
    source: &str,
) -> Result<Vec<AlwaysNode>, Box<dyn std::error::Error>>
where
    for<'a> &'a M: IntoIterator<Item = RefNode<'a>>,
{
    let mut always_blocks = Vec::new();

    for node in m {
        match node {
            // ── always_ff / always_comb / always_latch / plain always ──
            RefNode::AlwaysConstruct(always) => {
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

                let half_period = if kind == AlwaysKind::ClkGen {
                    extract_half_period(always, tree, source)
                } else {
                    None
                };

                let driver_value = if kind == AlwaysKind::DcDriver {
                    extract_driver_value(always, tree, source)
                } else {
                    None
                };

                always_blocks.push(AlwaysNode {
                    kind,
                    clock,
                    reset,
                    driven_signals,
                    read_signals,
                    body,
                    half_period,
                    driver_value,
                });
            }

            // ── initial begin ... end ──────────────────────────────────
            RefNode::InitialConstruct(initial) => {
                let driven_signals = extract_initial_driven(initial, tree)?;
                let read_signals   = extract_initial_read(initial, tree, &driven_signals)?;
                always_blocks.push(AlwaysNode {
                    kind: AlwaysKind::Initial,
                    clock:          None,
                    reset:          None,
                    driven_signals,
                    read_signals,
                    body:           vec![],
                    half_period:    None,
                    driver_value:   None,
                });
            }

            _ => {}
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
                    // plain `always` → DelayControl の有無とトグル演算子で分類
                    Some("always")       => return Ok(detect_plain_always_kind(always, tree)),
                    _ => {}
                }
            }
        }
    }
    Ok(AlwaysKind::Comb)
}

/// plain `always` ブロックの種別を判定する。
///
/// - `always @(posedge/negedge ...)` → Ff（always_ff 相当）
/// - `always #N sig = ~sig` (または `!sig`)  → ClkGen
/// - `always #N sig = val`                    → DcDriver
/// - それ以外                                 → Comb (フォールバック)
fn detect_plain_always_kind(
    always: &sv_parser::AlwaysConstruct,
    tree: &SyntaxTree,
) -> AlwaysKind {
    use sv_parser::unwrap_locate;

    // エッジセンシティビティリスト @(posedge/negedge ...) → Ff 相当
    for node in always {
        if let RefNode::EdgeIdentifier(_) = node {
            return AlwaysKind::Ff;
        }
    }

    // トグル演算子 (~ または !) が本体内に存在する → ClkGen
    for node in always {
        if let RefNode::UnaryOperator(uo) = node {
            if let Some(loc) = unwrap_locate!(uo) {
                if matches!(tree.get_str(loc), Some("~") | Some("!")) {
                    return AlwaysKind::ClkGen;
                }
            }
        }
    }

    // DelayControl が存在する → DcDriver
    for node in always {
        if let RefNode::DelayControl(_) = node {
            return AlwaysKind::DcDriver;
        }
    }

    AlwaysKind::Comb
}

/// `always #N` の N 部分を source から取得する。
///
/// DelayControl ノードのスパンを source から切り出し、先頭の `#` と
/// 空白を除去して返す（例: "#5" → "5", "# 10" → "10"）。
fn extract_half_period(
    always: &sv_parser::AlwaysConstruct,
    _tree: &SyntaxTree,
    source: &str,
) -> Option<String> {
    use sv_parser::unwrap_locate;

    for node in always {
        if let RefNode::DelayControl(dc) = node {
            let mut min_off = usize::MAX;
            let mut max_end = 0usize;
            for sub in dc {
                if let Some(loc) = unwrap_locate!(sub) {
                    if loc.offset < min_off { min_off = loc.offset; }
                    let end = loc.offset + loc.len;
                    if end > max_end { max_end = end; }
                }
            }
            if min_off < usize::MAX {
                if let Some(s) = source.get(min_off..max_end) {
                    // "#5" や "# 10" から '#' と空白を除去
                    let val = s.trim_start_matches('#').trim();
                    if !val.is_empty() {
                        return Some(val.to_string());
                    }
                }
            }
        }
    }
    None
}

/// `always #N sig = val` の val 部分を source から取得する。
///
/// BlockingAssignment 内の最初の Expression スパンを取得する。
fn extract_driver_value(
    always: &sv_parser::AlwaysConstruct,
    _tree: &SyntaxTree,
    source: &str,
) -> Option<String> {
    use sv_parser::unwrap_locate;

    for node in always {
        if let RefNode::BlockingAssignment(ba) = node {
            let mut found_expr = false;
            let mut min_off = usize::MAX;
            let mut max_end = 0usize;

            for sub in ba {
                if let RefNode::Expression(_) = &sub { found_expr = true; }
                if found_expr {
                    if let Some(loc) = unwrap_locate!(sub.clone()) {
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
                        return Some(trimmed);
                    }
                }
            }
            return None;
        }
    }
    None
}

// ─── initial block の入出力抽出 ───────────────────────────────────────────

/// `initial begin ... end` 内でブロッキング代入 (`=`) されている信号名を収集する。
/// これが「出力」＝テストベンチが駆動する信号に相当する。
fn extract_initial_driven(
    initial: &sv_parser::InitialConstruct,
    tree: &SyntaxTree,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let mut signals: Vec<String> = Vec::new();
    for node in initial {
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
    Ok(signals)
}

/// `initial begin ... end` 内で参照される信号名を収集する。
/// ブロッキング代入の左辺（driven）は除外する。
/// イベント制御 `@(posedge clk)` の信号や RHS・$monitor 引数などが対象。
fn extract_initial_read(
    initial: &sv_parser::InitialConstruct,
    tree: &SyntaxTree,
    driven: &[String],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use std::collections::HashSet;
    let exclude: HashSet<&str> = driven.iter().map(String::as_str).collect();
    let mut seen:    HashSet<String> = HashSet::new();
    let mut signals: Vec<String>     = Vec::new();

    for node in initial {
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
            // 名前ベースの判定を優先する:
            //   "clk" / "clock" を含む → クロック（エッジ種別に関わらず）
            //   "rst" / "reset" を含む → リセット
            //   上記に該当しない場合: posedge → クロック、negedge → リセット（フォールバック）
            let is_clock_by_name = lower.contains("clk") || lower.contains("clock");
            let is_reset_by_name = !is_clock_by_name
                && (lower.contains("rst") || lower.contains("reset"));

            if is_clock_by_name {
                clock = Some(ClockInfo {
                    signal_name: sig_name,
                    edge: edge_kind,
                });
            } else if is_reset_by_name {
                reset = Some(ResetInfo {
                    signal_name: sig_name,
                    active_low: edge_kind == EdgeKind::Negedge,
                });
            } else {
                // フォールバック: negedge → リセット、posedge → クロック
                if edge_kind == EdgeKind::Negedge {
                    reset = Some(ResetInfo {
                        signal_name: sig_name,
                        active_low: true,
                    });
                } else {
                    clock = Some(ClockInfo {
                        signal_name: sig_name,
                        edge: edge_kind,
                    });
                }
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
            AlwaysKind::Comb | AlwaysKind::Latch
            | AlwaysKind::ClkGen | AlwaysKind::DcDriver => {
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
            // Initial ブロックは AlwaysConstruct 経由では呼ばれない
            AlwaysKind::Initial => {}
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

    // ─ ConditionalStatement と CaseStatementNormal 両方のスパンを収集 ─
    // これらが「exclusion zone」となり、内部の代入文をトップレベルとみなさない
    let mut excl_spans: Vec<(usize, usize)> = Vec::new();

    for node in always {
        if let RefNode::ConditionalStatement(cs) = node {
            if let Some(loc) = unwrap_locate!(cs) {
                let mut max_end = loc.offset + loc.len;
                for sub in cs {
                    if let Some(sl) = unwrap_locate!(sub) {
                        let e = sl.offset + sl.len;
                        if e > max_end { max_end = e; }
                    }
                }
                excl_spans.push((loc.offset, max_end));
            }
        } else if let RefNode::CaseStatementNormal(cs) = node {
            if let Some(loc) = unwrap_locate!(cs) {
                let mut max_end = loc.offset + loc.len;
                for sub in cs {
                    if let Some(sl) = unwrap_locate!(sub) {
                        let e = sl.offset + sl.len;
                        if e > max_end { max_end = e; }
                    }
                }
                excl_spans.push((loc.offset, max_end));
            }
        }
    }

    // ─ 包含チェック ─────────────────────────────────────────────────
    let inside_any = |off: usize, self_start: Option<usize>| -> bool {
        excl_spans.iter().any(|(s, e)| {
            if let Some(ss) = self_start { if *s == ss { return false; } }
            off >= *s && off < *e
        })
    };

    // ─ トップレベルの制御構造（他のスパン内に含まれないもの）────────
    let top_starts: Vec<usize> = excl_spans.iter()
        .filter(|(s, _)| !inside_any(*s, Some(*s)))
        .map(|(s, _)| *s)
        .collect();

    // ─ 代入文を収集（top-level のみ）─────────────────────────────
    let mut nb_assigns: Vec<(usize, &sv_parser::NonblockingAssignment)> = Vec::new();
    let mut b_assigns:  Vec<(usize, &sv_parser::BlockingAssignment)>    = Vec::new();

    for node in always {
        if let RefNode::NonblockingAssignment(nba) = &node {
            if let Some(loc) = unwrap_locate!(*nba) { nb_assigns.push((loc.offset, *nba)); }
        }
        if let RefNode::BlockingAssignment(ba) = &node {
            if let Some(loc) = unwrap_locate!(*ba) { b_assigns.push((loc.offset, *ba)); }
        }
    }

    let top_nb: Vec<&sv_parser::NonblockingAssignment> = nb_assigns.iter()
        .filter(|(off, _)| !inside_any(*off, None))
        .map(|(_, nba)| *nba)
        .collect();
    let top_b: Vec<&sv_parser::BlockingAssignment> = b_assigns.iter()
        .filter(|(off, _)| !inside_any(*off, None))
        .map(|(_, ba)| *ba)
        .collect();

    // ─ 結果を組み立て ───────────────────────────────────────────────
    let mut stmts: Vec<Stmt> = Vec::new();

    // トップレベル制御構造を変換（offset の昇順に処理）
    let mut sorted_starts = top_starts.clone();
    sorted_starts.sort();

    for start in &sorted_starts {
        let mut found = false;
        // ConditionalStatement を探す
        for node in always {
            if found { break; }
            if let RefNode::ConditionalStatement(cs) = node {
                if let Some(loc) = unwrap_locate!(cs) {
                    if loc.offset == *start {
                        stmts.push(lower_cond(cs, tree, source, &excl_spans, kind));
                        found = true;
                    }
                }
            }
        }
        if found { continue; }
        // CaseStatementNormal を探す
        for node in always {
            if let RefNode::CaseStatementNormal(cs) = node {
                if let Some(loc) = unwrap_locate!(cs) {
                    if loc.offset == *start {
                        stmts.push(lower_case_stmt(cs, tree, source, kind));
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
    let mut nb_here:     Vec<(usize, &sv_parser::NonblockingAssignment)> = Vec::new();
    let mut b_here:      Vec<(usize, &sv_parser::BlockingAssignment)>    = Vec::new();
    let mut child_cs:    Vec<(usize, &sv_parser::ConditionalStatement)>  = Vec::new();
    let mut child_cases: Vec<(usize, &sv_parser::CaseStatementNormal)>   = Vec::new();

    for node in cs {
        match &node {
            RefNode::NonblockingAssignment(nba) => {
                if let Some(loc) = unwrap_locate!(*nba) { nb_here.push((loc.offset, *nba)); }
            }
            RefNode::BlockingAssignment(ba) => {
                if let Some(loc) = unwrap_locate!(*ba) { b_here.push((loc.offset, *ba)); }
            }
            RefNode::ConditionalStatement(child) => {
                if let Some(loc) = unwrap_locate!(*child) {
                    if loc.offset != cs_start { child_cs.push((loc.offset, *child)); }
                }
            }
            RefNode::CaseStatementNormal(child_case) => {
                if let Some(loc) = unwrap_locate!(*child_case) {
                    child_cases.push((loc.offset, *child_case));
                }
            }
            _ => {}
        }
    }

    // 直接の子 CS（他の子 CS スパン内に含まれないもの）
    let direct_child_cs: Vec<_> = child_cs.iter()
        .filter(|(off, _)| {
            !child_cs.iter().any(|(cs_s, _)| {
                let cs_e = all_spans.iter().find(|(s, _)| *s == *cs_s).map(|(_, e)| *e).unwrap_or(*cs_s);
                *off != *cs_s && *off >= *cs_s && *off < cs_e
            })
        })
        .collect();

    // 直接の子 Case（子 CS スパン内に含まれないもの）
    let direct_child_cases: Vec<_> = child_cases.iter()
        .filter(|(off, _)| {
            !direct_child_cs.iter().any(|(cs_s, _)| {
                let cs_e = all_spans.iter().find(|(s, _)| *s == *cs_s).map(|(_, e)| *e).unwrap_or(*cs_s);
                *off >= *cs_s && *off < cs_e
            })
        })
        .collect();

    // ─ then / else に振り分け ──────────────────────────────────────
    let split = |off: usize| -> bool {
        else_off.map(|e| off < e).unwrap_or(true)
    };

    // 子 CS および子 Case のいずれかに含まれるオフセットかチェック
    let in_child = |off: usize| -> bool {
        direct_child_cs.iter().any(|(cs_s, _)| {
            let cs_e = all_spans.iter().find(|(s, _)| *s == *cs_s).map(|(_, e)| *e).unwrap_or(*cs_s);
            off >= *cs_s && off < cs_e
        }) || direct_child_cases.iter().any(|(case_s, _)| {
            let case_e = all_spans.iter().find(|(s, _)| *s == *case_s).map(|(_, e)| *e).unwrap_or(*case_s);
            off >= *case_s && off < case_e
        })
    };

    let mut then_: Vec<Stmt> = Vec::new();
    let mut else_: Vec<Stmt> = Vec::new();

    for (off, nba) in &nb_here {
        if in_child(*off) { continue; }
        let stmt = lower_nb_assign(*nba, tree, source);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }
    for (off, ba) in &b_here {
        if in_child(*off) { continue; }
        let stmt = lower_b_assign(*ba, tree, source);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }

    // 子 CS
    for (off, child) in &direct_child_cs {
        let stmt = lower_cond(child, tree, source, all_spans, kind);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }

    // 子 Case
    for (off, child_case) in &direct_child_cases {
        let stmt = lower_case_stmt(child_case, tree, source, kind);
        if split(*off) { then_.push(stmt); } else { else_.push(stmt); }
    }

    Stmt::If { cond, then_, else_ }
}

/// ConditionalStatement の CondPredicate（if の条件式）を source から取得する。
///
/// CondPredicate の全子トークンを DFS でスキャンして min_offset..max_end のスパンを計算し、
/// そのソース文字列を返す。
///
/// 旧実装は `source[start..].find('(')` でソースを前方探索していたため、
/// CondPredicate が括弧の内側から始まる場合（`if (!rst_n)` の `!rst_n` など）に
/// 全く関係ない箇所の `(` を拾い、別モジュールのポートリスト等を誤って
/// 条件式として返すバグがあった。
fn extract_cond_pred_raw(
    cs: &sv_parser::ConditionalStatement,
    source: &str,
) -> Option<String> {
    use sv_parser::unwrap_locate;
    for node in cs {
        if let RefNode::CondPredicate(cp) = node {
            let mut min_off = usize::MAX;
            let mut max_end = 0usize;
            // CondPredicate 配下の全ノードのスパンを集める
            for sub in cp {
                if let Some(loc) = unwrap_locate!(sub) {
                    if loc.offset < min_off { min_off = loc.offset; }
                    let end = loc.offset + loc.len;
                    if end > max_end { max_end = end; }
                }
            }
            if min_off < usize::MAX {
                return source.get(min_off..max_end).map(|s| s.trim().to_string());
            }
        }
    }
    None
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

// ─── CaseStatementNormal → Stmt::Case ────────────────────────────────────

/// CaseStatementNormal (case/casez/casex) を Stmt::Case に変換する。
fn lower_case_stmt(
    cs: &sv_parser::CaseStatementNormal,
    tree: &SyntaxTree,
    source: &str,
    kind: &AlwaysKind,
) -> Stmt {
    use sv_parser::unwrap_locate;
    use crate::types::CaseItem as CiType;

    // ─ セレクタ式 ─────────────────────────────────────────────────
    let sel = {
        let mut min = usize::MAX;
        let mut max = 0usize;
        for node in cs {
            if let RefNode::CaseExpression(ce) = node {
                for sub in ce {
                    if let Some(loc) = unwrap_locate!(sub) {
                        if loc.offset < min { min = loc.offset; }
                        let e = loc.offset + loc.len;
                        if e > max { max = e; }
                    }
                }
                break; // 最初の CaseExpression のみ
            }
        }
        if min < usize::MAX {
            source.get(min..max)
                .map(|s| build_expr_simple(s.trim()))
                .unwrap_or(Expr::Raw("?".to_string()))
        } else {
            Expr::Raw("?".to_string())
        }
    };

    // ─ アイテムを収集 ─────────────────────────────────────────────
    let mut items:    Vec<CiType> = Vec::new();
    let mut default_: Vec<Stmt>   = Vec::new();

    for node in cs {
        if let RefNode::CaseItemNondefault(ci) = node {
            // パターン文字列（カンマ区切りのアイテム式を結合）
            let pattern = {
                let mut parts = Vec::new();
                for sub in ci {
                    if let RefNode::CaseItemExpression(expr) = sub {
                        let mut mn = usize::MAX;
                        let mut mx = 0usize;
                        for ssub in expr {
                            if let Some(loc) = unwrap_locate!(ssub) {
                                if loc.offset < mn { mn = loc.offset; }
                                let e = loc.offset + loc.len;
                                if e > mx { mx = e; }
                            }
                        }
                        if mn < usize::MAX {
                            if let Some(s) = source.get(mn..mx) {
                                parts.push(s.trim().to_string());
                            }
                        }
                    }
                }
                if parts.is_empty() { String::from("?") } else { parts.join(", ") }
            };
            let stmts = collect_item_stmts(ci, tree, source, kind);
            items.push(CiType { pattern, stmts });
        } else if let RefNode::CaseItemDefault(ci) = node {
            default_ = collect_item_stmts(ci, tree, source, kind);
        }
    }

    Stmt::Case { sel, items, default_ }
}

/// case アイテム内の NbAssign/BAssign を再帰的に収集する。
fn collect_item_stmts<'a, I>(item: I, tree: &SyntaxTree, source: &str, _kind: &AlwaysKind) -> Vec<Stmt>
where
    I: IntoIterator<Item = RefNode<'a>>,
{
    let mut stmts = Vec::new();
    for node in item {
        match node {
            RefNode::NonblockingAssignment(nba) => {
                stmts.push(lower_nb_assign(nba, tree, source));
            }
            RefNode::BlockingAssignment(ba) => {
                stmts.push(lower_b_assign(ba, tree, source));
            }
            _ => {}
        }
    }
    stmts
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
