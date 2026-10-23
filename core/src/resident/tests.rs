use super::*;
use crate::{Door, route::point, schedule::TICKS_PER_DAY};

fn cities() -> Vec<City> {
    let mut out = Vec::new();
    for d in [2, 4] {
        for seed in ["harbor", "pinecrest", "seed-1", "seed-2", "seed-3"] {
            out.push(City::generate(seed, d).unwrap());
        }
    }
    out
}

/// Every nth resident, so a 4x4 city stays quick.
fn sample(places: &Places) -> impl Iterator<Item = u32> {
    (0..places.population()).step_by(7)
}

#[test]
fn lot_ids_are_positions() {
    for city in cities() {
        assert!(
            city.lots
                .iter()
                .enumerate()
                .all(|(i, l)| l.id as usize == i)
        );
    }
}

#[test]
fn every_day_is_a_closed_loop_of_reachable_trips() {
    for city in cities() {
        let places = Places::new(&city);
        for index in sample(&places) {
            let r = Resident::new(&city, &places, index);
            let blocks = &r.schedule.blocks;
            let trips = r.day_trips(&city, 0, &Congestion::FREE).unwrap_or_else(|| {
                panic!("{} resident {index} has an unreachable trip", city.seed)
            });
            assert_eq!(trips.len(), blocks.len());
            let door = |b: usize| city.lots[blocks[b].lot as usize].door().unwrap();
            for (i, trip) in trips.iter().enumerate() {
                let first = trip.position_at(&city, trip.depart);
                let last = trip.position_at(&city, trip.arrive());
                let (from, to) = (door(i), door((i + 1) % blocks.len()));
                let at = |d: Door| point(&city, d.segment, u32::from(d.offset) * 1000);
                assert_eq!((first.x, first.z), at(from));
                assert_eq!((last.x, last.z), at(to));
                if i > 0 {
                    assert!(trip.depart >= trips[i - 1].arrive());
                }
            }
            assert_ne!(blocks[0].lot, blocks[1].lot);
        }
    }
}

#[test]
fn a_day_on_empty_roads_leaves_when_scheduled() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    for index in sample(&places) {
        let r = Resident::new(&city, &places, index);
        for (i, trip) in r
            .day_trips(&city, 3, &Congestion::FREE)
            .unwrap()
            .iter()
            .enumerate()
        {
            assert_eq!(trip.depart, r.schedule.leave_tick(i, 3), "resident {index}");
        }
    }
}

#[test]
fn the_last_trip_of_the_day_ends_before_the_next_begins() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    for index in sample(&places) {
        let r = Resident::new(&city, &places, index);
        let trips = r.day_trips(&city, 0, &Congestion::FREE).unwrap();
        assert!(trips.last().unwrap().arrive() <= TICKS_PER_DAY + r.schedule.blocks[0].leave);
    }
}

#[test]
fn the_population_has_every_archetype_and_distinct_names() {
    let city = City::generate("harbor", 4).unwrap();
    let places = Places::new(&city);
    let mut seen = std::collections::HashSet::new();
    for index in 0..places.population() {
        seen.insert(Resident::new(&city, &places, index).archetype as u8);
    }
    assert_eq!(seen.len(), Archetype::ALL.len());
    let r = Resident::new(&city, &places, 5);
    assert_eq!(r.name(&city), resident_name("harbor", 5));
}

#[test]
fn residents_are_the_same_every_time() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    let a = Resident::new(&city, &places, 9);
    let b = Resident::new(&city, &places, 9);
    assert_eq!(a.schedule.blocks, b.schedule.blocks);
    assert_eq!(a.vehicle, b.vehicle);
    assert_eq!(day_hash("harbor", 2, 9), day_hash("harbor", 2, 9));
    assert_ne!(day_hash("harbor", 2, 9), day_hash("harbor", 2, 10));
    assert_eq!(day_hash("harbor", 2, u32::MAX), None);
}

#[test]
fn a_busy_road_delays_a_day_without_breaking_its_order() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    let counts = vec![40u16; city.segments.len()];
    for index in sample(&places) {
        let r = Resident::new(&city, &places, index);
        let trips = r.day_trips(&city, 0, &Congestion::new(&counts)).unwrap();
        for w in trips.windows(2) {
            assert!(w[1].depart >= w[0].arrive());
        }
    }
}
