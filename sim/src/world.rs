//! One city's state and the rules that advance it a tick at a time.

use std::collections::BTreeMap;

use felix_metro_core::record::{
    BuildingDiff, Counts, Doing, Event, Keyframe, Leg, ResidentState, Vehicle,
};
use felix_metro_core::{
    Activity, City, Congestion, Mode, Places, Resident, TICKS_PER_DAY, TICKS_PER_HOUR, Trip,
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
    city: City,
    people: Vec<Person>,
    /// The next tick to step.
    tick: u32,
    /// Cars on each segment at the last tick, which routes are planned around.
    cars: Vec<u16>,
    /// The lots whose building was changed after generation, by lot.
    built: BTreeMap<u32, BuildingDiff>,
}

impl World {
    /// The city as it stands before tick 0: everyone in the first block of
    /// their day.
    pub(crate) fn new(city: City) -> World {
        let places = Places::new(&city);
        let people = (0..places.population())
            .filter_map(|index| Resident::new(&city, &places, index))
            .map(|resident| Person {
                resident,
                block: 0,
                day: 0,
                state: State::At { since: 0 },
            })
            .collect();
        let cars = vec![0; city.segments.len()];
        World {
            city,
            people,
            tick: 0,
            cars,
            built: BTreeMap::new(),
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

/// The vehicle with the route it has left, from the leg it is on.
fn vehicle_state(trip: &Trip, kind: u8, leg: usize, progress: u16) -> Vehicle {
    let route: Vec<Leg> = trip.legs().split_off(leg);
    Vehicle {
        kind,
        progress,
        route,
    }
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
