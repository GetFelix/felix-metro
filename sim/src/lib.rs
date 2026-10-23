//! The simulation: the authority for each city. It steps every district of a
//! city in lockstep and commits one record per district per tick to Felix.

pub mod felix;
mod latency;
pub mod runner;
mod world;

pub use felix::{Connection, FelixLog, connect, district_keys, events_stream};
pub use runner::{Done, Log, Settings, Write, run_city};
