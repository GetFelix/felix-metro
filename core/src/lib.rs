//! The rules of Felix Metro, with no I/O. The sim links this natively and the
//! browser loads it as WebAssembly, so both run the same code.
//!
//! Everything is integer arithmetic, so a city generated from a seed is the
//! same on every platform.

pub mod city;
pub mod kinds;
pub mod names;
pub mod record;
mod rng;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use city::{
    City, District, Door, GenerateError, Lot, RoadPiece, RoadTile, Segment, SegmentClass, Zone,
};
pub use kinds::{BuildingKind, KINDS, KindInfo};
pub use names::resident_name;
