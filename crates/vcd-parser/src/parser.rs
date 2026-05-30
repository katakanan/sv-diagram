use std::collections::HashMap;
use crate::{Signal, VcdData, VcdError};

// ─── 公開エントリポイント ────────────────────────────────────────────────────

/// VCDテキストを解析して VcdData を返す。
pub fn parse_vcd(input: &str) -> Result<VcdData, VcdError> {
    let mut p = VcdParser::new(input);
    p.parse()
}

// ─── パーサー本体 ────────────────────────────────────────────────────────────

struct VcdParser<'a> {
    src:         &'a [u8],
    pos:         usize,
    scope_stack: Vec<String>,
    /// IDコード → Signal
    signals:     HashMap<String, Signal>,
    timescale_fs: u64,
}

impl<'a> VcdParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            src:          input.as_bytes(),
            pos:          0,
            scope_stack:  Vec::new(),
            signals:      HashMap::new(),
            timescale_fs: 1_000_000, // デフォルト 1 ns
        }
    }

    // ─── メインパース ───────────────────────────────────────────────────────

    fn parse(&mut self) -> Result<VcdData, VcdError> {
        self.parse_header()?;
        let (max_time, mut value_changes) = self.parse_simulation()?;

        // 各信号の値変化リストを時刻昇順に整列し重複を除去
        // 同時刻に複数の変化がある場合は「最後の値」を採用する
        // （$dumpvars の初期値 "x" を #0 の実値で上書きするケースに対応）
        for changes in value_changes.values_mut() {
            changes.sort_by_key(|(t, _)| *t);
            // 逆順で dedup → 先頭側（= 元の末尾 = 最後の変化）が残る
            changes.reverse();
            changes.dedup_by_key(|(t, _)| *t);
            changes.reverse();
        }

        // 信号を収集してスコープ・名前順にソート
        let mut signals: Vec<Signal> = self.signals.values().cloned().collect();
        signals.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));

        Ok(VcdData {
            timescale_fs: self.timescale_fs,
            signals,
            max_time,
            value_changes,
        })
    }

    // ─── ヘッダーセクション ──────────────────────────────────────────────────

    fn parse_header(&mut self) -> Result<(), VcdError> {
        loop {
            let tok = self.next_token()?;
            match tok {
                "$enddefinitions" => {
                    self.expect_end()?;
                    return Ok(());
                }
                "$timescale"  => self.parse_timescale()?,
                "$scope"      => self.parse_scope()?,
                "$upscope"    => { self.expect_end()?; self.scope_stack.pop(); }
                "$var"        => self.parse_var()?,
                "$date" | "$version" | "$comment" => self.skip_to_end()?,
                "" => return Err(VcdError::Parse("unexpected EOF in header".into())),
                tok if tok.starts_with('$') => self.skip_to_end()?,
                _ => {}
            }
        }
    }

    fn parse_timescale(&mut self) -> Result<(), VcdError> {
        // $timescale 1ns $end  または  $timescale 10 ps $end
        let mut parts = Vec::new();
        loop {
            let t = self.next_token()?;
            if t == "$end" { break; }
            if t.is_empty() {
                return Err(VcdError::Parse("unexpected EOF in $timescale".into()));
            }
            parts.push(t.to_owned());
        }
        let combined = parts.join("");
        if let Some(fs) = parse_timescale_str(&combined) {
            self.timescale_fs = fs;
        }
        Ok(())
    }

    fn parse_scope(&mut self) -> Result<(), VcdError> {
        // $scope <type> <name> $end
        let _scope_type = self.next_token()?;
        let name = self.next_token()?.to_owned();
        self.expect_end()?;
        self.scope_stack.push(name);
        Ok(())
    }

    fn parse_var(&mut self) -> Result<(), VcdError> {
        // $var <type> <width> <id_code> <reference> [<bit_select>] $end
        let var_type = self.next_token()?.to_owned();
        let width_str = self.next_token()?;
        let width: u32 = width_str
            .parse()
            .map_err(|_| VcdError::Parse(format!("invalid width: {}", width_str)))?;
        let id = self.next_token()?.to_owned();
        let name_raw = self.next_token()?.to_owned();
        self.skip_to_end()?;

        // "count[7:0]" → "count"
        let name = name_raw
            .split('[')
            .next()
            .unwrap_or(&name_raw)
            .to_owned();

        let scope = self.scope_stack.join(".");

        self.signals.insert(
            id.clone(),
            Signal { id, name, scope, width, var_type },
        );
        Ok(())
    }

    // ─── シミュレーションセクション ─────────────────────────────────────────

    fn parse_simulation(
        &mut self,
    ) -> Result<(u64, HashMap<String, Vec<(u64, String)>>), VcdError> {
        let mut changes: HashMap<String, Vec<(u64, String)>> = HashMap::new();
        let mut current_time: u64 = 0;
        let mut max_time: u64 = 0;

        loop {
            self.skip_whitespace();
            if self.pos >= self.src.len() {
                break;
            }

            let c = self.src[self.pos];

            match c {
                // タイムスタンプ: #<decimal>
                b'#' => {
                    self.pos += 1;
                    let s = self.read_word();
                    current_time = s.parse().map_err(|_| {
                        VcdError::Parse(format!("invalid timestamp: {}", s))
                    })?;
                    if current_time > max_time {
                        max_time = current_time;
                    }
                }
                // スカラー値変化: 0/1/x/z + IDコード
                b'0' | b'1' | b'x' | b'X' | b'z' | b'Z' => {
                    let val = (c as char).to_ascii_lowercase().to_string();
                    self.pos += 1;
                    let id = self.read_word().to_owned();
                    if !id.is_empty() {
                        changes.entry(id).or_default().push((current_time, val));
                    }
                }
                // ベクター値変化: b<binary> <id>
                b'b' | b'B' => {
                    self.pos += 1;
                    let raw_val = self.read_word().to_ascii_lowercase();
                    self.skip_whitespace();
                    let id = self.read_word().to_owned();
                    if !id.is_empty() {
                        // 幅に合わせてゼロ拡張してから格納
                        let val = normalize_vector_value(&raw_val, &self.signals, &id);
                        changes.entry(id).or_default().push((current_time, val));
                    }
                }
                // 実数値変化: r<real> <id>  （表示用にそのまま保持）
                b'r' | b'R' => {
                    self.pos += 1;
                    let raw_val = self.read_word().to_owned();
                    self.skip_whitespace();
                    let id = self.read_word().to_owned();
                    if !id.is_empty() {
                        changes.entry(id).or_default().push((current_time, raw_val));
                    }
                }
                // システムコマンド: $dumpvars / $dumpall / $end 等
                b'$' => {
                    // next_token() は '$' ごと読む
                    let tok = self.next_token()?;
                    match tok {
                        // これらは内部値変化ブロックを持つが $end で閉じる
                        "$dumpvars" | "$dumpall" | "$dumpoff" | "$dumpon" => {
                            // ブロック内の値変化は通常ループで処理されるため
                            // ここでは $end まで読み捨てる（値変化はすでに処理済み）
                            // → 再帰的に処理するため skip しない
                        }
                        "$end" | "" => {}
                        tok if tok.starts_with('$') => {
                            // 未知のコマンドは $end まで読み飛ばす
                            let _ = self.skip_to_end();
                        }
                        _ => {}
                    }
                }
                // その他の文字はスキップ
                _ => {
                    self.pos += 1;
                }
            }
        }

        Ok((max_time, changes))
    }

    // ─── 低レベルヘルパー ────────────────────────────────────────────────────

    fn skip_whitespace(&mut self) {
        while self.pos < self.src.len() {
            match self.src[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    /// 非空白文字列を読む（空白・EOF で終端）
    fn read_word(&mut self) -> &'a str {
        self.skip_whitespace();
        let start = self.pos;
        while self.pos < self.src.len() {
            match self.src[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => break,
                _ => self.pos += 1,
            }
        }
        // UTF-8 境界のズレはないはずだが安全のため
        std::str::from_utf8(&self.src[start..self.pos]).unwrap_or("")
    }

    /// 次のトークンを返す。EOF は "" を返す（エラーにしない）。
    fn next_token(&mut self) -> Result<&'a str, VcdError> {
        Ok(self.read_word())
    }

    fn expect_end(&mut self) -> Result<(), VcdError> {
        let t = self.next_token()?;
        if t == "$end" {
            Ok(())
        } else {
            Err(VcdError::Parse(format!("expected $end, got '{}'", t)))
        }
    }

    fn skip_to_end(&mut self) -> Result<(), VcdError> {
        loop {
            let t = self.next_token()?;
            if t == "$end" { return Ok(()); }
            if t.is_empty() {
                return Err(VcdError::Parse("unexpected EOF looking for $end".into()));
            }
        }
    }
}

