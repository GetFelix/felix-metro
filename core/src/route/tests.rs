use super::*;
use crate::rng::Rng;

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
        ] {
            out.push(City::generate(seed, d).unwrap());
        }
    }
    out
}

fn doors(city: &City) -> Vec<Door> {
    city.lots.iter().filter_map(|l| l.door()).collect()
}

fn pairs(city: &City, n: usize) -> Vec<(Door, Door)> {
    let doors = doors(city);
    let mut rng = Rng::new(&city.seed);
    (0..n)
        .map(|_| (doors[rng.below(doors.len())], doors[rng.below(doors.len())]))
        .collect()
}

fn start(city: &City, door: Door) -> (u32, u32) {
    point(city, door.segment, u32::from(door.offset) * 1000)
}

#[test]
fn finds_a_path_between_any_two_doors() {
    for city in cities() {
        for (a, b) in pairs(&city, 150) {
            assert!(
                route(&city, a, b, 0, &Congestion::FREE).is_some(),
                "{}",
                city.seed
            );
        }
        // Every door reaches the tower, which catches an island the sample missed.
        let tower = city.tower().door().unwrap();
        for a in doors(&city) {
            assert!(route(&city, a, tower, 0, &Congestion::FREE).is_some());
        }
    }
}

#[test]
fn legs_join_up_from_door_to_door() {
    for city in cities() {
        for (a, b) in pairs(&city, 60) {
            let trip = route(&city, a, b, 10, &Congestion::FREE).unwrap();
            assert_eq!(trip.position_at(&city, 10).x, start(&city, a).0);
            assert_eq!(
                {
                    let p = trip.position_at(&city, trip.arrive());
                    (p.x, p.z)
                },
                start(&city, b)
            );
            for pair in trip.legs.windows(2) {
                let end = point(&city, pair[0].segment, pair[0].to);
                let next = point(&city, pair[1].segment, pair[1].from);
                assert_eq!(end, next, "{}", city.seed);
            }
        }
    }
}

#[test]
fn the_guided_search_costs_what_plain_dijkstra_does() {
    for city in cities() {
        let jam: Vec<u16> = (0..city.segments.len())
            .map(|i| (i % 7) as u16 * 1000)
            .collect();
        for cong in [Congestion::FREE, Congestion::new(&jam)] {
            for (a, b) in pairs(&city, 40) {
                if a.segment == b.segment {
                    continue;
                }
                let guided = search(&city, a, b, &cong, Mode::Drive, true).unwrap().0;
                let plain = search(&city, a, b, &cong, Mode::Drive, false).unwrap().0;
                assert_eq!(guided, plain, "{}", city.seed);
            }
        }
    }
}

#[test]
fn a_jam_moves_the_route_and_slows_the_trip() {
    let city = City::generate("harbor", 4).unwrap();
    let (mut moved, mut tested) = (0, 0);
    for (a, b) in pairs(&city, 80) {
        let free = route(&city, a, b, 0, &Congestion::FREE).unwrap();
        if free.mode == Mode::Walk || free.legs.len() < 5 {
            continue;
        }
        let mid = free.legs[free.legs.len() / 2].segment;
        let mut counts = vec![0u16; city.segments.len()];
        counts[mid as usize] = 500;
        let jammed = route(&city, a, b, 0, &Congestion::new(&counts)).unwrap();
        tested += 1;
        if jammed.legs.iter().all(|l| l.segment != mid) {
            moved += 1;
        } else {
            assert!(jammed.arrive() > free.arrive());
        }
    }
    assert!(tested > 10);
    assert!(moved > 0, "no jammed route went around");
}

#[test]
fn jam_slows_a_segment_but_never_below_the_floor() {
    let counts = [0u16, 6, 3000];
    let cong = Congestion::new(&counts);
    assert_eq!(cong.percent(0, 4), 100);
    assert_eq!(cong.percent(1, 4), 66);
    assert_eq!(cong.percent(2, 4), MIN_PERCENT);
    assert_eq!(cong.percent(9, 4), 100);
}

#[test]
fn short_trips_walk_and_long_ones_drive() {
    let city = City::generate("harbor", 4).unwrap();
    let (mut walks, mut drives) = (0, 0);
    for (a, b) in pairs(&city, 200) {
        let trip = route(&city, a, b, 0, &Congestion::FREE).unwrap();
        match trip.mode {
            Mode::Walk => {
                walks += 1;
                assert!(trip.length() <= WALK_MAX);
                // 300 thousandths of a tile a second.
                for leg in &trip.legs {
                    let seg = &city.segments[leg.segment as usize];
                    assert_eq!(u32::from(seg.speed) * u32::from(leg.speed) / 100, 300);
                }
            }
            Mode::Drive => {
                drives += 1;
                assert!(trip.length() > WALK_MAX);
            }
        }
    }
    assert!(walks > 0 && drives > 0);
}

