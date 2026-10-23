//! The browser's view of the crate.

use wasm_bindgen::prelude::*;

/// The generated city as one JSON string: lot, segment and node rows with
/// their column names, so the page can parse it once and draw from arrays.
/// See [`crate::City::to_json`].
#[wasm_bindgen]
pub fn generate(seed: &str, districts_per_side: u16) -> Result<String, JsError> {
    if districts_per_side == 0 || districts_per_side > 16 {
        return Err(JsError::new("districts per side must be 1 to 16"));
    }
    Ok(crate::City::generate(seed, districts_per_side).to_json())
}

/// [`crate::City::hash`] as 16 hex digits.
#[wasm_bindgen]
pub fn hash(seed: &str, districts_per_side: u16) -> Result<String, JsError> {
    if districts_per_side == 0 || districts_per_side > 16 {
        return Err(JsError::new("districts per side must be 1 to 16"));
    }
    Ok(format!(
        "{:016x}",
        crate::City::generate(seed, districts_per_side).hash()
    ))
}

/// [`crate::resident_name`].
#[wasm_bindgen(js_name = residentName)]
pub fn resident_name(seed: &str, index: u32) -> String {
    crate::resident_name(seed, index)
}
