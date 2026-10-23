use super::*;
use crate::{Door, rng::Rng, route::point, schedule::TICKS_PER_DAY};

fn cities() -> Vec<City> {
    let mut out = Vec::new();
    for d in [2, 4] {
        for seed in [
            "harbor",
            "pinecrest",
            "seed-1",
            "seed-2",
            "seed-3",
            "seed-4",
            "seed-5",
        ] {
            out.push(City::generate(seed, d).unwrap());
        }
    }
    out
}

/// Every nth resident, so a 4x4 city stays quick.
fn sample(places: &Places) -> impl Iterator<Item = u32> {
    (0..places.population()).step_by(7)
}

fn all(places: &Places) -> impl Iterator<Item = u32> {
    0..places.population()
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
        for index in all(&places) {
            let r = Resident::new(&city, &places, index)
                .unwrap_or_else(|| panic!("{} resident {index} has nowhere to go", city.seed));
            let blocks = &r.schedule.blocks;
            let trips = r
                .day_trips(&city, 0, &Congestion::FREE, 0)
                .unwrap_or_else(|| {
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
        let r = Resident::new(&city, &places, index).unwrap();
        for (i, trip) in r
            .day_trips(&city, 3, &Congestion::FREE, 0)
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
        let r = Resident::new(&city, &places, index).unwrap();
        let trips = r.day_trips(&city, 0, &Congestion::FREE, 0).unwrap();
        assert!(trips.last().unwrap().arrive() <= TICKS_PER_DAY + r.schedule.blocks[0].leave);
    }
}

#[test]
fn the_population_has_every_archetype_and_distinct_names() {
    let city = City::generate("harbor", 4).unwrap();
    let places = Places::new(&city);
    let mut seen = std::collections::HashSet::new();
    for index in 0..places.population() {
        seen.insert(Resident::new(&city, &places, index).unwrap().archetype as u8);
    }
    assert_eq!(seen.len(), Archetype::ALL.len());
    let r = Resident::new(&city, &places, 5).unwrap();
    assert_eq!(r.name(&city), resident_name("harbor", 5));
}

#[test]
fn residents_are_the_same_every_time() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    let a = Resident::new(&city, &places, 9).unwrap();
    let b = Resident::new(&city, &places, 9).unwrap();
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
        let r = Resident::new(&city, &places, index).unwrap();
        let trips = r.day_trips(&city, 0, &Congestion::new(&counts), 0).unwrap();
        for w in trips.windows(2) {
            assert!(w[1].depart >= w[0].arrive());
        }
    }
}

#[test]
fn a_late_night_carries_into_the_next_day() {
    // Even a floor-speed jam leaves the schedule's slack intact, so the late
    // return is forced by handing the next day a later free tick.
    let counts = vec![3000u16; 4096];
    let cong = Congestion::new(&counts);
    for city in cities() {
        let places = Places::new(&city);
        for index in sample(&places) {
            let r = Resident::new(&city, &places, index).unwrap();
            let day0 = r.day_trips(&city, 0, &cong, 0).unwrap();
            let end = day0.last().unwrap().arrive();
            let late = end.max(r.schedule.leave_tick(0, 1)) + 40;
            let day1 = r.day_trips(&city, 1, &cong, late).unwrap();
            assert_eq!(day1[0].depart, late, "{} resident {index}", city.seed);
            for w in day1.windows(2) {
                assert!(w[1].depart >= w[0].arrive());
            }
        }
    }
}

#[test]
fn nothing_to_pick_is_none() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    let mut rng = Rng::new("x");
    let home = places.homes[0];
    assert_eq!(
        pick(&city, &places, &mut rng, &[], &[], home, &[home]),
        None
    );
    assert_eq!(
        pick(&city, &places, &mut rng, &[home], &[home], home, &[home]),
        None
    );
}
