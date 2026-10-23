//! The bytes Felix Metro commits: tick records (with keyframes), builder
//! commands and city registry entries.
//!
//! Every record starts with a kind byte that names its layout, so a layout
//! change gets a new kind. Fixed fields are little-endian; ids, counts and
//! ticks that are usually small are LEB128 varints, and lists of ids are
//! zigzag deltas. Layouts are in `docs/design.md`.
//!
//! Events and keyframe resident entries are a tag, a length and a body, so a
//! reader skips a tag it does not know and ignores bytes appended to a body it
//! does. Header flag bits select the layout and stay strict. Decoding never
//! panics: truncated bytes, unknown kinds, short bodies, bad UTF-8, trailing
//! bytes and non-canonical varints are all errors.

mod codec;
mod json;
mod wire;

#[cfg(test)]
mod tests;

pub use codec::{TICK_HEADER_LEN, building_diffs};

/// Kind byte of a tick record.
pub const KIND_TICK: u8 = 1;
/// Kind byte of a command record.
pub const KIND_COMMAND: u8 = 2;
/// Kind byte of a registry record.
pub const KIND_REGISTRY: u8 = 3;

/// Header flag: the record carries a keyframe before its events.
pub const FLAG_KEYFRAME: u8 = 1;

/// Longest string in a record, in bytes. Encoding refuses longer ones.
pub const MAX_STR: usize = 64;

/// Highest [`Vehicle::progress`]: the end of its leg, in thousandths.
pub const MAX_PROGRESS: u16 = 1000;

/// A building kind that means the lot is empty.
pub const NO_BUILDING: u16 = u16::MAX;

/// `road` event and keyframe road diff changes.
pub const ROAD_CLOSED: u8 = 0;
pub const ROAD_OPENED: u8 = 1;
pub const ROAD_ADDED: u8 = 2;
pub const ROAD_REMOVED: u8 = 3;

/// Why a record could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// The bytes end before the record does.
    Truncated,
    /// Bytes remain after the record.
    Trailing,
    /// The leading kind byte is not one this build knows.
    UnknownKind(u8),
    /// An event, command or state tag is not one this build knows.
    UnknownTag(u8),
    /// A value is out of range or malformed.
    Invalid(&'static str),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Truncated => f.write_str("record is truncated"),
            DecodeError::Trailing => f.write_str("bytes follow the record"),
            DecodeError::UnknownKind(k) => write!(f, "unknown record kind {k}"),
            DecodeError::UnknownTag(t) => write!(f, "unknown tag {t}"),
            DecodeError::Invalid(why) => write!(f, "invalid record: {why}"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// Why a record could not be written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// A tick record holds at most 65535 events.
    TooManyEvents,
    /// A name, seed or parent is over [`MAX_STR`] bytes.
    StringTooLong,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EncodeError::TooManyEvents => f.write_str("a tick record holds at most 65535 events"),
            EncodeError::StringTooLong => {
                write!(f, "a string in a record is at most {MAX_STR} bytes")
            }
        }
    }
}

impl std::error::Error for EncodeError {}

/// Any record this crate reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record {
    Tick(TickRecord),
    Command(CommandRecord),
    Registry(RegistryRecord),
}

impl Record {
    /// Reads one record by its kind byte.
    pub fn decode(bytes: &[u8]) -> Result<Record, DecodeError> {
        match bytes.first() {
            None => Err(DecodeError::Truncated),
            Some(&KIND_TICK) => TickRecord::decode(bytes).map(Record::Tick),
            Some(&KIND_COMMAND) => CommandRecord::decode(bytes).map(Record::Command),
            Some(&KIND_REGISTRY) => RegistryRecord::decode(bytes).map(Record::Registry),
            Some(&k) => Err(DecodeError::UnknownKind(k)),
        }
    }

    /// The record as JSON, for the browser. See [`TickRecord::to_json`].
    pub fn to_json(&self) -> String {
        match self {
            Record::Tick(r) => r.to_json(),
            Record::Command(r) => r.to_json(),
            Record::Registry(r) => r.to_json(),
        }
    }
}

/// What every tick record starts with. `speed` is ticks per second.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub epoch: u32,
    pub district: u16,
    pub tick: u32,
    pub speed: u8,
    /// Offset of the district's latest keyframe; a keyframe record names itself.
    pub keyframe_offset: u64,
    /// Wall clock at commit, microseconds since the Unix epoch.
    pub wall_us: u64,
}

