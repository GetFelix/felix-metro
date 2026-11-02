//! The bytes Felix Metro commits: tick records (with keyframes), builder
//! commands and city registry entries.
//!
//! Every record starts with a kind byte that names its layout, so a layout
//! change gets a new kind. Fixed fields are little-endian; ids, counts and
//! ticks that are usually small are LEB128 varints, and lists of ids are
//! zigzag deltas. Layouts are in `docs/design.md`.
//!
//! Events and keyframe resident entries are one varint holding the body length
//! and a tag, then the body, so a reader skips a tag it does not know and
//! ignores bytes appended to a body it does. Header flag bits select the layout and stay strict. Decoding never
//! panics: truncated bytes, unknown kinds, short bodies, bad UTF-8, trailing
//! bytes and non-canonical varints are all errors.

mod codec;
mod json;
mod wire;

#[cfg(test)]
mod tests;

pub use codec::building_diffs;

/// Kind byte of a tick record. Kind 1 was the layout before the compact one and is refused.
pub const KIND_TICK: u8 = 4;
/// Kind byte of a command record.
pub const KIND_COMMAND: u8 = 2;
/// Kind byte of a registry record.
pub const KIND_REGISTRY: u8 = 3;
/// Kind byte of a day's timeline markers.
pub const KIND_MARKERS: u8 = 5;

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

/// Timeline marker kinds: a building went up, one came down, a road changed.
pub const MARK_BUILT: u8 = 1;
pub const MARK_DEMOLISHED: u8 = 2;
pub const MARK_ROAD: u8 = 3;

/// `command` event results. 0 is applied; everything else is a refusal that
/// changed nothing in the city.
pub const RESULT_APPLIED: u8 = 0;
/// The record did not decode, or its name or fields were out of range.
pub const REFUSED_MALFORMED: u8 = 1;
/// A lot or node index past the end of the city.
pub const REFUSED_UNKNOWN: u8 = 2;
/// `build` on a lot that already has a building.
pub const REFUSED_OCCUPIED: u8 = 3;
/// `demolish` on a lot with nothing on it.
pub const REFUSED_EMPTY: u8 = 4;
/// `build` with a kind or rotation the city has no model for.
pub const REFUSED_BAD_KIND: u8 = 5;
/// `speed` other than 0, 4, 8 or 16.
pub const REFUSED_BAD_SPEED: u8 = 6;
/// A command this build of the sim does not carry out yet.
pub const REFUSED_UNSUPPORTED: u8 = 7;
/// `demolish` on a building residents live or work in.
pub const REFUSED_IN_USE: u8 = 8;
/// Sent while the city was paused with more commands waiting than the sim
/// holds. Not carried out; send it again.
pub const REFUSED_BUSY: u8 = 9;
/// `build` or `demolish` that the city's account cannot pay for.
pub const REFUSED_NO_FUNDS: u8 = 10;
/// `place road` between a node and itself, or two nodes not in one row or column.
pub const REFUSED_NOT_STRAIGHT: u8 = 22;
/// `place road` longer than 12 tiles.
pub const REFUSED_TOO_LONG: u8 = 23;
/// `place road` between two nodes a road already joins.
pub const REFUSED_ROAD_EXISTS: u8 = 24;
/// `place road` over a tile that is not bare ground or has a road beside it, or
/// `build` on a lot a road covers.
pub const REFUSED_ROAD_BLOCKED: u8 = 25;
/// `remove road` of a segment that is generated or already removed.
pub const REFUSED_NOT_BUILT: u8 = 26;

/// `policy` command result: the same policy changed less than a cooldown ago.
pub const REFUSED_COOLDOWN: u8 = 11;
/// `policy` command that sets a policy to the value it already has.
pub const REFUSED_UNCHANGED: u8 = 12;

