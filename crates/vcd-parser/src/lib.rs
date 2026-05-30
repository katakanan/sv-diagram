mod parser;

pub use parser::parse_vcd;

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;

// ─── エラー型 ────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum VcdError {
    #[error("VCD parse error: {0}")]
    Parse(String),
}

// ─── 出力型 ──────────────────────────────────────────────────────────────────

/// VCDファイル全体の解析結果
#[derive(Debug, Serialize, Deserialize)]
pub struct VcdData {
    /// タイムスケール（フェムト秒単位）
    /// 例: 1ns → 1_000_000, 10ps → 10_000
    pub timescale_fs: u64,

    /// 信号定義一覧（スコープ・名前昇順）
    pub signals: Vec<Signal>,

    /// シミュレーション上の最大タイムスタンプ
    pub max_time: u64,

    /// 信号IDコードごとの値変化リスト
    /// キー: VCD IDコード（例: "!", "#"）
    /// 値: [(time, value), ...] （時刻昇順・重複除去済み）
    ///
    /// value の表現:
    ///   1ビット: "0" / "1" / "x" / "z"
    ///   複数ビット: "00001010" 等の2進文字列（MSB first、width文字）
    pub value_changes: HashMap<String, Vec<(u64, String)>>,
}

/// VCD変数（信号）定義
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    /// VCD IDコード（例: "!", "#", "!!"）
    pub id: String,
    /// 変数名（例: "clk", "count"）
    pub name: String,
    /// ドット区切りスコープパス（例: "counter_tb", "counter_tb.u_counter"）
    pub scope: String,
    /// ビット幅
    pub width: u32,
    /// VCD変数型（"wire", "reg", "logic" など）
    pub var_type: String,
}
