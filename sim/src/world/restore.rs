//! Rebuilding a world from the log it wrote: a keyframe and the trips that
//! were under way when it was taken.

use std::collections::HashMap;

use anyhow::{Context, Result, bail, ensure};
use felix_metro_core::record::{
    BuildingDiff, Doing, Event, Keyframe, Leg, NO_BUILDING, RESULT_APPLIED, Vehicle,
};
use felix_metro_core::{City, Mode, TICKS_PER_DAY};

use super::{Person, State, World, activity_kind, count_car};

/// A `trip` event, which holds what a keyframe's vehicle does not: when the
/// trip left and the whole route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Departure {
    pub(crate) depart: u32,
    pub(crate) vehicle: u8,
    pub(crate) route: Vec<Leg>,
}

impl World {
    /// The world as it stood at the end of tick `at`, which `frames` (one
    /// keyframe per district, taken at `at`) describe. `departures` holds the
    /// latest `trip` event of every resident who was on the road.
    ///
    /// Stepping the result gives the records the original would have, as long
    /// as the builds after `at` are applied to it first. A keyframe does not
    /// say when a resident arrived or which of their days it is, so those are
    /// read back from the schedule: see [`block_at`].
    pub(crate) fn restore(
        city: City,
        at: u32,
        frames: &[Keyframe],
        departures: &HashMap<u32, Departure>,
    ) -> Result<World> {
        let mut world = World::new(city);
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

    /// Takes the builders from the `author` events of the keyframe tick the
    /// world was restored at. A keyframe lists the buildings but not who built
    /// them, so the log says it alongside.
    pub(crate) fn restore_authors<'a>(&mut self, events: impl Iterator<Item = &'a Event>) {
        for event in events {
            let Event::Author {
                principal,
                name,
                lots,
            } = event
            else {
                continue;
            };
            for a in lots {
                if (a.lot as usize) < self.city.lots.len() {
                    self.set_author(a.lot, a.built, *principal, name);
                }
            }
        }
    }

    /// Carries out what the `built` and `demolished` events of one district's
    /// record for `tick` say, and whose command they were. Other events change
    /// nothing a restart has to rebuild: stepping makes them.
    pub(crate) fn apply_logged(&mut self, tick: u32, events: &[Event]) {
        // A `built` or `demolished` comes right after the `command` that caused it.
        let mut by: Option<(u64, &str)> = None;
        for event in events {
            match event {
                Event::Command {
                    principal,
                    name,
                    result: RESULT_APPLIED,
                    ..
                } => by = Some((*principal, name)),
                Event::Built {
                    lot,
                    kind,
                    rotation,
                } => {
                    self.built.insert(
                        *lot,
                        BuildingDiff {
                            lot: *lot,
                            kind: *kind,
                            rotation: *rotation,
                        },
                    );
                    if let Some((principal, name)) = by.take() {
                        self.set_author(*lot, tick, principal, name);
                    }
                }
                Event::Demolished { lot, .. } => {
                    self.built.insert(
                        *lot,
                        BuildingDiff {
                            lot: *lot,
                            kind: NO_BUILDING,
                            rotation: 0,
                        },
                    );
                    self.authors.remove(lot);
                    by = None;
                }
                _ => {}
            }
        }
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
    let (trip, block, day) = person
        .resident
        .trip_in_progress(city, departure.depart, &departure.route, mode)
        .with_context(|| {
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