/// `ledger` event reasons.
/// A city day's taxes in, and road and building upkeep out.
pub const LEDGER_DAY: u8 = 0;
/// The price of a `build` that was applied.
pub const LEDGER_BUILD: u8 = 1;
/// The price of a `demolish` that was applied.
pub const LEDGER_DEMOLISH: u8 = 2;

/// Factions of the council, in the order a `council` event lists them.
/// The people who drive or walk to work or school.
pub const FACTION_COMMUTERS: usize = 0;
/// The people who live in the shore districts, or everywhere in a city with no shore.
pub const FACTION_RESIDENTS: usize = 1;
/// The shops.
pub const FACTION_BUSINESS: usize = 2;
/// How many factions there are.
pub const FACTIONS: usize = 3;

/// Policies, in the order a `policy` event lists them.
/// Hours the shops stay open past their usual close, 0 to 3. Shopkeepers go home that much later, and
/// each shop pays that much more business tax.
pub const POLICY_SHOP_HOURS: usize = 0;
/// The speed limit on avenues, in percent of their speed, 30 to 100.
pub const POLICY_AVENUE_LIMIT: usize = 1;
/// The speed limit on streets, in percent of their speed, 30 to 100.
pub const POLICY_STREET_LIMIT: usize = 2;
/// How many policies there are.
pub const POLICIES: usize = 3;

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
    Markers(MarkersRecord),
}

impl Record {
    /// Reads one record by its kind byte.
    pub fn decode(bytes: &[u8]) -> Result<Record, DecodeError> {
        match bytes.first() {
            None => Err(DecodeError::Truncated),
            Some(&KIND_TICK) => TickRecord::decode(bytes).map(Record::Tick),
            Some(&KIND_COMMAND) => CommandRecord::decode(bytes).map(Record::Command),
            Some(&KIND_REGISTRY) => RegistryRecord::decode(bytes).map(Record::Registry),
            Some(&KIND_MARKERS) => MarkersRecord::decode(bytes).map(Record::Markers),
            Some(&k) => Err(DecodeError::UnknownKind(k)),
        }
    }

