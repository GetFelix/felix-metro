use std::collections::HashMap;

use felix_metro_core::record::{Doing, Event, Header, TickRecord};
use felix_metro_core::{City, Mode, Places, Resident, TICKS_PER_DAY, TICKS_PER_HOUR};

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

/// The page previews a whole-city keyframe while scrubbing, which needs every district's keyframe on
/// one tick.
#[test]
fn every_district_keyframes_on_the_same_tick() {
    let mut world = World::new(City::generate("harbor", 2).unwrap());
    let districts = world.districts();
    let mut keyframe_ticks = Vec::new();
    for tick in 0..2 * KEYFRAME_EVERY + 1 {
        let with = world.step().iter().filter(|d| d.keyframe.is_some()).count();
        assert!(
            with == 0 || with == districts,
            "tick {tick}: {with} of {districts}"
        );
        if with > 0 {
            keyframe_ticks.push(tick);
        }
    }
    assert_eq!(keyframe_ticks, [0, KEYFRAME_EVERY, 2 * KEYFRAME_EVERY]);
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
fn a_reader_of_the_log_places_every_trip_and_ends_it_when_the_sim_does() {
    // The browser has only the `trip` event: it must rebuild the trip from it, congestion and all.
    for side in [2, 3] {
        let (world, ticks) = day("harbor", side);
        let city = &world.city;
        let places = Places::new(city);
        let mut ends: HashMap<u32, u32> = HashMap::new();
        let (mut placed, mut seen) = (0, 0);
        for (tick, step) in ticks.iter().enumerate() {
            for event in step.iter().flat_map(|d| &d.events) {
                match event {
                    Event::Trip {
                        resident,
                        vehicle,
                        depart,
                        route,
                    } => {
                        let mode = if *vehicle == 0 {
                            Mode::Walk
                        } else {
                            Mode::Drive
                        };
                        let trip = Resident::new(city, &places, *resident)
                            .unwrap()
                            .trip_from_route(city, *depart, route, mode)
                            .unwrap_or_else(|| panic!("resident {resident} at {depart}"));
                        ends.insert(*resident, trip.arrive());
                        placed += 1;
                    }
                    Event::Arrived { resident, .. } => {
                        assert_eq!(ends[resident] as usize, tick, "resident {resident}");
                        seen += 1;
                    }
                    _ => {}
                }
            }
        }
        assert!(placed > world.residents());
        assert!(seen > 0);
    }
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
                    } => {
                        left.push((*resident, district as u16, *to));
                    }
                    Event::Entered {
                        resident,
                        district: from,
                        ..
                    } => {
                        entered.push((*resident, *from, district as u16));
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

#[test]
fn keyframes_list_the_lots_that_differ_from_the_generated_city() {
    use felix_metro_core::record::{BuildingDiff, NO_BUILDING};
    let mut world = World::new(City::generate("harbor", 2).unwrap());
    let (a, b, same) = (3usize, 40usize, 7usize);
    let (la, lb, ls) = (
        world.city.lots[a].clone(),
        world.city.lots[b].clone(),
        world.city.lots[same].clone(),
    );
    world.set_building(BuildingDiff {
        lot: a as u32,
        kind: NO_BUILDING,
        rotation: 0,
    });
    world.set_building(BuildingDiff {
        lot: b as u32,
        kind: u16::from(lb.kind.0),
        rotation: (lb.facing + 1) % 4,
    });
    // Set back to what generation made: not a difference.
    world.set_building(BuildingDiff {
        lot: same as u32,
        kind: u16::from(ls.kind.0),
        rotation: ls.facing,
    });
    let frames = world.keyframes(0);
    let listed: Vec<_> = frames
        .iter()
        .flat_map(|f| f.buildings.iter().map(|d| d.lot))
        .collect();
    assert_eq!(listed, {
        let mut want = vec![a as u32, b as u32];
        want.sort_by_key(|l| (world.city.lots[*l as usize].district, *l));
        want
    });
    assert!(
        frames[usize::from(la.district)]
            .buildings
            .iter()
            .any(|d| d.lot == a as u32)
    );
    assert!(
        frames[usize::from(lb.district)]
            .buildings
            .iter()
            .any(|d| d.lot == b as u32)
    );
}

#[test]
fn state_at_is_the_keyframe_the_step_commits() {
    let city = || City::generate("harbor", 2).unwrap();
    let mut world = World::new(city());
    let mut steps = (0..=480).map(|_| world.step()).collect::<Vec<_>>();
    let committed: Vec<_> = steps
        .remove(480)
        .into_iter()
        .map(|d| d.keyframe.unwrap())
        .collect();
    assert_eq!(state_at(city(), 480), committed);
}

/// What a city day writes, from the encoded records. A record's header is fixed, so the rest scales
/// with residents: the 20,000 figures extrapolate from this city's population that way and spread
/// it over 16 districts.
struct Load {
    /// Bytes of a record with nothing in it, at the largest tick and offset a live run reaches.
    header: usize,
    residents: usize,
    districts: usize,
    day_mean: f64,
    day_mean_at_20k: f64,
    rushes: Vec<Rush>,
}

/// The worst moments of one rush hour window.
struct Rush {
    name: &'static str,
    /// The district, tick and size in bytes of the largest record.
    worst_tick: (usize, usize, usize),
    /// The largest record that carries no keyframe.
    worst_plain: usize,
    /// Bytes per second of the busiest minute, city-wide and in the busiest district.
    city: f64,
    district: f64,
    at_20k: f64,
}

fn measure_load(world: &World, ticks: &[Vec<DistrictTick>]) -> Load {
    let districts = world.districts();
    let residents = world.residents();
    let seconds = f64::from(TICKS_PER_DAY) / 4.0;
    // Bytes of each district's record at each tick, and the keyframe's share of it.
    let mut bytes = vec![vec![0usize; districts]; ticks.len()];
    let mut key = bytes.clone();
    // A live run's tick and keyframe offset grow, and each is a varint. Measure the header at the
    // size it has after 2^21 ticks (about six days), its largest, and charge every record that.
    let header_len = |tick: u32, keyframe_offset: u64| {
        TickRecord {
            header: Header {
                epoch: 1,
                district: 0,
                tick,
                speed: 4,
                keyframe_offset,
                wall_us: 0,
            },
            keyframe: None,
            events: Vec::new(),
        }
        .encode()
        .unwrap()
        .len()
    };
    let header = header_len(1 << 21, 1 << 21);
    for (tick, step) in ticks.iter().enumerate() {
        for (d, t) in step.iter().enumerate() {
            let record = TickRecord {
                header: Header {
                    epoch: 1,
                    district: d as u16,
                    tick: tick as u32,
                    speed: 4,
                    keyframe_offset: 0,
                    wall_us: 0,
                },
                keyframe: None,
                events: t.events.clone(),
            };
            let measured = record.encode().unwrap().len();
            let plain = measured - header_len(tick as u32, 0) + header;
            bytes[tick][d] = plain;
            if let Some(k) = &t.keyframe {
                let with = TickRecord {
                    keyframe: Some(k.clone()),
                    ..record
                };
                key[tick][d] = with.encode().unwrap().len() - measured;
            }
        }
    }
    let day_total: usize = bytes.iter().flatten().chain(key.iter().flatten()).sum();
    let day_fixed = districts * ticks.len() * header;
    let day_at_20k = (16 * ticks.len() * header) as f64
        + (day_total - day_fixed) as f64 / residents as f64 * 20_000.0;
    let hour = TICKS_PER_HOUR as usize;
    let windows = [
        ("07:45-08:15", hour * 31 / 4, hour * 33 / 4),
        ("17:00-17:30", hour * 17, hour * 35 / 2),
    ];
    // A city hour is a minute at 4 ticks a second, so a 1-minute window is `hour` ticks.
    let minute = hour;
    let rushes = windows
        .into_iter()
        .map(|(name, from, to)| {
            let mut worst_tick = (0, 0, 0usize);
            let mut worst_plain = 0;
            for t in from..to {
                for d in 0..districts {
                    if bytes[t][d] + key[t][d] > worst_tick.2 {
                        worst_tick = (t, d, bytes[t][d] + key[t][d]);
                    }
                    worst_plain = worst_plain.max(bytes[t][d]);
                }
            }
            // City-wide and busiest-district bytes over every 1-minute window that starts in the rush window.
            let sum = |a: usize, b: usize, d: Option<usize>| -> usize {
                (a..b)
                    .flat_map(|t| (0..districts).map(move |x| (t, x)))
                    .filter(|&(_, x)| d.is_none_or(|d| d == x))
                    .map(|(t, x)| bytes[t][x] + key[t][x])
                    .sum()
            };
            let city = (from..to).map(|a| sum(a, a + minute, None)).max().unwrap();
            let district = (0..districts)
                .map(|d| {
                    (from..to)
                        .map(|a| sum(a, a + minute, Some(d)))
                        .max()
                        .unwrap()
                })
                .max()
                .unwrap();
            // The headers take `districts * minute * header` of any minute; the rest is per resident.
            let fixed = districts * minute * header;
            let per_resident = (city - fixed) as f64 / residents as f64;
            let at_20k = (16 * minute * header) as f64 + per_resident * 20_000.0;
            Rush {
                name,
                worst_tick,
                worst_plain,
                city: city as f64 / 60.0,
                district: district as f64 / 60.0,
                at_20k: at_20k / 60.0,
            }
        })
        .collect();
    Load {
        header,
        residents,
        districts,
        day_mean: day_total as f64 / seconds,
        day_mean_at_20k: day_at_20k / seconds,
        rushes,
    }
}

fn print_load(label: &str, load: &Load) {
    println!(
        "{label}: {} residents, {} districts, {} B header: day mean {:.1} B/s; at 20,000 residents in 16 districts {:.0} B/s",
        load.residents, load.districts, load.header, load.day_mean, load.day_mean_at_20k
    );
    for r in &load.rushes {
        println!(
            "{}: worst tick {} B (district {} tick {}, {} B without a keyframe); worst minute {:.0} B/s city, {:.0} B/s one district; at 20,000 residents in 16 districts {:.0} B/s",
            r.name,
            r.worst_tick.2,
            r.worst_tick.1,
            r.worst_tick.0,
            r.worst_plain,
            r.city,
            r.district,
            r.at_20k
        );
    }
}

/// Prints what a city day writes, per district, and the worst moments of the two rush hours, for
/// the harbor city and for the same city with 64 residents a home, which has about the load per
/// district of 20,000 residents in 16:
/// `cargo test -p felix-metro-sim --release report_load -- --ignored --nocapture`.
#[test]
#[ignore = "prints a measurement"]
fn report_load() {
    let (world, ticks) = day("harbor", 2);
    print_load("harbor", &measure_load(&world, &ticks));
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::with_per_home(&city, 64);
    let mut world = World::with_places(city, &places);
    let ticks: Vec<_> = (0..TICKS_PER_DAY).map(|_| world.step()).collect();
    print_load("dense harbor", &measure_load(&world, &ticks));
}

/// The log's goal is about 10 KB/s in the busiest minute of a rush at 20,000 residents.
#[test]
fn the_busiest_minute_of_a_rush_stays_under_ten_kilobytes_a_second() {
    let (world, ticks) = day("harbor", 2);
    let load = measure_load(&world, &ticks);
    assert_eq!(load.header, 22, "the header is charged at its largest");
    for r in &load.rushes {
        assert!(r.at_20k < 10_000.0, "{}: {:.0} B/s", r.name, r.at_20k);
    }
}

/// Who built what is written on every keyframe tick, whatever the city's size, so it is added to the extrapolated
/// figure rather than scaled with it. The evening rush has about 12 B/s of headroom: 80 built lots from five
/// builders, in a log six days old (the widest ticks), stay inside it.
#[test]
fn authors_for_eighty_built_lots_fit_in_the_rushs_headroom() {
    let (world, ticks) = day("harbor", 2);
    let load = measure_load(&world, &ticks);
    let mut busy = World::new(City::generate("harbor", 2).unwrap());
    for lot in 0..80u32 {
        busy.authors.insert(
            lot,
            Author {
                tick: 100 + lot,
                principal: 1 + u64::from(lot % 5),
                name: format!("builder-no-{}", lot % 5),
            },
        );
    }
    let record = |events: Vec<Event>| {
        TickRecord {
            header: Header {
                epoch: 1,
                district: 0,
                tick: 8738 * KEYFRAME_EVERY,
                speed: 4,
                keyframe_offset: 0,
                wall_us: 0,
            },
            keyframe: None,
            events,
        }
        .encode()
        .unwrap()
        .len()
    };
    let empty = record(Vec::new());
    let mut per_keyframe = 0;
    let mut all = busy.author_events().into_iter().map(|(_, e)| e).peekable();
    // Each event is measured in a record of its own, as each district writes its own.
    while all.peek().is_some() {
        per_keyframe += record(vec![all.next().unwrap()]) - empty;
    }
    // A keyframe tick comes once a minute at 4 ticks a second.
    let extra = per_keyframe as f64 / 60.0;
    assert!(extra > 0.0);
    for r in &load.rushes {
        assert!(
            r.at_20k + extra < 10_000.0,
            "{}: {:.0} B/s and {extra:.0} B/s of authors",
            r.name,
            r.at_20k
        );
    }
}

/// A district of about 1,250 residents, the share of a 20,000-resident city in 16 districts, steps
/// at the morning rush in well under the 250 ms a tick has at 4 ticks a second (the bound is 50 ms, 40 times the debug time). Prints the time:
/// `cargo test -p felix-metro-sim --release step_time_at_rush -- --nocapture`.
#[test]
fn step_time_at_rush() {
    let city = City::generate("harbor", 2).unwrap();
    let places = Places::with_per_home(&city, 64);
    let mut world = World::with_places(city, &places);
    let per_district = world.residents() / world.districts();
    assert!(per_district > 1000, "{per_district} residents a district");
    let rush = 31 * TICKS_PER_HOUR / 4;
    let mut worst = std::time::Duration::ZERO;
    let mut total = std::time::Duration::ZERO;
    let mut at = 0;
    for tick in 0..rush + 2 * TICKS_PER_HOUR {
        let start = std::time::Instant::now();
        world.step();
        let took = start.elapsed();
        if tick >= rush {
            total += took;
            if took > worst {
                (worst, at) = (took, tick);
            }
        }
    }
    println!(
        "{} residents a district: worst step {worst:?} at tick {at}, mean over 07:45-09:45 {:?}",
        per_district,
        total / (2 * TICKS_PER_HOUR)
    );
    // The whole city steps inside one tick's budget; this bound is loose so a loaded debug build passes.
    assert!(worst.as_millis() < 50, "worst step {worst:?}");
}

/// Each district's share of the account that a keyframe tick wrote.
fn balances(step: &[DistrictTick]) -> Vec<i64> {
    step.iter()
        .map(|d| {
            d.events
                .iter()
                .find_map(|e| match e {
                    Event::Balance { amount } => Some(*amount),
                    _ => None,
                })
                .expect("a keyframe tick writes the balance")
        })
        .collect()
}

/// The council a keyframe tick wrote.
fn council(step: &[DistrictTick]) -> Council {
    step[0]
        .events
        .iter()
        .find_map(Council::from_event)
        .expect("a keyframe tick writes the council")
}

#[test]
fn a_world_restored_from_a_keyframe_steps_as_the_original_does() {
    // From an hour of the night, the rush hours and the middle of the day, in cities of 4 and 9 districts.
    for (seed, side, hours) in [
        ("harbor", 2, &[0, 3, 8, 12, 17, 22, 23, 24][..]),
        ("pinecrest", 3, &[8, 17, 24][..]),
    ] {
        let city = City::generate(seed, side).unwrap();
        let mut world = World::new(city.clone());
        let ticks: Vec<_> = (0..TICKS_PER_DAY + 600).map(|_| world.step()).collect();
        for &hour in hours {
            let at = hour * TICKS_PER_HOUR;
            let frames: Vec<_> = ticks[at as usize]
                .iter()
                .map(|d| d.keyframe.clone().unwrap())
                .collect();
            let mut departures = HashMap::new();
            for step in &ticks[..=at as usize] {
                for event in step.iter().flat_map(|d| &d.events) {
                    if let Event::Trip {
                        resident,
                        vehicle,
                        depart,
                        route,
                    } = event
                    {
                        departures.insert(
                            *resident,
                            Departure {
                                depart: *depart,
                                vehicle: *vehicle,
                                route: route.clone(),
                            },
                        );
                    }
                }
            }
            let balances = balances(&ticks[at as usize]);
            let council = council(&ticks[at as usize]);
            let mut restored =
                World::restore(city.clone(), at, &frames, &balances, council, &departures).unwrap();
            assert_eq!(restored.next_tick(), at + 1);
            for tick in at + 1..at + 400 {
                assert!(
                    restored.step() == ticks[tick as usize],
                    "{seed} restored at {at}, tick {tick}"
                );
            }
        }
    }
}

#[test]
fn a_keyframe_with_nobody_on_the_road_to_say_where_from_is_refused() {
    let city = City::generate("harbor", 2).unwrap();
    let mut world = World::new(city.clone());
    let ticks: Vec<_> = (0..=8 * TICKS_PER_HOUR).map(|_| world.step()).collect();
    let at = 8 * TICKS_PER_HOUR;
    let frames: Vec<_> = ticks[at as usize]
        .iter()
        .map(|d| d.keyframe.clone().unwrap())
        .collect();
    let balances = balances(&ticks[at as usize]);
    let council = council(&ticks[at as usize]);
    let Err(err) = World::restore(city, at, &frames, &balances, council, &HashMap::new()) else {
        panic!("restored with no trip events");
    };
    assert!(format!("{err:#}").contains("no trip event"), "{err:#}");
}

/// The page's city stats are checked in `web/src/stats.test.ts` against this file: the log of a morning as the browser
/// reads it, and what the sim says was on the road at every tick. Run with `METRO_WRITE_FIXTURE=1` to rewrite it.
#[test]
fn the_stats_fixture_for_the_page_is_current() {
    use std::fmt::Write;

    // From 07:00, when nobody is out, to 09:00, past the morning rush.
    const FROM: u32 = 7 * TICKS_PER_HOUR;
    const TO: u32 = 9 * TICKS_PER_HOUR;
    let mut world = World::new(City::generate("harbor", 2).unwrap());
    let mut records = Vec::new();
    let (mut on_road, mut walkers, mut population) = (Vec::new(), Vec::new(), 0);
    for tick in 0..=TO {
        let step = world.step();
        if tick < FROM {
            continue;
        }
        let frames = world.keyframes(tick);
        let road = frames.iter().map(|f| f.counts.on_road).sum::<u32>();
        if tick == FROM {
            assert_eq!(road, 0, "residents are on the road at the start");
        }
        let walking = frames
            .iter()
            .flat_map(|f| &f.residents)
            .filter(|r| matches!(&r.doing, Doing::Trip(v) if v.kind == 0))
            .count();
        population = frames.iter().map(|f| f.residents.len()).sum::<usize>();
        on_road.push(road);
        walkers.push(walking);
        for (district, d) in step.into_iter().enumerate() {
            if d.events.is_empty() && d.keyframe.is_none() {
                continue;
            }
            // A keyframe's residents are most of the file. Those at home or at work are only counted; those on the
            // road are kept, without their routes, since the page reads who they are.
            let held = d.keyframe.as_ref().map_or(0, |k| k.residents.len());
            let keyframe = d.keyframe.map(|k| Keyframe {
                residents: k
                    .residents
                    .into_iter()
                    .filter_map(|r| match r.doing {
                        Doing::Trip(v) => Some(ResidentState {
                            id: r.id,
                            doing: Doing::Trip(Vehicle {
                                route: Vec::new(),
                                ..v
                            }),
                        }),
                        Doing::Activity { .. } => None,
                    })
                    .collect(),
                ..k
            });
            let record = TickRecord {
                header: Header {
                    epoch: 1,
                    district: district as u16,
                    tick,
                    speed: 4,
                    keyframe_offset: 0,
                    wall_us: 0,
                },
                keyframe,
                events: d.events,
            };
            records.push(format!(
                "{{\"held\":{held},\"record\":{}}}",
                record.to_json()
            ));
        }
    }
    let list = |v: &[usize]| {
        v.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut json = String::new();
    write!(
        json,
        "{{\"seed\":\"harbor\",\"districts\":2,\"from\":{FROM},\"to\":{TO},\"population\":{population},\
         \"onRoad\":[{}],\"walkers\":[{}],\"records\":[\n{}\n]}}\n",
        list(&on_road.iter().map(|&n| n as usize).collect::<Vec<_>>()),
        list(&walkers),
        records.join(",\n"),
    )
    .unwrap();

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/src/stats-fixture.json");
    if std::env::var_os("METRO_WRITE_FIXTURE").is_some() {
        std::fs::write(path, &json).unwrap();
    }
    assert!(
        std::fs::read_to_string(path).is_ok_and(|now| now == json),
        "web/src/stats-fixture.json is out of date; rewrite it with METRO_WRITE_FIXTURE=1 cargo test -p felix-metro-sim the_stats_fixture"
    );
}
