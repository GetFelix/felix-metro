//! One city's state and the rules that advance it a tick at a time.

use std::collections::{BTreeMap, HashSet};

use felix_metro_core::record::{
    BuildingDiff, Command, Counts, Doing, Event, Keyframe, Leg, NO_BUILDING, REFUSED_BAD_KIND,
    REFUSED_EMPTY, REFUSED_IN_USE, REFUSED_OCCUPIED, REFUSED_UNKNOWN, REFUSED_UNSUPPORTED,
    RESULT_APPLIED, ResidentState, Vehicle,
};
use felix_metro_core::{
    Activity, BuildingKind, City, Congestion, Mode, Places, Resident, TICKS_PER_DAY,
    TICKS_PER_HOUR, Trip,
};

/// Ticks between keyframes: one city hour.
pub(crate) const KEYFRAME_EVERY: u32 = TICKS_PER_HOUR;

/// First tick of the night, and of the morning after: residents at home
/// between them count as asleep.
const BEDTIME: u32 = 22 * TICKS_PER_HOUR;
const WAKE: u32 = 6 * TICKS_PER_HOUR;

/// The `kind` of an `activity` event and a keyframe entry. Sleep is not an
/// activity: a viewer derives it from the hour.
pub(crate) fn activity_kind(activity: Activity) -> u8 {
    activity as u8
}

/// What one district does in one tick.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DistrictTick {
    pub(crate) events: Vec<Event>,
    /// Set on a keyframe tick.
    pub(crate) keyframe: Option<Keyframe>,
}

struct Person {
    resident: Resident,
    /// The block they are in, or just left.
    block: usize,
    /// The day that block's leave tick is on.
    day: u32,
    state: State,
}

enum State {
    /// Doing the block's activity since `since`.
    At { since: u32 },
    Travelling {
        trip: Trip,
        vehicle: u8,
        /// The district the vehicle was in last tick.
        district: u16,
    },
}

pub(crate) struct World {
    pub(crate) city: City,
    people: Vec<Person>,
    /// The next tick to step.
    tick: u32,
    /// Cars on each segment at the last tick, which routes are planned around.
    cars: Vec<u16>,
    /// The lots whose building was changed after generation, by lot.
    built: BTreeMap<u32, BuildingDiff>,
    /// Lots a resident's schedule sends them to. Demolishing one would strand
    /// the people who go there.
    pub(crate) in_use: HashSet<u32>,
}

/// What a command did: the district it touched and the events to record there.
/// A refusal has only the `command` event's result to tell it apart.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Applied {
    pub(crate) district: u16,
    pub(crate) result: u8,
    pub(crate) events: Vec<Event>,
}

impl Applied {
    fn refused(district: u16, result: u8) -> Applied {
        Applied {
            district,
            result,
            events: Vec::new(),
        }
    }
}

impl World {
    /// The city as it stands before tick 0: everyone in the first block of
    /// their day.
    pub(crate) fn new(city: City) -> World {
        let places = Places::new(&city);
        World::with_places(city, &places)
    }

    pub(crate) fn with_places(city: City, places: &Places) -> World {
        let people: Vec<Person> = (0..places.population())
            .filter_map(|index| Resident::new(&city, places, index))
            .map(|resident| Person {
                resident,
                block: 0,
                day: 0,
                state: State::At { since: 0 },
            })
            .collect();
        let cars = vec![0; city.segments.len()];
        let in_use = people
            .iter()
            .flat_map(|p| p.resident.schedule.blocks.iter().map(|b| b.lot))
            .collect();
        World {
            city,
            people,
            tick: 0,
            cars,
            built: BTreeMap::new(),
            in_use,
        }
    }

    /// The building on `lot` now: kind and rotation.
    pub(crate) fn building(&self, lot: u32) -> Option<(u16, u8)> {
        let generated = self.city.lots.get(lot as usize)?;
        Some(match self.built.get(&lot) {
            Some(diff) => (diff.kind, diff.rotation),
            None => (u16::from(generated.kind.0), generated.facing),
        })
    }

