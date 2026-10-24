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
        pick::<3>(&city, &places, &mut rng, &[], &[], home, &[home]),
        None
    );
    assert_eq!(
        pick::<3>(&city, &places, &mut rng, &[home], &[home], home, &[home]),
        None
    );
}

/// A trip the way a reader of the log has it: from the legs alone.
fn same_trip(city: &City, a: &Trip, b: &Trip) {
    assert_eq!(a.mode, b.mode);
    assert_eq!(a.depart, b.depart);
    assert_eq!(a.legs(), b.legs());
    assert_eq!(a.arrive(), b.arrive());
    for tick in a.depart..=a.arrive() + 1 {
        assert_eq!(a.position_at(city, tick), b.position_at(city, tick));
    }
}

#[test]
fn a_trip_event_gives_back_the_trip_it_came_from() {
    let jam: Vec<u16> = (0..4096).map(|i| (i % 5) as u16 * 6).collect();
    let mut checked = 0;
    for city in cities() {
        let places = Places::new(&city);
        for index in all(&places).step_by(3) {
            let r = Resident::new(&city, &places, index).unwrap();
            for cong in [Congestion::FREE, Congestion::new(&jam)] {
                for day in [0, 1] {
                    let free_at = day * TICKS_PER_DAY;
                    for trip in r.day_trips(&city, day, &cong, free_at).unwrap() {
                        let mode = trip.mode;
                        let back = r
                            .trip_from_route(&city, trip.depart, &trip.legs(), mode)
                            .unwrap_or_else(|| panic!("{} resident {index}", city.seed));
                        same_trip(&city, &trip, &back);
                        checked += 1;
                    }
                }
            }
        }
    }
    assert!(checked > 2000, "{checked}");
}

#[test]
fn legs_that_join_no_doors_are_no_trip() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    // A trip of one leg cannot be cut short, so look for one of several.
    let (r, trip) = all(&places)
        .filter_map(|index| Resident::new(&city, &places, index))
        .find_map(|r| {
            let trips = r.day_trips(&city, 0, &Congestion::FREE, 0)?;
            let trip = trips.into_iter().find(|t| t.legs().len() > 1)?;
            Some((r, trip))
        })
        .expect("some resident makes a trip of more than one leg");
    let mut legs = trip.legs();
    assert!(
        r.trip_from_route(&city, trip.depart, &[], trip.mode)
            .is_none()
    );
    // Cut short, the legs stop before the door the trip is going to.
    assert!(
        r.trip_from_route(&city, trip.depart, &legs[..legs.len() - 1], trip.mode)
            .is_none()
    );
    legs[0].segment = u32::MAX;
    assert!(
        r.trip_from_route(&city, trip.depart, &legs, trip.mode)
            .is_none()
    );
}

/// Cars and walkers on the road of harbor at tick `tick` of its first day, on empty roads.
fn on_the_road(tick: u32) -> (u32, u32) {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    let (mut cars, mut walkers) = (0, 0);
    for index in 0..places.population() {
        let r = Resident::new(&city, &places, index).unwrap();
        for trip in r.day_trips(&city, 0, &Congestion::FREE, 0).unwrap() {
            if (trip.depart..=trip.arrive()).contains(&tick) {
                match trip.mode {
                    Mode::Drive => cars += 1,
                    Mode::Walk => walkers += 1,
                }
            }
        }
    }
    (cars, walkers)
}

#[test]
fn rush_hour_fills_the_streets() {
    for (name, tick) in [("08:00", 8 * 240), ("17:15", 17 * 240 + 60)] {
        let (cars, walkers) = on_the_road(tick);
        assert!(cars >= 40, "{name}: {cars} cars");
        assert!(walkers >= 2, "{name}: {walkers} walkers");
    }
}

#[test]
fn the_development_area_does_not_shrink_the_population() {
    for city in cities() {
        let homes = city
            .lots
            .iter()
            .filter(|l| l.door().is_some() && l.zone == Zone::Suburban)
            .count() as u32;
        let places = Places::new(&city);
        assert_eq!(places.population(), homes * PER_HOME, "{}", city.seed);
        let used: std::collections::HashSet<u32> = all(&places)
            .map(|i| {
                places.homes[(u64::from(i) * places.homes.len() as u64
                    / u64::from(places.population)) as usize]
            })
            .collect();
        assert_eq!(used.len(), places.homes.len(), "every home is lived in");
    }
}

#[test]
fn the_pavements_are_busy_at_the_rush_and_at_lunch() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::new(&city);
    let trips: Vec<Trip> = all(&places)
        .flat_map(|i| {
            let r = Resident::new(&city, &places, i).unwrap();
            r.day_trips(&city, 0, &Congestion::FREE, 0).unwrap()
        })
        .collect();
    let walkers = |tick: u32| {
        trips
            .iter()
            .filter(|t| t.mode == Mode::Walk && (t.depart..=t.arrive()).contains(&tick))
            .count()
    };
    let most = |from: u32, to: u32| (from..to).map(walkers).max().unwrap();
    let h = crate::schedule::TICKS_PER_HOUR;
    assert!(most(7 * h, 9 * h) >= 40);
    assert!(most(12 * h, 13 * h) >= 25);
}
