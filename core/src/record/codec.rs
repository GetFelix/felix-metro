//! Encoding and decoding of each record layout.

use super::wire::{Reader, Writer};
use super::{
    BuildingDiff, Command, CommandRecord, Counts, DecodeError, Doing, EncodeError, Event,
    FLAG_KEYFRAME, Header, KIND_COMMAND, KIND_REGISTRY, KIND_TICK, Keyframe, Leg, MAX_PROGRESS,
    RegistryRecord, ResidentState, RoadDiff, TickRecord, Vehicle,
};
use crate::city::City;

/// Bits of tag in the framing of an event and of a keyframe's resident entry. A tag has to fit.
const EVENT_TAG_BITS: u32 = 4;
const ENTRY_TAG_BITS: u32 = 2;

const EV_TRIP: u8 = 1;
const EV_REPLAN: u8 = 2;
const EV_ARRIVED: u8 = 3;
const EV_ACTIVITY: u8 = 4;
const EV_LEFT: u8 = 5;
const EV_ENTERED: u8 = 6;
const EV_BUILT: u8 = 7;
const EV_DEMOLISHED: u8 = 8;
const EV_ROAD: u8 = 9;
const EV_COMMAND: u8 = 10;
const EV_SPEED: u8 = 11;
const EV_COMMAND_CURSOR: u8 = 12;
/// An `arrived` and the same resident's `activity` that follows it, which is every arrival the sim makes.
const EV_ARRIVAL: u8 = 13;
/// A rare event goes under this tag with a kind varint ahead of its fields, so the few tags that fit
/// [`EVENT_TAG_BITS`] stay for events a tick writes in bulk. Tag 14 is still free.
const EV_EXTENDED: u8 = 15;
const EXT_LEDGER: u64 = 1;
const EXT_BALANCE: u64 = 2;
/// Kinds 3 to 5 are taken by the author, the council and policies.
const EXT_ROADWORK: u64 = 6;

const CMD_PLACE_ROAD: u8 = 1;
const CMD_ZONE: u8 = 2;
const CMD_BUILD: u8 = 3;
const CMD_DEMOLISH: u8 = 4;
const CMD_SPEED: u8 = 5;
const CMD_FORK: u8 = 6;
const CMD_REMOVE_ROAD: u8 = 7;

const REG_CREATED: u8 = 1;
const REG_FORKED: u8 = 2;

const DOING_ACTIVITY: u8 = 0;
const DOING_TRIP: u8 = 1;

/// The lots of `current` whose kind or rotation differs from `city` as
/// generated, which is all a keyframe needs to carry of the buildings.
pub fn building_diffs(city: &City, current: &[BuildingDiff]) -> Vec<BuildingDiff> {
    current
        .iter()
        .copied()
        .filter(|d| match city.lots.get(d.lot as usize) {
            Some(lot) => u16::from(lot.kind.0) != d.kind || lot.facing != d.rotation,
            None => true,
        })
        .collect()
}

pub(super) fn encode_tick(r: &TickRecord) -> Result<Vec<u8>, EncodeError> {
    if r.events.len() > usize::from(u16::MAX) {
        return Err(EncodeError::TooManyEvents);
    }
    let mut w = Writer(Vec::with_capacity(24 + 16 * r.events.len()));
    let h = &r.header;
    w.u8(KIND_TICK);
    w.varint(u64::from(h.epoch));
    w.varint(u64::from(h.district));
    w.varint(u64::from(h.tick));
    w.u8(h.speed);
    w.u8(if r.keyframe.is_some() {
        FLAG_KEYFRAME
    } else {
        0
    });
    w.varint(h.keyframe_offset);
    w.u64(h.wall_us);
    let entries = entries(&r.events);
    w.varint(entries.len() as u64);
    if let Some(k) = &r.keyframe {
        put_keyframe(&mut w, k, h.tick)?;
    }
    for e in entries {
        put_entry(&mut w, e, h.tick)?;
    }
    Ok(w.0)
}