#[test]
fn position_never_goes_backwards_along_the_route() {
    for city in cities() {
        let jam: Vec<u16> = (0..city.segments.len())
            .map(|i| (i % 5) as u16 * 4)
            .collect();
        for cong in [Congestion::FREE, Congestion::new(&jam)] {
            for (a, b) in pairs(&city, 25) {
                let trip = route(&city, a, b, 100, &cong).unwrap();
                let (mut last_dist, mut last_leg) = (0, 0);
                let mut last_in_leg = (0, 0);
                for tick in 90..=trip.arrive() + 5 {
                    let dist = trip.distance_at(tick);
                    assert!(dist >= last_dist);
                    last_dist = dist;
                    let p = trip.position_at(&city, tick);
                    assert!(p.leg >= last_leg);
                    let leg = &trip.legs[usize::from(p.leg)];
                    let travelled = leg.from.abs_diff(p.offset);
                    if p.leg == last_leg {
                        assert!(travelled >= last_in_leg.1 || last_in_leg.0 != p.leg);
                    }
                    assert!(p.offset >= leg.from.min(leg.to) && p.offset <= leg.from.max(leg.to));
                    (last_leg, last_in_leg) = (p.leg, (p.leg, travelled));
                }
                assert_eq!(last_dist, trip.length());
            }
        }
    }
}

#[test]
fn a_trip_holds_still_before_it_leaves_and_after_it_ends() {
    let city = City::generate("harbor", 2).unwrap();
    let (a, b) = pairs(&city, 1)[0];
    let trip = route(&city, a, b, 500, &Congestion::FREE).unwrap();
    assert_eq!(trip.position_at(&city, 0), trip.position_at(&city, 500));
    assert_eq!(
        trip.position_at(&city, trip.arrive()),
        trip.position_at(&city, trip.arrive() + 1000)
    );
}

#[test]
fn a_door_to_itself_is_a_one_leg_trip() {
    let city = City::generate("harbor", 2).unwrap();
    let d = doors(&city)[3];
    let trip = route(&city, d, d, 7, &Congestion::FREE).unwrap();
    assert_eq!(trip.legs.len(), 1);
    assert_eq!(trip.length(), 0);
}

#[test]
fn trips_have_no_zero_length_legs() {
    for city in cities() {
        for (a, b) in pairs(&city, 60) {
            let trip = route(&city, a, b, 0, &Congestion::FREE).unwrap();
            assert!(
                trip.legs.len() == 1 || trip.legs.iter().all(|l| l.from != l.to),
                "{}",
                city.seed
            );
        }
    }
}

#[test]
fn a_walked_trip_takes_the_shortest_way_whatever_the_traffic() {
    let city = City::generate("harbor", 4).unwrap();
    let (mut walks, mut multi) = (0, 0);
    for (a, b) in pairs(&city, 300) {
        let free = route(&city, a, b, 0, &Congestion::FREE).unwrap();
        if free.mode != Mode::Walk {
            continue;
        }
        walks += 1;
        let mut counts = vec![0u16; city.segments.len()];
        for l in &free.legs {
            counts[l.segment as usize] = 3000;
        }
        let jam = route(&city, a, b, 0, &Congestion::new(&counts)).unwrap();
        assert_eq!(jam.mode, Mode::Walk);
        assert_eq!(free.legs(), jam.legs());
        multi += usize::from(free.legs.len() > 1);
    }
    assert!(walks > 0 && multi > 0);
}

#[test]
fn leg_progress_follows_position_at_and_never_goes_back() {
    for city in cities() {
        for (a, b) in pairs(&city, 40) {
            let Some(trip) = route(&city, a, b, 100, &Congestion::FREE) else {
                continue;
            };
            let last = trip.legs().len() - 1;
            assert_eq!(trip.leg_progress(0), (0, 0));
            assert_eq!(trip.leg_progress(trip.arrive() + 50), (last, 1000));
            let mut before = (0, 0);
            for tick in trip.depart..=trip.arrive() {
                let now = trip.leg_progress(tick);
                assert_eq!(now.0, usize::from(trip.position_at(&city, tick).leg));
                assert!(now.1 <= 1000 && now >= before, "{before:?} then {now:?}");
                before = now;
            }
        }
    }
}
