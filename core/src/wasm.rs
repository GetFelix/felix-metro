//! The browser's view of the crate.

use wasm_bindgen::prelude::*;

fn city(seed: &str, districts_per_side: u16) -> Result<crate::City, JsError> {
    crate::City::generate(seed, districts_per_side).map_err(|e| JsError::new(&e.to_string()))
}

/// The generated city as one JSON string: lot, segment and node rows with
/// their column names, so the page can parse it once and draw from arrays.
/// Throws when the seed or district count is not allowed. See
/// [`crate::City::to_json`].
#[wasm_bindgen]
pub fn generate(seed: &str, districts_per_side: u16) -> Result<String, JsError> {
    Ok(city(seed, districts_per_side)?.to_json())
}

/// [`crate::City::hash`] as 16 hex digits.
#[wasm_bindgen]
pub fn hash(seed: &str, districts_per_side: u16) -> Result<String, JsError> {
    Ok(format!("{:016x}", city(seed, districts_per_side)?.hash()))
}

/// [`crate::resident_name`].
#[wasm_bindgen(js_name = residentName)]
pub fn resident_name(seed: &str, index: u32) -> String {
    crate::resident_name(seed, index)
}

/// Any record as one JSON string (see [`crate::record::Record::to_json`]); the
/// `kind` field says which. Throws when the bytes are not exactly one record.
#[wasm_bindgen(js_name = decodeRecord)]
pub fn decode_record(bytes: &[u8]) -> Result<String, JsError> {
    crate::record::decode_json(bytes).map_err(|e| JsError::new(&e.to_string()))
}