pub(super) fn decode_tick(bytes: &[u8]) -> Result<TickRecord, DecodeError> {
    let mut r = Reader::new(bytes);
    expect_kind(&mut r, KIND_TICK)?;
    let epoch = r.varint_u32()?;
    let district = u16::try_from(r.varint()?).map_err(|_| DecodeError::Invalid("district"))?;
    let tick = r.varint_u32()?;
    let speed = r.u8()?;
    let flags = r.u8()?;
    if flags & !FLAG_KEYFRAME != 0 {
        return Err(DecodeError::Invalid("unknown header flag"));
    }
    let keyframe_offset = r.varint()?;
    let wall_us = r.u64()?;
    let n = r.count()?;
    let keyframe = if flags & FLAG_KEYFRAME != 0 {
        Some(get_keyframe(&mut r, tick)?)
    } else {
        None
    };
    let mut events = Vec::with_capacity(n);
    for _ in 0..n {
        get_entry(&mut r, tick, &mut events)?;
    }
    r.finish()?;
    Ok(TickRecord {
        header: Header {
            epoch,
            district,
            tick,
            speed,
            keyframe_offset,
            wall_us,
        },
        keyframe,
        events,
    })
}

fn expect_kind(r: &mut Reader, kind: u8) -> Result<(), DecodeError> {
    match r.u8()? {
        k if k == kind => Ok(()),
        k => Err(DecodeError::UnknownKind(k)),
    }
}

/// Leg count, the first segment, deltas for the rest, then a speed per leg.
fn put_route(w: &mut Writer, route: &[Leg]) {
    w.varint(route.len() as u64);
    let mut prev = 0;
    for leg in route {
        w.delta(prev, leg.segment);
        prev = leg.segment;
    }
    for leg in route {
        w.u8(leg.speed);
    }
}

fn get_route(r: &mut Reader) -> Result<Vec<Leg>, DecodeError> {
    // Each leg is two bytes at least, so a count that cannot fit is cut off early.
    let n = r.count()?;
    let mut prev = 0;
    let mut route = Vec::with_capacity(n);
    for _ in 0..n {
        prev = r.delta(prev)?;
        route.push(Leg {
            segment: prev,
            speed: 0,
        });
    }
    for leg in &mut route {
        leg.speed = r.u8()?;
    }
    Ok(route)
}

fn put_vehicle(w: &mut Writer, v: &Vehicle) {
    w.u8(v.kind);
    w.u16(v.progress);
    put_route(w, &v.route);
}

fn get_vehicle(r: &mut Reader) -> Result<Vehicle, DecodeError> {
    let kind = r.u8()?;
    let progress = r.u16()?;
    if progress > MAX_PROGRESS {
        return Err(DecodeError::Invalid("progress is past the end of the leg"));
    }
    Ok(Vehicle {
        kind,
        progress,
        route: get_route(r)?,
    })
}

fn put_building(w: &mut Writer, lot: u32, kind: u16, rotation: u8) {
    w.u32(lot);
    w.u16(kind);
    w.u8(rotation);
}

/// What is written for the events of a tick: an `arrived` followed by the same resident's `activity` is one entry.
enum Entry<'a> {
    Event(&'a Event),
    Arrival {
        resident: u32,
        lot: u32,
        kind: u8,
        until: u32,
    },
}

fn entries(events: &[Event]) -> Vec<Entry<'_>> {
    let mut out = Vec::with_capacity(events.len());
    let mut i = 0;
    while i < events.len() {
        if let (
            Event::Arrived { resident, lot },
            Some(Event::Activity {
                resident: same,
                kind,
                until,
            }),
        ) = (&events[i], events.get(i + 1))
            && resident == same
        {
            out.push(Entry::Arrival {
                resident: *resident,
                lot: *lot,
                kind: *kind,
                until: *until,
            });
            i += 2;
            continue;
        }
        out.push(Entry::Event(&events[i]));
        i += 1;
    }
    out
}

fn put_entry(w: &mut Writer, entry: Entry<'_>, tick: u32) -> Result<(), EncodeError> {
    match entry {
        Entry::Arrival {
            resident,
            lot,
            kind,
            until,
        } => w.framed(EV_ARRIVAL, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(resident));
            b.varint(u64::from(lot));
            b.u8(kind);
            b.delta(tick, until);
            Ok(())
        }),
        Entry::Event(e) => put_event(w, e, tick),
    }
}

