//! The simulation: the authority for each city. It steps every district of a
//! city in lockstep and commits one record per district per tick to Felix.

pub mod commands;
pub mod control;
pub mod felix;
mod latency;
pub mod markers;
pub mod registry;
mod resume;
pub mod runner;
mod world;

pub use commands::{Incoming, commands_stream, follow as follow_commands};
pub use control::{SPEEDS, StartRequest, check_speed, serve as serve_speed_control};
pub use felix::{Connection, FelixLog, connect, events_stream};
pub use markers::Marked;
pub use registry::{REGISTRY_STREAM, announce, announce_later};
pub use resume::History;
pub use runner::{
    Done, Log, Settings, Write, load_history, run_city, run_city_with, run_with_history,
};
pub use world::state_at;
