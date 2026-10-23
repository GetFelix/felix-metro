//! Encoding and decoding of each record layout.

use super::wire::{Reader, Writer};
use super::{
    BuildingDiff, Command, CommandRecord, Counts, DecodeError, Doing, Event, FLAG_KEYFRAME, Header,
    KIND_COMMAND, KIND_REGISTRY, KIND_TICK, Keyframe, Leg, RegistryRecord, ResidentState, RoadDiff,
    TickRecord, TooManyEvents, Vehicle,
};
use crate::city::City;

/// Bytes of a tick record before its first event: the kind byte and the header.
pub const TICK_HEADER_LEN: usize = 31;

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

const CMD_PLACE_ROAD: u8 = 1;
const CMD_ZONE: u8 = 2;
const CMD_BUILD: u8 = 3;
const CMD_DEMOLISH: u8 = 4;
const CMD_SPEED: u8 = 5;
const CMD_FORK: u8 = 6;

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

pub(super) fn encode_tick(r: &TickRecord) -> Result<Vec<u8>, TooManyEvents> {
    let events = u16::try_from(r.events.len()).map_err(|_| TooManyEvents)?;
    let mut w = Writer(Vec::with_capacity(TICK_HEADER_LEN + 32 * r.events.len()));
    let h = &r.header;
    w.u8(KIND_TICK);
    w.u32(h.epoch);
    w.u16(h.district);
    w.u32(h.tick);
    w.u8(h.speed);
    w.u8(if r.keyframe.is_some() {
        FLAG_KEYFRAME
    } else {
        0
    });
    w.u64(h.keyframe_offset);
    w.u64(h.wall_us);
    w.u16(events);
    if let Some(k) = &r.keyframe {
        put_keyframe(&mut w, k);
    }
    for e in &r.events {
        put_event(&mut w, e);
    }
    Ok(w.0)
}