fn put_event(w: &mut Writer, e: &Event, tick: u32) -> Result<(), EncodeError> {
    match e {
        Event::Trip {
            resident,
            vehicle,
            depart,
            route,
        } => w.framed(EV_TRIP, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(*resident));
            b.u8(*vehicle);
            b.delta(tick, *depart);
            put_route(b, route);
            Ok(())
        }),
        Event::Replan {
            resident,
            vehicle,
            node,
            route,
        } => w.framed(EV_REPLAN, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(*resident));
            b.u8(*vehicle);
            b.varint(u64::from(*node));
            put_route(b, route);
            Ok(())
        }),
        Event::Arrived { resident, lot } => w.framed(EV_ARRIVED, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(*resident));
            b.varint(u64::from(*lot));
            Ok(())
        }),
        Event::Activity {
            resident,
            kind,
            until,
        } => w.framed(EV_ACTIVITY, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(*resident));
            b.u8(*kind);
            b.delta(tick, *until);
            Ok(())
        }),
        Event::Left { resident, district } => w.framed(EV_LEFT, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(*resident));
            b.varint(u64::from(*district));
            Ok(())
        }),
        Event::Entered {
            resident,
            district,
            vehicle,
        } => w.framed(EV_ENTERED, EVENT_TAG_BITS, |b| {
            b.varint(u64::from(*resident));
            b.varint(u64::from(*district));
            put_vehicle(b, vehicle);
            Ok(())
        }),
        Event::Built {
            lot,
            kind,
            rotation,
        } => w.framed(EV_BUILT, EVENT_TAG_BITS, |b| {
            put_building(b, *lot, *kind, *rotation);
            Ok(())
        }),
        Event::Demolished {
            lot,
            kind,
            rotation,
        } => w.framed(EV_DEMOLISHED, EVENT_TAG_BITS, |b| {
            put_building(b, *lot, *kind, *rotation);
            Ok(())
        }),
        Event::Road { segment, change } => w.framed(EV_ROAD, EVENT_TAG_BITS, |b| {
            b.u32(*segment);
            b.u8(*change);
            Ok(())
        }),
        Event::Roadwork {
            segment,
            change,
            a,
            b: to,
        } => w.framed(EV_EXTENDED, EVENT_TAG_BITS, |b| {
            b.varint(EXT_ROADWORK);
            b.varint(u64::from(*segment));
            b.u8(*change);
            b.varint(u64::from(*a));
            b.varint(u64::from(*to));
            Ok(())
        }),
        Event::Command {
            principal,
            name,
            id,
            result,
        } => w.framed(EV_COMMAND, EVENT_TAG_BITS, |b| {
            b.u64(*principal);
            b.str(name)?;
            b.u32(*id);
            b.u8(*result);
            Ok(())
        }),
        Event::Speed { ticks_per_second } => w.framed(EV_SPEED, EVENT_TAG_BITS, |b| {
            b.u8(*ticks_per_second);
            Ok(())
        }),
        Event::CommandCursor { next } => w.framed(EV_COMMAND_CURSOR, EVENT_TAG_BITS, |b| {
            b.varint(*next);
            Ok(())
        }),
        Event::Ledger {
            reason,
            earned,
            spent,
        } => w.framed(EV_EXTENDED, EVENT_TAG_BITS, |b| {
            b.varint(EXT_LEDGER);
            b.u8(*reason);
            b.varint(*earned);
            b.varint(*spent);
            Ok(())
        }),
        Event::Balance { amount } => w.framed(EV_EXTENDED, EVENT_TAG_BITS, |b| {
            b.varint(EXT_BALANCE);
            b.svarint(*amount);
            Ok(())
        }),
    }
}

