//! Rebuilding a world from the log it wrote: a keyframe and the trips that
//! were under way when it was taken.

use std::collections::HashMap;

use anyhow::{Context, Result, bail, ensure};
use felix_metro_core::record::{
    BuildingDiff, Doing, Event, Keyframe, LEDGER_DAY, Leg, NO_BUILDING, ROAD_ADDED, ROAD_REMOVED,
    Vehicle,
};
use felix_metro_core::{BuiltRoad, City, Mode, TICKS_PER_DAY};

use super::{Person, State, World, activity_kind, count_car};

/// A `trip` or `replan` event, which holds what a keyframe's vehicle does not:
/// when the trip left (or was moved) and the whole route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Departure {
    pub(crate) depart: u32,
    pub(crate) vehicle: u8,
    pub(crate) route: Vec<Leg>,
    /// The node a replanned trip starts at, or `None` for a trip from a lot.
    pub(crate) node: Option<u32>,
}

impl World {
    /// The world as it stood at the end of tick `at`, which `frames` (one
    /// keyframe per district, taken at `at`) describe. `balances` is each
    /// district's share of the account then, and `departures` the latest `trip`
    /// event of every resident who was on the road.
    ///
    /// Stepping the result gives the records the original would have, as long
    /// as the builds after `at` are applied to it first. A keyframe does not
    /// say when a resident arrived or which of their days it is, so those are
    /// read back from the schedule: see [`block_at`].
    pub(crate) fn restore(
        city: City,
        at: u32,
        frames: &[Keyframe],
        balances: &[i64],
        departures: &HashMap<u32, Departure>,
    ) -> Result<World> {
        let mut world = World::new(city);
        ensure!(
            balances.len() == world.districts(),
            "{} balances for {} districts",
            balances.len(),
            world.districts()
        );
        let mut roads: Vec<BuiltRoad> = frames
            .iter()
            .flat_map(|f| &f.roads)
            .map(|r| BuiltRoad {
                segment: r.segment,
                a: r.a,
                b: r.b,
                removed: r.change == ROAD_REMOVED,
            })
            .collect();
        roads.sort_by_key(|r| r.segment);
        world
            .city
            .restore_roads(&roads)
            .context("the keyframes' roads do not fit this city")?;
        world.roads_changed();
        world.accounts = balances.to_vec();
        ensure!(
            frames.len() == world.districts(),
            "{} keyframes for {} districts",
            frames.len(),
            world.districts()
        );
        world.tick = at + 1;
        let index: HashMap<u32, usize> = world
            .people
            .iter()
            .enumerate()
            .map(|(i, p)| (p.resident.id, i))
            .collect();
        let mut placed = vec![false; world.people.len()];
        for (district, frame) in frames.iter().enumerate() {
            for diff in &frame.buildings {
                ensure!(
                    world.city.lots.get(diff.lot as usize).map(|l| l.district)
                        == Some(district as u16),
                    "district {district}'s keyframe lists lot {} of another district",
                    diff.lot
                );
                world.built.insert(diff.lot, *diff);
            }
            for state in &frame.residents {
                let i = *index.get(&state.id).with_context(|| {
                    format!(
                        "district {district}'s keyframe holds resident {}, who is not in this city",
                        state.id
                    )
                })?;
                ensure!(
                    !placed[i],
                    "resident {} is in two districts' keyframes",
                    state.id
                );
                placed[i] = true;
                let person = &mut world.people[i];
                match &state.doing {
                    Doing::Activity { kind, lot, until } => {
                        let (block, day) = block_at(person, *kind, *lot, *until)?;
                        person.block = block;
                        person.day = day;
                        // Leaving is at `until`, whether that was the schedule or a late arrival.
                        person.state = State::At { since: *until };
                    }
                    Doing::Trip(vehicle) => {
                        let departure = departures.get(&state.id).with_context(|| {
                            format!(
                                "resident {} is on the road at tick {at} with no trip event to say where from",
                                state.id
                            )
                        })?;
                        travelling(&world.city, person, district as u16, vehicle, departure, at)?;
                    }
                }
            }
        }
        if let Some(i) = placed.iter().position(|p| !p) {
            bail!(
                "no district's keyframe holds resident {}",
                world.people[i].resident.id
            );
        }
        for person in &world.people {
            if let State::Travelling { trip, .. } = &person.state {
                count_car(&world.city, &mut world.cars, trip, at);
            }
        }
        Ok(world)
    }