    /// Carries out a `place road`, `zone`, `build` or `demolish` before the
    /// next step, so that tick's keyframe and events already show it. A
    /// refusal changes nothing. `speed` and `fork` are the runner's.
    pub(crate) fn apply(&mut self, command: &Command) -> Applied {
        match *command {
            Command::Build {
                lot,
                kind,
                rotation,
            } => {
                let Some((now, _)) = self.building(lot) else {
                    return Applied::refused(0, REFUSED_UNKNOWN);
                };
                let district = self.city.lots[lot as usize].district;
                if kind >= u16::from(BuildingKind::TREE_FIRST) || rotation > 3 {
                    return Applied::refused(district, REFUSED_BAD_KIND);
                }
                if !is_empty(now) {
                    return Applied::refused(district, REFUSED_OCCUPIED);
                }
                // A park residents go to stays one.
                if self.in_use.contains(&lot) {
                    return Applied::refused(district, REFUSED_IN_USE);
                }
                self.built.insert(
                    lot,
                    BuildingDiff {
                        lot,
                        kind,
                        rotation,
                    },
                );
                Applied {
                    district,
                    result: RESULT_APPLIED,
                    events: vec![Event::Built {
                        lot,
                        kind,
                        rotation,
                    }],
                }
            }
            Command::Demolish { lot } => {
                let Some((kind, rotation)) = self.building(lot) else {
                    return Applied::refused(0, REFUSED_UNKNOWN);
                };
                let district = self.city.lots[lot as usize].district;
                if is_empty(kind) {
                    return Applied::refused(district, REFUSED_EMPTY);
                }
                if self.in_use.contains(&lot) {
                    return Applied::refused(district, REFUSED_IN_USE);
                }
                self.built.insert(
                    lot,
                    BuildingDiff {
                        lot,
                        kind: NO_BUILDING,
                        rotation: 0,
                    },
                );
                Applied {
                    district,
                    result: RESULT_APPLIED,
                    events: vec![Event::Demolished {
                        lot,
                        kind,
                        rotation,
                    }],
                }
            }
            // A road changes the graph every route and the page's own copy of
            // the city are built on, and a zone has no record to carry it.
            Command::PlaceRoad { .. } | Command::Zone { .. } => {
                Applied::refused(0, REFUSED_UNSUPPORTED)
            }
            Command::Speed { .. } | Command::Fork { .. } => {
                Applied::refused(0, REFUSED_UNSUPPORTED)
            }
        }
    }

    /// Change a lot's building, as a `built` or `demolished` event will.
    #[cfg(test)]
    pub(crate) fn set_building(&mut self, diff: BuildingDiff) {
        self.built.insert(diff.lot, diff);
    }

    pub(crate) fn districts(&self) -> usize {
        self.city.districts.len()
    }

    pub(crate) fn residents(&self) -> usize {
        self.people.len()
    }

    /// The tick the next call to [`World::step`] produces.
    pub(crate) fn next_tick(&self) -> u32 {
        self.tick
    }

    /// Advances one tick and returns what each district records for it.
    pub(crate) fn step(&mut self) -> Vec<DistrictTick> {
        let tick = self.tick;
        let mut out: Vec<DistrictTick> = (0..self.districts())
            .map(|_| DistrictTick::default())
            .collect();
        let mut cars = vec![0u16; self.cars.len()];
        let city = &self.city;
        let planned_around = self.cars.clone();
        let cong = Congestion::new(&planned_around);
        for person in &mut self.people {
            let id = person.resident.id;
            match &mut person.state {
                State::Travelling {
                    trip,
                    vehicle,
                    district,
                } => {
                    // The last step can end in another district, so cross before
                    // arriving. The vehicle ends in the district of the lot it
                    // reaches, which a road beside a boundary may not be in.
                    let (leg, progress) = trip.leg_progress(tick);
                    let arriving = trip.arrive() <= tick;
                    let blocks = &person.resident.schedule.blocks;
                    let next = (person.block + 1) % blocks.len();
                    let now = if arriving {
                        city.lots[blocks[next].lot as usize].district
                    } else {
                        district_of(city, trip, tick)
                    };
                    if now != *district {
                        let state = vehicle_state(trip, *vehicle, leg, progress);
                        out[usize::from(*district)].events.push(Event::Left {
                            resident: id,
                            district: now,
                            vehicle: state.clone(),
                        });
                        out[usize::from(now)].events.push(Event::Entered {
                            resident: id,
                            district: *district,
                            vehicle: state,
                        });
                        *district = now;
                    }
                    if arriving {
                        person.block = next;
                        if person.block == 0 {
                            person.day += 1;
                        }
                        let block = &blocks[person.block];
                        let lot = block.lot;
                        let home = city.lots[lot as usize].district;
                        let until = person
                            .resident
                            .schedule
                            .leave_tick(person.block, person.day)
                            .max(tick);
                        let events = &mut out[usize::from(home)].events;
                        events.push(Event::Arrived { resident: id, lot });
                        events.push(Event::Activity {
                            resident: id,
                            kind: activity_kind(block.activity),
                            until,
                        });
                        person.state = State::At { since: tick };
                        continue;
                    }
                    count_car(city, &mut cars, trip, tick);
                }
                State::At { since } => {
                    let leave = person
                        .resident
                        .schedule
                        .leave_tick(person.block, person.day)
                        .max(*since);
                    if tick < leave {
                        continue;
                    }
                    let Some(trip) = person.resident.trip(city, person.block, tick, &cong) else {
                        // The roads do not connect the next block. Try again in an hour.
                        *since = tick + TICKS_PER_HOUR;
                        continue;
                    };
                    let vehicle = match trip.mode {
                        Mode::Walk => 0,
                        Mode::Drive => person.resident.vehicle,
                    };
                    let lot = person.resident.schedule.blocks[person.block].lot;
                    let district = city.lots[lot as usize].district;
                    out[usize::from(district)].events.push(Event::Trip {
                        resident: id,
                        vehicle,
                        depart: trip.depart,
                        route: trip.legs(),
                    });
                    count_car(city, &mut cars, &trip, tick);
                    person.state = State::Travelling {
                        trip,
                        vehicle,
                        district,
                    };
                }
            }
        }
        self.cars = cars;
        if tick.is_multiple_of(KEYFRAME_EVERY) {
            for (district, keyframe) in self.keyframes(tick).into_iter().enumerate() {
                out[district].keyframe = Some(keyframe);
            }
        }
        self.tick += 1;
        out
    }