pub(super) fn decode_tick(bytes: &[u8]) -> Result<TickRecord, DecodeError> {
    let mut r = Reader::new(bytes);
    expect_kind(&mut r, KIND_TICK)?;
    let epoch = r.u32()?;
    let district = r.u16()?;
    let tick = r.u32()?;
    let speed = r.u8()?;
    let flags = r.u8()?;
    if flags & !FLAG_KEYFRAME != 0 {
        return Err(DecodeError::Invalid("unknown header flag"));
    }
    let keyframe_offset = r.u64()?;
    let wall_us = r.u64()?;
    let n = usize::from(r.u16()?);
    let keyframe = if flags & FLAG_KEYFRAME != 0 {
        Some(get_keyframe(&mut r)?)
    } else {
        None
    };
    let mut events = Vec::with_capacity(n.min(r.remaining()));
    for _ in 0..n {
        events.push(get_event(&mut r)?);
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
    Ok(Vehicle {
        kind: r.u8()?,
        progress: r.u16()?,
        route: get_route(r)?,
    })
}

fn put_event(w: &mut Writer, e: &Event) {
    match e {
        Event::Trip {
            resident,
            vehicle,
            depart,
            route,
        } => {
            w.u8(EV_TRIP);
            w.u32(*resident);
            w.u8(*vehicle);
            w.u32(*depart);
            put_route(w, route);
        }
        Event::Replan {
            resident,
            from_segment,
            route,
        } => {
            w.u8(EV_REPLAN);
            w.u32(*resident);
            w.u32(*from_segment);
            put_route(w, route);
        }
        Event::Arrived { resident, lot } => {
            w.u8(EV_ARRIVED);
            w.u32(*resident);
            w.u32(*lot);
        }
        Event::Activity {
            resident,
            kind,
            until,
        } => {
            w.u8(EV_ACTIVITY);
            w.u32(*resident);
            w.u8(*kind);
            w.u32(*until);
        }
        Event::Left {
            resident,
            district,
            vehicle,
        } => {
            w.u8(EV_LEFT);
            w.u32(*resident);
            w.u16(*district);
            put_vehicle(w, vehicle);
        }
        Event::Entered {
            resident,
            district,
            vehicle,
        } => {
            w.u8(EV_ENTERED);
            w.u32(*resident);
            w.u16(*district);
            put_vehicle(w, vehicle);
        }
        Event::Built {
            lot,
            kind,
            rotation,
        } => {
            w.u8(EV_BUILT);
            put_building(w, *lot, *kind, *rotation);
        }
        Event::Demolished {
            lot,
            kind,
            rotation,
        } => {
            w.u8(EV_DEMOLISHED);
            put_building(w, *lot, *kind, *rotation);
        }
        Event::Road { segment, change } => {
            w.u8(EV_ROAD);
            w.u32(*segment);
            w.u8(*change);
        }
        Event::Command {
            principal,
            name,
            id,
            result,
        } => {
            w.u8(EV_COMMAND);
            w.u64(*principal);
            w.str(name);
            w.u32(*id);
            w.u8(*result);
        }
        Event::Speed { ticks_per_second } => {
            w.u8(EV_SPEED);
            w.u8(*ticks_per_second);
        }
    }
}

fn put_building(w: &mut Writer, lot: u32, kind: u16, rotation: u8) {
    w.u32(lot);
    w.u16(kind);
    w.u8(rotation);
}

fn get_event(r: &mut Reader) -> Result<Event, DecodeError> {
    Ok(match r.u8()? {
        EV_TRIP => Event::Trip {
            resident: r.u32()?,
            vehicle: r.u8()?,
            depart: r.u32()?,
            route: get_route(r)?,
        },
        EV_REPLAN => Event::Replan {
            resident: r.u32()?,
            from_segment: r.u32()?,
            route: get_route(r)?,
        },
        EV_ARRIVED => Event::Arrived {
            resident: r.u32()?,
            lot: r.u32()?,
        },
        EV_ACTIVITY => Event::Activity {
            resident: r.u32()?,
            kind: r.u8()?,
            until: r.u32()?,
        },
        EV_LEFT => Event::Left {
            resident: r.u32()?,
            district: r.u16()?,
            vehicle: get_vehicle(r)?,
        },
        EV_ENTERED => Event::Entered {
            resident: r.u32()?,
            district: r.u16()?,
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
        tag => return Err(DecodeError::UnknownTag(tag)),
    })
}

fn put_keyframe(w: &mut Writer, k: &Keyframe) {
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
    }
    w.varint(k.residents.len() as u64);
    prev = 0;
    for res in &k.residents {
        w.delta(prev, res.id);
        prev = res.id;
        match &res.doing {
            Doing::Activity { kind, until } => {
                w.u8(DOING_ACTIVITY);
                w.u8(*kind);
                w.varint(u64::from(*until));
            }
            Doing::Trip(v) => {
                w.u8(DOING_TRIP);
                put_vehicle(w, v);
            }
        }
    }
    let c = &k.counts;
    for n in [c.home, c.at_work, c.on_road, c.asleep] {
        w.varint(u64::from(n));
    }
}

fn get_keyframe(r: &mut Reader) -> Result<Keyframe, DecodeError> {
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
        });
    }
    let n = r.count()?;
    prev = 0;
    let mut residents = Vec::with_capacity(n);
    for _ in 0..n {
        prev = r.delta(prev)?;
        let doing = match r.u8()? {
            DOING_ACTIVITY => Doing::Activity {
                kind: r.u8()?,
                until: r.varint_u32()?,
            },
            DOING_TRIP => Doing::Trip(get_vehicle(r)?),
            tag => return Err(DecodeError::UnknownTag(tag)),
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

pub(super) fn encode_command(c: &CommandRecord) -> Vec<u8> {
    let mut w = Writer(Vec::with_capacity(32));
    w.u8(KIND_COMMAND);
    w.u32(c.id);
    w.str(&c.name);
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
            w.str(name);
        }
    }
    w.0
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
        tag => return Err(DecodeError::UnknownTag(tag)),
    };
    r.finish()?;
    Ok(CommandRecord { id, name, command })
}

pub(super) fn encode_registry(e: &RegistryRecord) -> Vec<u8> {
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
            w.str(name);
            w.str(seed);
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
            w.str(name);
            w.str(parent);
            w.u32(*tick);
            w.u64(*wall_us);
        }
    }
    w.0
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
