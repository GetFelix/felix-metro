use std::collections::HashMap;

use felix_metro_core::record::{Doing, Event, Header, TickRecord};
use felix_metro_core::{City, TICKS_PER_DAY};

use super::*;

fn day(seed: &str, side: u16) -> (World, Vec<Vec<DistrictTick>>) {
    let mut world = World::new(City::generate(seed, side).unwrap());
    let ticks = (0..TICKS_PER_DAY).map(|_| world.step()).collect();
    (world, ticks)
}

#[test]
fn every_tick_has_a_step_for_every_district() {
    let (world, ticks) = day("harbor", 2);
    assert_eq!(world.next_tick(), TICKS_PER_DAY);
    assert_eq!(ticks.len(), TICKS_PER_DAY as usize);
    assert!(ticks.iter().all(|t| t.len() == 4));
}

#[test]
fn a_city_steps_the_same_way_twice() {
    let (_, a) = day("harbor", 2);
    let (_, b) = day("harbor", 2);
    assert!(a == b);
}

#[test]
fn keyframes_come_every_city_hour_and_hold_every_resident() {
    let (world, ticks) = day("harbor", 2);
    for (tick, step) in ticks.iter().enumerate() {
        let keyframe = (tick as u32).is_multiple_of(KEYFRAME_EVERY);
        assert!(step.iter().all(|d| d.keyframe.is_some() == keyframe));
        if !keyframe {
            continue;
        }
        let frames: Vec<_> = step.iter().map(|d| d.keyframe.as_ref().unwrap()).collect();
        let held: usize = frames.iter().map(|k| k.residents.len()).sum();
        assert_eq!(held, world.residents(), "tick {tick}");
        for frame in frames {
            assert!(frame.residents.windows(2).all(|p| p[0].id < p[1].id));
            let on_road = frame
                .residents
                .iter()
                .filter(|r| matches!(r.doing, Doing::Trip(_)))
                .count();
            assert_eq!(frame.counts.on_road as usize, on_road);
        }
    }
}

#[test]
fn a_day_has_trips_and_each_one_arrives() {
    let (world, ticks) = day("harbor", 2);
    let mut leaving: HashMap<u32, u32> = HashMap::new();
    let (mut trips, mut arrivals) = (0, 0);
    for (tick, step) in ticks.iter().enumerate() {
        for event in step.iter().flat_map(|d| &d.events) {
            match event {
                Event::Trip {
                    resident, depart, ..
                } => {
                    assert_eq!(*depart as usize, tick);
                    assert!(leaving.insert(*resident, *depart).is_none());
                    trips += 1;
                }
                Event::Arrived { resident, .. } => {
                    assert!(
                        leaving.remove(resident).is_some(),
                        "arrived without leaving"
                    );
                    arrivals += 1;
                }
                _ => {}
            }
        }
    }
    assert!(trips > world.residents(), "{trips} trips");
    // Whoever is still out at midnight is on the way home or to work.
    assert_eq!(trips - arrivals, leaving.len());
}

#[test]
fn a_resident_crossing_a_boundary_leaves_one_district_and_enters_another_in_the_same_tick() {
    let (_, ticks) = day("harbor", 2);
    let mut crossings = 0;
    for step in &ticks {
        let mut left = Vec::new();
        let mut entered = Vec::new();
        for (district, d) in step.iter().enumerate() {
            for event in &d.events {
                match event {
                    Event::Left {
                        resident,
                        district: to,
                        vehicle,
                    } => {
                        left.push((*resident, district as u16, *to, vehicle.clone()));
                    }
                    Event::Entered {
                        resident,
                        district: from,
                        vehicle,
                    } => {
                        entered.push((*resident, *from, district as u16, vehicle.clone()));
                    }
                    _ => {}
                }
            }
        }
        left.sort_by_key(|e| e.0);
        entered.sort_by_key(|e| e.0);
        assert_eq!(left, entered);
        crossings += left.len();
    }
    assert!(crossings > 0, "nobody crossed a district boundary in a day");
}

#[test]
fn every_record_encodes_and_decodes() {
    let (_, ticks) = day("pinecrest", 2);
    for (tick, step) in ticks.into_iter().enumerate() {
        for (district, d) in step.into_iter().enumerate() {
            let record = TickRecord {
                header: Header {
                    epoch: 0,
                    district: district as u16,
                    tick: tick as u32,
                    speed: 4,
                    keyframe_offset: 0,
                    wall_us: 0,
                },
                keyframe: d.keyframe,
                events: d.events,
            };
            let bytes = record.encode().unwrap();
            assert_eq!(TickRecord::decode(&bytes).unwrap(), record);
        }
    }
}

#[test]
fn the_second_day_carries_on_from_the_first() {
    let mut world = World::new(City::generate("harbor", 2).unwrap());
    let steps: Vec<_> = (0..2 * TICKS_PER_DAY).map(|_| world.step()).collect();
    let trips_on = |day: usize| {
        steps[day * TICKS_PER_DAY as usize..(day + 1) * TICKS_PER_DAY as usize]
            .iter()
            .flatten()
            .flat_map(|d| &d.events)
            .filter(|e| matches!(e, Event::Trip { .. }))
            .count()
    };
    let (first, second) = (trips_on(0), trips_on(1));
    // Day two starts with everyone where day one left them, so it is as busy.
    assert!(
        second * 10 > first * 9 && second * 9 < first * 10 + first,
        "{first} then {second}"
    );
}

/// Which district each resident's vehicle is in, from the events alone.
/// Panics on an event that does not fit: a vehicle leaving or arriving in a
/// district it is not in.
fn follow_vehicles(step: &[DistrictTick], vehicles: &mut HashMap<u32, u16>) {
    // Districts are listed in order, so a vehicle's `entered` can come before
    // its `left`, and its `arrived` follows both: left, then in, then arrived.
    for pass in 0..3 {
        for (district, d) in step.iter().enumerate() {
            let district = district as u16;
            for event in &d.events {
                match (pass, event) {
                    (0, Event::Left { resident, .. }) => {
                        assert_eq!(vehicles.remove(resident), Some(district), "left");
                    }
                    (1, Event::Trip { resident, .. } | Event::Entered { resident, .. }) => {
                        assert!(vehicles.insert(*resident, district).is_none(), "in");
                    }
                    (2, Event::Arrived { resident, .. }) => {
                        assert_eq!(vehicles.remove(resident), Some(district), "arrived");
                    }
                    _ => {}
                }
            }
        }
    }
}

#[test]
fn a_vehicle_is_in_the_district_the_events_say_even_on_its_last_step() {
    let (_, ticks) = day("harbor", 2);
    let mut vehicles = HashMap::new();
    for (tick, step) in ticks.iter().enumerate() {
        follow_vehicles(step, &mut vehicles);
        if let Some(Some(_)) = step.first().map(|d| &d.keyframe) {
            let mut drawn = HashMap::new();
            for (district, d) in step.iter().enumerate() {
                for r in &d.keyframe.as_ref().unwrap().residents {
                    if matches!(r.doing, Doing::Trip(_)) {
                        drawn.insert(r.id, district as u16);
                    }
                }
            }
            assert_eq!(vehicles, drawn, "tick {tick}");
        }
    }
}
