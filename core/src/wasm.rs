//! The browser's view of the crate.

use std::{collections::HashMap, rc::Rc};

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

/// A city and its residents, for turning `trip` events into positions.
#[wasm_bindgen]
pub struct Metro {
    city: Rc<crate::City>,
    places: crate::Places,
    residents: HashMap<u32, Option<crate::Resident>>,
}

#[wasm_bindgen]
impl Metro {
    /// Throws when the seed or district count is not allowed.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &str, districts_per_side: u16) -> Result<Metro, JsError> {
        let city = city(seed, districts_per_side)?;
        let places = crate::Places::new(&city);
        Ok(Metro {
            city: Rc::new(city),
            places,
            residents: HashMap::new(),
        })
    }

    /// The trip a `trip` event describes, or `undefined` when the resident has
    /// no trip with these legs. `route` is segment and speed pairs, flat, as
    /// in the event; `vehicle` 0 is on foot.
    pub fn trip(
        &mut self,
        resident: u32,
        vehicle: u8,
        depart: u32,
        route: &[u32],
    ) -> Option<Journey> {
        let legs: Vec<_> = route
            .chunks_exact(2)
            .map(|p| crate::record::Leg {
                segment: p[0],
                speed: p[1] as u8,
            })
            .collect();
        let (city, places) = (&self.city, &self.places);
        let known = self.residents.entry(resident).or_insert_with(|| {
            (resident < places.population())
                .then(|| crate::Resident::new(city, places, resident))
                .flatten()
        });
        let mode = if vehicle == 0 {
            crate::Mode::Walk
        } else {
            crate::Mode::Drive
        };
        let (trip, from_lot, to_lot) = known
            .as_ref()?
            .trip_between_lots(city, depart, &legs, mode)?;
        Some(Journey {
            city: Rc::clone(&self.city),
            trip,
            lots: [from_lot, to_lot],
        })
    }
}

/// One trip, placed by tick.
#[wasm_bindgen]
pub struct Journey {
    city: Rc<crate::City>,
    trip: crate::Trip,
    lots: [u32; 2],
}

#[wasm_bindgen]
impl Journey {
    /// The tick the trip ends.
    pub fn arrive(&self) -> u32 {
        self.trip.arrive()
    }

    /// Writes the ids of the lot the trip leaves and the lot it enters into `out`.
    pub fn lots(&self, out: &mut [u32]) {
        if let [from, to, ..] = out {
            *from = self.lots[0];
            *to = self.lots[1];
        }
    }

    /// Writes thousandths of a tile from the city's north-west corner, x then z, into `out`.
    #[wasm_bindgen(js_name = positionAt)]
    pub fn position_at(&self, tick: u32, out: &mut [u32]) {
        let p = self.trip.position_at(&self.city, tick);
        if let [x, z, ..] = out {
            *x = p.x;
            *z = p.z;
        }
    }
}