    /// Every district's state at the end of `tick`.
    fn keyframes(&self, tick: u32) -> Vec<Keyframe> {
        let mut frames: Vec<Keyframe> = (0..self.districts())
            .map(|_| Keyframe {
                buildings: Vec::new(),
                roads: Vec::new(),
                residents: Vec::new(),
                counts: Counts::default(),
            })
            .collect();
        // A keyframe lists every lot that differs from the generated city, so a viewer can tell a lot it leaves out
        // is the generated one.
        for diff in self.built.values() {
            let lot = &self.city.lots[diff.lot as usize];
            if diff.kind != u16::from(lot.kind.0) || diff.rotation != lot.facing {
                frames[usize::from(lot.district)].buildings.push(*diff);
            }
        }
        let time = tick % TICKS_PER_DAY;
        for person in &self.people {
            let id = person.resident.id;
            match &person.state {
                State::At { since } => {
                    let block = &person.resident.schedule.blocks[person.block];
                    let district = usize::from(self.city.lots[block.lot as usize].district);
                    let until = person
                        .resident
                        .schedule
                        .leave_tick(person.block, person.day)
                        .max(*since);
                    let frame = &mut frames[district];
                    frame.residents.push(ResidentState {
                        id,
                        doing: Doing::Activity {
                            kind: activity_kind(block.activity),
                            lot: block.lot,
                            until,
                        },
                    });
                    match block.activity {
                        Activity::Home if !(WAKE..BEDTIME).contains(&time) => {
                            frame.counts.asleep += 1;
                        }
                        Activity::Home => frame.counts.home += 1,
                        Activity::Work | Activity::School => frame.counts.at_work += 1,
                        // Shopping and leisure are in none of the four counts.
                        Activity::Shop | Activity::Leisure => {}
                    }
                }
                State::Travelling {
                    trip,
                    vehicle,
                    district,
                } => {
                    let (leg, progress) = trip.leg_progress(tick);
                    let frame = &mut frames[usize::from(*district)];
                    frame.residents.push(ResidentState {
                        id,
                        doing: Doing::Trip(vehicle_state(trip, *vehicle, leg, progress)),
                    });
                    frame.counts.on_road += 1;
                }
            }
        }
        frames
    }
}

/// Each district's state at the end of `tick`, from stepping a fresh world
/// there: what a keyframe committed at that tick has to hold.
pub fn state_at(city: City, tick: u32) -> Vec<Keyframe> {
    let mut world = World::new(city);
    while world.next_tick() < tick {
        world.step();
    }
    let frames = world.step();
    frames.into_iter().filter_map(|d| d.keyframe).collect()
}

/// The vehicle with the route it has left, from the leg it is on.
fn vehicle_state(trip: &Trip, kind: u8, leg: usize, progress: u16) -> Vehicle {
    let route: Vec<Leg> = trip.legs().split_off(leg);
    Vehicle {
        kind,
        progress,
        route,
    }
}

/// A lot with nothing on it that a builder would count: bare, or only trees and
/// plaza props.
fn is_empty(kind: u16) -> bool {
    kind == NO_BUILDING || kind >= u16::from(BuildingKind::TREE_FIRST)
}

fn district_of(city: &City, trip: &Trip, tick: u32) -> u16 {
    let at = trip.position_at(city, tick);
    let side = u32::from(city.districts_per_side);
    let column = (at.x / 1000 / 12).min(side - 1);
    let row = (at.z / 1000 / 12).min(side - 1);
    (row * side + column) as u16
}

fn count_car(city: &City, cars: &mut [u16], trip: &Trip, tick: u32) {
    if trip.mode == Mode::Drive {
        let segment = trip.position_at(city, tick).segment as usize;
        cars[segment] = cars[segment].saturating_add(1);
    }
}

#[cfg(test)]
mod tests;
