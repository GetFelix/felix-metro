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

/// [`crate::day_hash`] as 16 hex digits. Throws when the seed is not allowed or
/// the city has no such resident.
#[wasm_bindgen(js_name = residentDayHash)]
pub fn resident_day_hash(
    seed: &str,
    districts_per_side: u16,
    index: u32,
) -> Result<String, JsError> {
    city(seed, districts_per_side)?;
    crate::day_hash(seed, districts_per_side, index)
        .map(|h| format!("{h:016x}"))
        .ok_or_else(|| JsError::new("no such resident"))
}

/// Any record as one JSON string (see [`crate::record::Record::to_json`]); the
/// `kind` field says which. Throws when the bytes are not exactly one record.
#[wasm_bindgen(js_name = decodeRecord)]
pub fn decode_record(bytes: &[u8]) -> Result<String, JsError> {
    crate::record::decode_json(bytes).map_err(|e| JsError::new(&e.to_string()))
}

/// [`crate::district_key`]: the entity key that puts a district on its own
/// shard. `routing` is Felix's name for the stream's mapping, `modulo` or
/// `jump_hash`. Throws when the stream has no shard for the district.
#[wasm_bindgen(js_name = districtKey)]
pub fn district_key(district: u32, shards: u32, routing: &str) -> Result<String, JsError> {
    let routing =
        crate::Routing::from_name(routing).ok_or_else(|| JsError::new("unknown routing"))?;
    crate::district_key(district, shards, routing)
        .ok_or_else(|| JsError::new("no key puts this district on a shard"))
}