    /// Carries out what a `built`, `demolished` or command `ledger` event in
    /// `district`'s record says. Other events change nothing a restart has to
    /// rebuild: stepping makes them, a day's `ledger` included.
    pub(crate) fn apply_logged(&mut self, district: usize, event: &Event) {
        let diff = match *event {
            Event::Ledger { reason, spent, .. } if reason != LEDGER_DAY => {
                self.accounts[district] -= spent as i64;
                return;
            }
            Event::Roadwork {
                segment,
                change,
                a,
                b,
            } => {
                if change == ROAD_ADDED {
                    // The log is what happened, so a road it names is laid even if this build would not have allowed it.
                    if self.city.add_road(a, b).is_ok() {
                        self.roads_changed();
                    }
                } else if change == ROAD_REMOVED {
                    self.take_away(segment);
                }
                return;
            }
            Event::Built {
                lot,
                kind,
                rotation,
            } => BuildingDiff {
                lot,
                kind,
                rotation,
            },
            Event::Demolished { lot, .. } => BuildingDiff {
                lot,
                kind: NO_BUILDING,
                rotation: 0,
            },
            _ => return,
        };
        self.built.insert(diff.lot, diff);
    }
}

/// The schedule block and day of a resident doing `kind` in `lot` until
/// `until`: the block whose leave tick is the latest one not after `until`
/// (a late arrival leaves the moment it arrives, so `until` can be later than
/// the schedule says).
fn block_at(person: &Person, kind: u8, lot: u32, until: u32) -> Result<(usize, u32)> {
    let schedule = &person.resident.schedule;
    let today = until / TICKS_PER_DAY;
    schedule
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.lot == lot && activity_kind(b.activity) == kind)
        .flat_map(|(block, _)| {
            [today.saturating_sub(1), today]
                .into_iter()
                .map(move |day| (block, day))
        })
        .filter_map(|(block, day)| {
            let leave = schedule.leave_tick(block, day);
            (leave <= until).then(|| (until - leave, block, day))
        })
        .min()
        .map(|(_, block, day)| (block, day))
        .with_context(|| {
            format!(
                "resident {} is {kind} in lot {lot} until {until}, which no block of their day is",
                person.resident.id
            )
        })
}

/// Puts `person` back on the trip `departure` describes, after checking it is
/// the one `vehicle` says they are on.
fn travelling(
    city: &City,
    person: &mut Person,
    district: u16,
    vehicle: &Vehicle,
    departure: &Departure,
    at: u32,
) -> Result<()> {
    let id = person.resident.id;
    let mode = if departure.vehicle == 0 {
        Mode::Walk
    } else {
        Mode::Drive
    };
    let found = match departure.node {
        Some(node) => {
            person
                .resident
                .replan_in_progress(city, node, departure.depart, &departure.route, mode)
        }
        None => person
            .resident
            .trip_in_progress(city, departure.depart, &departure.route, mode),
    };
    let (trip, block, day) = found.with_context(|| {
        format!(
            "resident {id}'s trip event at {} does not join two of their places",
            departure.depart
        )
    })?;
    ensure!(
        trip.arrive() > at,
        "resident {id}'s latest trip ended at {}, before tick {at}",
        trip.arrive()
    );
    // The trip event and the keyframe must be the same journey.
    let (leg, progress) = trip.leg_progress(at);
    ensure!(
        departure.vehicle == vehicle.kind
            && trip.legs()[leg..] == vehicle.route[..]
            && progress == vehicle.progress,
        "resident {id}'s trip event and keyframe disagree about the road at tick {at}"
    );
    person.block = block;
    person.day = day;
    person.state = State::Travelling {
        trip,
        vehicle: vehicle.kind,
        district,
    };
    Ok(())
}
