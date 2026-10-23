//! The rules of Felix Metro, with no I/O. The sim links this natively and the
//! browser loads it as WebAssembly, so both run the same code.
//!
//! Everything is integer arithmetic, so a city generated from a seed is the
//! same on every platform.

pub mod city;
pub mod kinds;
pub mod names;
pub mod record;
pub mod resident;
mod rng;
pub mod route;
pub mod schedule;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use city::{
    City, District, Door, GenerateError, Lot, RoadPiece, RoadTile, Segment, SegmentClass, Zone,
};
pub use kinds::{BuildingKind, KINDS, KindInfo};
pub use names::resident_name;
pub use resident::{Places, Resident, day_hash};
pub use route::{Congestion, Mode, Position, Trip, route};
pub use schedule::{Activity, Archetype, Block, Schedule, TICKS_PER_DAY, TICKS_PER_HOUR};