// ─── ユーティリティ ──────────────────────────────────────────────────────────

/// "$timescale" 値文字列をフェムト秒単位の整数に変換する。
/// 例: "1ns" → 1_000_000,  "10ps" → 10_000
fn parse_timescale_str(s: &str) -> Option<u64> {
    let s = s.trim();
    // 数値部と単位部を分離
    let split = s
        .find(|c: char| c.is_alphabetic())
        .unwrap_or(s.len());
    let magnitude: u64 = s[..split].trim().parse().ok()?;
    let unit = s[split..].trim().to_lowercase();
    let unit_fs: u64 = match unit.as_str() {
        "fs"          => 1,
        "ps"          => 1_000,
        "ns"          => 1_000_000,
        "us" | "μs"   => 1_000_000_000,
        "ms"          => 1_000_000_000_000,
        "s"           => 1_000_000_000_000_000,
        _             => 1_000_000, // 不明はnsとして扱う
    };
    Some(magnitude * unit_fs)
}

/// ベクター値を信号幅に合わせてゼロ拡張した2進文字列に正規化する。
///
/// VCDのベクター値: "bxxxxxxxx", "b00001010" など先頭 'b' を除いた文字列が raw_val。
/// 信号幅が不明な場合はそのまま返す。
fn normalize_vector_value(
    raw_val: &str,
    signals: &HashMap<String, Signal>,
    id: &str,
) -> String {
    let width = signals
        .get(id)
        .map(|s| s.width as usize)
        .unwrap_or(0);

    if width == 0 || raw_val.len() >= width {
        return raw_val.to_owned();
    }

    // 先頭を '0' でゼロ拡張（x/z の場合は先頭文字を繰り返す）
    let pad_char = match raw_val.chars().next() {
        Some('x') => 'x',
        Some('z') => 'z',
        _         => '0',
    };
    let padding = width - raw_val.len();
    let mut result = String::with_capacity(width);
    for _ in 0..padding {
        result.push(pad_char);
    }
    result.push_str(raw_val);
    result
}

