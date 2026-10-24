//! The simulation: the authority for each city. It steps every district of a
//! city in lockstep and commits one record per district per tick to Felix.

pub mod control;
pub mod felix;
mod latency;
pub mod registry;
pub mod runner;
mod world;

pub use control::{SPEEDS, check_speed, serve as serve_speed_control};
pub use felix::{Connection, FelixLog, connect, district_keys, events_stream};
pub use registry::{REGISTRY_STREAM, announce};
pub use runner::{Done, Log, Settings, Write, run_city};