/// One district's record for one tick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TickRecord {
    pub header: Header,
    pub keyframe: Option<Keyframe>,
    /// Events with an unknown tag are skipped on decode, so a reader never
    /// sees them.
    pub events: Vec<Event>,
}

/// One road segment of a route and the speed to take it at, as a percentage
/// of the segment class's speed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub segment: u32,
    pub speed: u8,
}

/// A vehicle mid-journey: what it is, how far along its first leg it is in
/// thousandths, and the legs left.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vehicle {
    pub kind: u8,
    pub progress: u16,
    pub route: Vec<Leg>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Trip {
        resident: u32,
        vehicle: u8,
        depart: u32,
        route: Vec<Leg>,
    },
    Replan {
        resident: u32,
        from_segment: u32,
        route: Vec<Leg>,
    },
    Arrived {
        resident: u32,
        lot: u32,
    },
    Activity {
        resident: u32,
        kind: u8,
        until: u32,
    },
    /// Crossed out of this district into `district`.
    Left {
        resident: u32,
        district: u16,
        vehicle: Vehicle,
    },
    /// Crossed into this district from `district`.
    Entered {
        resident: u32,
        district: u16,
        vehicle: Vehicle,
    },
    Built {
        lot: u32,
        kind: u16,
        rotation: u8,
    },
    Demolished {
        lot: u32,
        kind: u16,
        rotation: u8,
    },
    Road {
        segment: u32,
        change: u8,
    },
    Command {
        principal: u64,
        name: String,
        id: u32,
        result: u8,
    },
    Speed {
        ticks_per_second: u8,
    },
}

/// A district's state at one tick, drawable with nothing before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyframe {
    /// Lots that differ from the generated city.
    pub buildings: Vec<BuildingDiff>,
    /// Segments closed or added since generation.
    pub roads: Vec<RoadDiff>,
    pub residents: Vec<ResidentState>,
    pub counts: Counts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildingDiff {
    pub lot: u32,
    /// A building kind, or [`NO_BUILDING`].
    pub kind: u16,
    pub rotation: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoadDiff {
    pub segment: u32,
    pub change: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentState {
    pub id: u32,
    pub doing: Doing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Doing {
    /// Doing `kind` inside `lot` until the tick `until`.
    Activity {
        kind: u8,
        lot: u32,
        until: u32,
    },
    Trip(Vehicle),
}

/// Residents by what they are doing, for the stats sparkline.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub home: u32,
    pub at_work: u32,
    pub on_road: u32,
    pub asleep: u32,
}

/// A builder's command, as published to the city's command stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandRecord {
    pub id: u32,
    /// The builder's display name; the gateway stamps who they are.
    pub name: String,
    pub command: Command,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// A road between two intersections, by node index.
    PlaceRoad {
        a: u32,
        b: u32,
    },
    Zone {
        lot: u32,
        zone: u8,
    },
    Build {
        lot: u32,
        kind: u16,
        rotation: u8,
    },
    Demolish {
        lot: u32,
    },
    Speed {
        ticks_per_second: u8,
    },
    Fork {
        tick: u32,
        name: String,
    },
}

/// An entry in the `metro.cities` registry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryRecord {
    Created {
        name: String,
        seed: String,
        districts: u16,
        wall_us: u64,
    },
    Forked {
        name: String,
        parent: String,
        tick: u32,
        wall_us: u64,
    },
}

impl TickRecord {
    /// Fails on more than 65535 events or a string over [`MAX_STR`] bytes.
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        codec::encode_tick(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<TickRecord, DecodeError> {
        codec::decode_tick(bytes)
    }

    /// Camel-case JSON with a `"kind":"tick"` field. Offsets and times are
    /// numbers (below 2^53 in practice); a principal hash is 16 hex digits.
    pub fn to_json(&self) -> String {
        json::tick(self)
    }
}

impl CommandRecord {
    /// Fails on a name over [`MAX_STR`] bytes.
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        codec::encode_command(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<CommandRecord, DecodeError> {
        codec::decode_command(bytes)
    }

    pub fn to_json(&self) -> String {
        json::command(self)
    }
}

impl RegistryRecord {
    /// Fails on a string over [`MAX_STR`] bytes.
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        codec::encode_registry(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<RegistryRecord, DecodeError> {
        codec::decode_registry(bytes)
    }

    pub fn to_json(&self) -> String {
        json::registry(self)
    }
}

/// Reads a record and returns it as JSON.
pub fn decode_json(bytes: &[u8]) -> Result<String, DecodeError> {
    Ok(Record::decode(bytes)?.to_json())
}