// ─── テスト ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_VCD: &str = r#"
$timescale 1ns $end
$scope module counter_tb $end
  $var wire 1 ! clk $end
  $var wire 1 " rst_n $end
  $scope module u_counter $end
    $var wire 8 # count [7:0] $end
  $upscope $end
$upscope $end
$enddefinitions $end
$dumpvars
x!
x"
xxxxxxxx#
$end
#0
0!
0"
b00000000 #
#5
1!
#10
0!
#15
1!
1"
#25
b00000001 #
#35
b00000010 #
"#;

    #[test]
    fn test_parse_signals() {
        let d = parse_vcd(SAMPLE_VCD).unwrap();
        assert_eq!(d.signals.len(), 3);
        let clk = d.signals.iter().find(|s| s.name == "clk").unwrap();
        assert_eq!(clk.id, "!");
        assert_eq!(clk.scope, "counter_tb");
        assert_eq!(clk.width, 1);

        let count = d.signals.iter().find(|s| s.name == "count").unwrap();
        assert_eq!(count.id, "#");
        assert_eq!(count.scope, "counter_tb.u_counter");
        assert_eq!(count.width, 8);
    }

    #[test]
    fn test_timescale() {
        let d = parse_vcd(SAMPLE_VCD).unwrap();
        assert_eq!(d.timescale_fs, 1_000_000); // 1ns = 1_000_000 fs
    }

    #[test]
    fn test_value_changes() {
        let d = parse_vcd(SAMPLE_VCD).unwrap();
        let clk = d.value_changes.get("!").unwrap();
        // t=0: 0, t=5: 1, t=10: 0, t=15: 1
        assert_eq!(clk[0], (0, "0".to_owned()));
        assert_eq!(clk[1], (5, "1".to_owned()));
        assert_eq!(clk[2], (10, "0".to_owned()));

        let count = d.value_changes.get("#").unwrap();
        assert_eq!(count[0], (0, "00000000".to_owned()));
        assert_eq!(count[1], (25, "00000001".to_owned()));
    }

    #[test]
    fn test_max_time() {
        let d = parse_vcd(SAMPLE_VCD).unwrap();
        assert_eq!(d.max_time, 35);
    }
}
