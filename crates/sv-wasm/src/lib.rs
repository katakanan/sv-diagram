use wasm_bindgen::prelude::*;

/// パニック時にブラウザコンソールへスタックトレースを出力
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// SV ソース文字列を DiagramTree の JSON 文字列に変換する
///
/// 成功時: DiagramTree の JSON 文字列
/// 失敗時: JsValue::from_str(エラーメッセージ)
#[wasm_bindgen]
pub fn lower_sv(source: &str) -> Result<String, JsValue> {
    sv_ast_lower::lower(source, "input.sv")
        .map(|tree| serde_json::to_string(&tree).expect("serialization failed"))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