    /// The record as JSON, for the browser. See [`TickRecord::to_json`].
    pub fn to_json(&self) -> String {
        match self {
            Record::Tick(r) => r.to_json(),
            Record::Command(r) => r.to_json(),
            Record::Registry(r) => r.to_json(),
            Record::Markers(r) => r.to_json(),
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
    /// A vehicle was moved to `node` and sent on `route` from there, because a
    /// road on its way was removed. `vehicle` is the trip's: 0 on foot.
    Replan {
        resident: u32,
        vehicle: u8,
        node: u32,
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
    /// Reserved for closing and opening roads; nothing writes it.
    Road {
        segment: u32,
        change: u8,
    },
    /// A builder added or removed a road: `change` is [`ROAD_ADDED`] or
    /// [`ROAD_REMOVED`], and `a` and `b` are the segment's nodes.
    Roadwork {
        segment: u32,
        change: u8,
        a: u32,
        b: u32,
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
    /// The offset on the command stream the sim reads next: every command
    /// before it has been applied. Every district's record carries it on a
    /// keyframe tick and on a tick that applied commands, so a sim that
    /// restarts picks the stream up exactly there.
    CommandCursor {
        next: u64,
    },
    /// Money moved in or out of the city's account in this district: a day's
    /// taxes and upkeep, or the price of a build or demolition. `earned` and
    /// `spent` are whole units, never negative; `reason` is a `LEDGER_*`.
    Ledger {
        reason: u8,
        earned: u64,
        spent: u64,
    },
    /// This district's share of the account at the end of the tick, written
    /// on every keyframe tick. The city's balance is the sum over districts,
    /// so each district can be followed on its own.
    Balance {
        amount: i64,
    },
    /// Where the council's factions stand, written by district 0 on every
    /// keyframe tick. `days` is how many city days have been scored; until the
    /// first one is, the standings are not real. `tally` is the open day's
    /// running totals, which a sim that restarts continues from.
    Council {
        days: u32,
        /// Days a faction can stay unhappy before the council recalls the mayor.
        patience: u8,
        standings: [Standing; FACTIONS],
        tally: Tally,
    },
    /// The city's policies as they stand, in the order of [`POLICIES`]. District
    /// 0 writes it when a `policy` command changes one and on every keyframe
    /// tick once any has changed, so a sim that restarts reads the values and their cooldowns.
    Policy {
        settings: [PolicySetting; POLICIES],
    },
}

/// One policy's value and when it last changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicySetting {
    /// The policy's value, in the units of its kind.
    pub value: u8,
    /// The tick of the last change, or `None` if it has never changed.
    pub changed: Option<u32>,
}

/// One faction's standing after the last scored day. The units of `demand`
/// and `measure` are the faction's own: commuters in ticks of average commute,
/// residents in percent of them living away from factories, business in shop visits
/// a day per shop.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Standing {
    /// What the faction asks for.
    pub demand: u32,
    /// What the last scored day gave it.
    pub measure: u32,
    /// 0 to 100, from `measure` against `demand`.
    pub satisfaction: u8,
    /// Scored days in a row with `satisfaction` below the unhappy threshold.
    pub unhappy_days: u8,
}

/// What a city day has added up so far toward its score.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// Trips to work or school that have arrived.
    pub commutes: u32,
    /// The ticks those trips took, added up.
    pub commute_ticks: u64,
    /// Arrivals at a shop.
    pub visits: u32,
}

/// A district's state at one tick, drawable with nothing before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyframe {
    /// Lots that differ from the generated city.
    pub buildings: Vec<BuildingDiff>,
    /// The roads builders added, live or since removed, by segment.
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
    /// [`ROAD_ADDED`] or [`ROAD_REMOVED`].
    pub change: u8,
    /// The segment's nodes.
    pub a: u32,
    pub b: u32,
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
    /// Sets policy `kind` (a `POLICY_` index) to `value`.
    Policy {
        kind: u8,
        value: u8,
    },
    /// Takes away a road a builder added, by segment id.
    RemoveRoad {
        segment: u32,
    },
}

/// The 64-bit hash of a Felix principal that a `command` event carries: FNV-1a
/// over its UTF-8 bytes. It names who built without putting the principal in
/// the log; the same principal always gives the same hash.
pub fn principal_hash(principal: &str) -> u64 {
    principal.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// Splits a payload the gateway stamped (`stamp_sender`): a big-endian `u16`
/// length, the publisher's principal, then the record. `None` when the stamp is
/// missing, cut short or not UTF-8.
pub fn split_stamp(payload: &[u8]) -> Option<(&str, &[u8])> {
    let len = usize::from(u16::from_be_bytes([*payload.first()?, *payload.get(1)?]));
    let principal = std::str::from_utf8(payload.get(2..2 + len)?).ok()?;
    Some((principal, &payload[2 + len..]))
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

/// A moment the timeline marks: a builder changed the city.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Marker {
    pub tick: u32,
    /// [`MARK_BUILT`], [`MARK_DEMOLISHED`] or [`MARK_ROAD`].
    pub kind: u8,
    /// The lot, or for a road the segment.
    pub subject: u32,
    /// The building kind, or for a road the change ([`ROAD_CLOSED`] and the rest).
    pub what: u16,
    /// The builder's display name; empty when the change had no builder.
    pub by: String,
}

/// The markers of one city day (`tick / TICKS_PER_DAY`), in the order they happened. The sim keeps each day's list
/// in the events stream's state, in the same commit as the tick that added to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkersRecord {
    pub day: u32,
    pub markers: Vec<Marker>,
}

impl MarkersRecord {
    /// Fails on a name over [`MAX_STR`] bytes.
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        codec::encode_markers(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<MarkersRecord, DecodeError> {
        codec::decode_markers(bytes)
    }

    pub fn to_json(&self) -> String {
        json::markers(self)
    }
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