/// Reads the next entry into `out`; a tag this build does not know adds nothing.
fn get_entry(r: &mut Reader, tick: u32, out: &mut Vec<Event>) -> Result<(), DecodeError> {
    let (tag, mut r) = r.framed(EVENT_TAG_BITS)?;
    let r = &mut r;
    let event = match tag {
        EV_ARRIVAL => {
            let resident = r.varint_u32()?;
            out.push(Event::Arrived {
                resident,
                lot: r.varint_u32()?,
            });
            Event::Activity {
                resident,
                kind: r.u8()?,
                until: r.delta(tick)?,
            }
        }
        EV_TRIP => Event::Trip {
            resident: r.varint_u32()?,
            vehicle: r.u8()?,
            depart: r.delta(tick)?,
            route: get_route(r)?,
        },
        EV_REPLAN => Event::Replan {
            resident: r.varint_u32()?,
            vehicle: r.u8()?,
            node: r.varint_u32()?,
            route: get_route(r)?,
        },
        EV_ARRIVED => Event::Arrived {
            resident: r.varint_u32()?,
            lot: r.varint_u32()?,
        },
        EV_ACTIVITY => Event::Activity {
            resident: r.varint_u32()?,
            kind: r.u8()?,
            until: r.delta(tick)?,
        },
        EV_LEFT => Event::Left {
            resident: r.varint_u32()?,
            district: district(r)?,
        },
        EV_ENTERED => Event::Entered {
            resident: r.varint_u32()?,
            district: district(r)?,
            vehicle: get_vehicle(r)?,
        },
        EV_BUILT => Event::Built {
            lot: r.u32()?,
            kind: r.u16()?,
            rotation: r.u8()?,
        },
        EV_DEMOLISHED => Event::Demolished {
            lot: r.u32()?,
            kind: r.u16()?,
            rotation: r.u8()?,
        },
        EV_ROAD => Event::Road {
            segment: r.u32()?,
            change: r.u8()?,
        },
        EV_COMMAND => Event::Command {
            principal: r.u64()?,
            name: r.str()?,
            id: r.u32()?,
            result: r.u8()?,
        },
        EV_SPEED => Event::Speed {
            ticks_per_second: r.u8()?,
        },
        EV_COMMAND_CURSOR => Event::CommandCursor { next: r.varint()? },
        EV_EXTENDED => match r.varint()? {
            EXT_LEDGER => Event::Ledger {
                reason: r.u8()?,
                earned: r.varint()?,
                spent: r.varint()?,
            },
            EXT_BALANCE => Event::Balance {
                amount: r.svarint()?,
            },
            EXT_ROADWORK => Event::Roadwork {
                segment: r.varint_u32()?,
                change: r.u8()?,
                a: r.varint_u32()?,
                b: r.varint_u32()?,
            },
            _ => return Ok(()),
        },
        _ => return Ok(()),
    };
    out.push(event);
    Ok(())
}

fn district(r: &mut Reader) -> Result<u16, DecodeError> {
    u16::try_from(r.varint()?).map_err(|_| DecodeError::Invalid("district"))
}

fn put_keyframe(w: &mut Writer, k: &Keyframe, tick: u32) -> Result<(), EncodeError> {
    w.varint(k.buildings.len() as u64);
    let mut prev = 0;
    for b in &k.buildings {
        w.delta(prev, b.lot);
        prev = b.lot;
        w.u16(b.kind);
        w.u8(b.rotation);
    }
    w.varint(k.roads.len() as u64);
    prev = 0;
    for d in &k.roads {
        w.delta(prev, d.segment);
        prev = d.segment;
        w.u8(d.change);
        w.varint(u64::from(d.a));
        w.varint(u64::from(d.b));
    }
    w.varint(k.residents.len() as u64);
    prev = 0;
    for res in &k.residents {
        w.delta(prev, res.id);
        prev = res.id;
        match &res.doing {
            Doing::Activity { kind, lot, until } => {
                w.framed(DOING_ACTIVITY, ENTRY_TAG_BITS, |b| {
                    b.u8(*kind);
                    b.varint(u64::from(*lot));
                    b.delta(tick, *until);
                    Ok(())
                })?
            }
            Doing::Trip(v) => w.framed(DOING_TRIP, ENTRY_TAG_BITS, |b| {
                put_vehicle(b, v);
                Ok(())
            })?,
        }
    }
    let c = &k.counts;
    for n in [c.home, c.at_work, c.on_road, c.asleep] {
        w.varint(u64::from(n));
    }
    Ok(())
}

fn get_keyframe(r: &mut Reader, tick: u32) -> Result<Keyframe, DecodeError> {
    let n = r.count()?;
    let mut prev = 0;
    let mut buildings = Vec::with_capacity(n);
    for _ in 0..n {
        prev = r.delta(prev)?;
        buildings.push(BuildingDiff {
            lot: prev,
            kind: r.u16()?,
            rotation: r.u8()?,
        });
    }
    let n = r.count()?;
    prev = 0;
    let mut roads = Vec::with_capacity(n);
    for _ in 0..n {
        prev = r.delta(prev)?;
        roads.push(RoadDiff {
            segment: prev,
            change: r.u8()?,
            a: r.varint_u32()?,
            b: r.varint_u32()?,
        });
    }
    let n = r.count()?;
    prev = 0;
    let mut residents = Vec::with_capacity(n);
    for _ in 0..n {
        prev = r.delta(prev)?;
        let (tag, mut b) = r.framed(ENTRY_TAG_BITS)?;
        let b = &mut b;
        let doing = match tag {
            DOING_ACTIVITY => Doing::Activity {
                kind: b.u8()?,
                lot: b.varint_u32()?,
                until: b.delta(tick)?,
            },
            DOING_TRIP => Doing::Trip(get_vehicle(b)?),
            _ => continue,
        };
        residents.push(ResidentState { id: prev, doing });
    }
    let counts = Counts {
        home: r.varint_u32()?,
        at_work: r.varint_u32()?,
        on_road: r.varint_u32()?,
        asleep: r.varint_u32()?,
    };
    Ok(Keyframe {
        buildings,
        roads,
        residents,
        counts,
    })
}

pub(super) fn encode_command(c: &CommandRecord) -> Result<Vec<u8>, EncodeError> {
    let mut w = Writer(Vec::with_capacity(32));
    w.u8(KIND_COMMAND);
    w.u32(c.id);
    w.str(&c.name)?;
    match &c.command {
        Command::PlaceRoad { a, b } => {
            w.u8(CMD_PLACE_ROAD);
            w.u32(*a);
            w.u32(*b);
        }
        Command::Zone { lot, zone } => {
            w.u8(CMD_ZONE);
            w.u32(*lot);
            w.u8(*zone);
        }
        Command::Build {
            lot,
            kind,
            rotation,
        } => {
            w.u8(CMD_BUILD);
            put_building(&mut w, *lot, *kind, *rotation);
        }
        Command::Demolish { lot } => {
            w.u8(CMD_DEMOLISH);
            w.u32(*lot);
        }
        Command::Speed { ticks_per_second } => {
            w.u8(CMD_SPEED);
            w.u8(*ticks_per_second);
        }
        Command::Fork { tick, name } => {
            w.u8(CMD_FORK);
            w.u32(*tick);
            w.str(name)?;
        }
        Command::RemoveRoad { segment } => {
            w.u8(CMD_REMOVE_ROAD);
            w.u32(*segment);
        }
    }
    Ok(w.0)
}

pub(super) fn decode_command(bytes: &[u8]) -> Result<CommandRecord, DecodeError> {
    let mut r = Reader::new(bytes);
    expect_kind(&mut r, KIND_COMMAND)?;
    let id = r.u32()?;
    let name = r.str()?;
    let command = match r.u8()? {
        CMD_PLACE_ROAD => Command::PlaceRoad {
            a: r.u32()?,
            b: r.u32()?,
        },
        CMD_ZONE => Command::Zone {
            lot: r.u32()?,
            zone: r.u8()?,
        },
        CMD_BUILD => Command::Build {
            lot: r.u32()?,
            kind: r.u16()?,
            rotation: r.u8()?,
        },
        CMD_DEMOLISH => Command::Demolish { lot: r.u32()? },
        CMD_SPEED => Command::Speed {
            ticks_per_second: r.u8()?,
        },
        CMD_FORK => Command::Fork {
            tick: r.u32()?,
            name: r.str()?,
        },
        CMD_REMOVE_ROAD => Command::RemoveRoad { segment: r.u32()? },
        tag => return Err(DecodeError::UnknownTag(tag)),
    };
    r.finish()?;
    Ok(CommandRecord { id, name, command })
}

pub(super) fn encode_registry(e: &RegistryRecord) -> Result<Vec<u8>, EncodeError> {
    let mut w = Writer(Vec::with_capacity(48));
    w.u8(KIND_REGISTRY);
    match e {
        RegistryRecord::Created {
            name,
            seed,
            districts,
            wall_us,
        } => {
            w.u8(REG_CREATED);
            w.str(name)?;
            w.str(seed)?;
            w.u16(*districts);
            w.u64(*wall_us);
        }
        RegistryRecord::Forked {
            name,
            parent,
            tick,
            wall_us,
        } => {
            w.u8(REG_FORKED);
            w.str(name)?;
            w.str(parent)?;
            w.u32(*tick);
            w.u64(*wall_us);
        }
    }
    Ok(w.0)
}

pub(super) fn decode_registry(bytes: &[u8]) -> Result<RegistryRecord, DecodeError> {
    let mut r = Reader::new(bytes);
    expect_kind(&mut r, KIND_REGISTRY)?;
    let rec = match r.u8()? {
        REG_CREATED => RegistryRecord::Created {
            name: r.str()?,
            seed: r.str()?,
            districts: r.u16()?,
            wall_us: r.u64()?,
        },
        REG_FORKED => RegistryRecord::Forked {
            name: r.str()?,
            parent: r.str()?,
            tick: r.u32()?,
            wall_us: r.u64()?,
        },
        tag => return Err(DecodeError::UnknownTag(tag)),
    };
    r.finish()?;
    Ok(rec)
}
