use std::collections::{BTreeSet, HashMap};

use felix_metro_core::record::{Command, Event, REFUSED_UNSUPPORTED, RESULT_APPLIED};
use felix_metro_core::{
    Activity, BuildingKind, City, INVESTIGATIONS, Investigation, TICKS_PER_DAY, TICKS_PER_HOUR,
    investigation_for,
};

use super::*;
use crate::commands::apply_all;
use crate::commands::tests::{command, free_lot};

fn case_world() -> World {
    let case = &INVESTIGATIONS[0];
    World::new(City::generate(case.seed, case.districts_per_side).unwrap())
}

/// A building, whatever it is for.
fn some_building(world: &World) -> u32 {
    (0..world.city.lots.len() as u32)
        .find(|lot| {
            world
                .building(*lot)
                .is_some_and(|(k, _)| k < u16::from(BuildingKind::TREE_FIRST))
        })
        .expect("the city has a building")
}

#[test]
fn a_case_file_refuses_every_command_that_would_change_the_city() {
    use felix_metro_core::record::{POLICY_AVENUE_LIMIT, POLICY_STREET_LIMIT};

    let mut world = case_world();
    let (lot, building) = (free_lot(&world), some_building(&world));
    let funds = world.funds();
    let commands = [
        Command::Build {
            lot,
            kind: 0,
            rotation: 0,
        },
        Command::Demolish { lot: building },
        Command::PlaceRoad { a: 0, b: 1 },
        Command::RemoveRoad { segment: 0 },
        Command::Policy {
            kind: POLICY_AVENUE_LIMIT as u8,
            value: 100,
        },
        Command::Policy {
            kind: POLICY_STREET_LIMIT as u8,
            value: 100,
        },
    ];
    for command in commands {
        let applied = world.apply(&command);
        assert_eq!(applied.result, REFUSED_UNSUPPORTED, "{command:?}");
        assert!(applied.events.is_empty(), "{command:?}");
    }
    assert_eq!(world.funds(), funds);
    assert!(world.built.is_empty());
    assert_eq!(world.policy.limits(), case_world().policy.limits());
}

#[test]
fn a_case_file_still_lets_its_watchers_change_the_speed() {
    let mut world = case_world();
    let mut wanted = 4;
    let speed = Command::Speed {
        ticks_per_second: 16,
    };
    let out = apply_all(&mut world, vec![command("mayor", 1, speed)], &mut wanted);
    assert_eq!(wanted, 16);
    let results: Vec<u8> = out
        .iter()
        .flatten()
        .filter_map(|e| match e {
            Event::Command { result, .. } => Some(*result),
            _ => None,
        })
        .collect();
    assert_eq!(results, vec![RESULT_APPLIED]);
}

#[test]
fn any_other_city_still_takes_a_build() {
    let mut world = World::new(City::generate("harbor", 2).unwrap());
    assert!(!world.is_case_file());
    let lot = free_lot(&world);
    let build = Command::Build {
        lot,
        kind: 0,
        rotation: 0,
    };
    assert_eq!(world.apply(&build).result, RESULT_APPLIED);
}

/// What the day's events say about the busiest hour, counted the way the case file's question is asked.
/// Counts most first, ties by key so the order is the same every run.
fn ranked<K: Ord>(counts: HashMap<K, usize>) -> Vec<(K, usize)> {
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counts
}

struct Facts {
    /// Hours of the day with their vehicle trips, most first.
    hours: Vec<(u32, usize)>,
    /// Streets with the trips that use them in the busiest hour, most first. A trip counts once per street.
    streets: Vec<(String, usize)>,
    /// What those trips' drivers set off to do, most first.
    purposes: Vec<(&'static str, usize)>,
    /// The street names that cross the busiest one.
    crossing: BTreeSet<String>,
}

fn facts(case: &Investigation) -> Facts {
    let mut world = World::new(City::generate(case.seed, case.districts_per_side).unwrap());
    let day = case.day * TICKS_PER_DAY..(case.day + 1) * TICKS_PER_DAY;
    // (resident, departure tick, segments used) for trips on wheels.
    let mut trips: Vec<(u32, u32, Vec<u32>)> = Vec::new();
    // What each resident does next, in the order the events come.
    let mut next: HashMap<u32, Vec<(u32, u8)>> = HashMap::new();
    while world.next_tick() < day.end {
        let tick = world.next_tick();
        for district in world.step() {
            for event in district.events {
                match event {
                    Event::Trip {
                        resident,
                        vehicle,
                        depart,
                        route,
                    } if vehicle != 0 && day.contains(&depart) => {
                        trips.push((resident, depart, route.iter().map(|l| l.segment).collect()));
                    }
                    Event::Activity { resident, kind, .. } => {
                        next.entry(resident).or_default().push((tick, kind));
                    }
                    _ => {}
                }
            }
        }
    }
    let hour_of = |depart: u32| (depart - day.start) / TICKS_PER_HOUR;
    let mut by_hour = HashMap::new();
    for (_, depart, _) in &trips {
        *by_hour.entry(hour_of(*depart)).or_default() += 1;
    }
    let hours = ranked(by_hour);
    let busiest = hours[0].0;
    let in_busiest = || trips.iter().filter(|t| hour_of(t.1) == busiest);
    let mut by_street: HashMap<u16, usize> = HashMap::new();
    let mut by_purpose: HashMap<u8, usize> = HashMap::new();
    for (resident, depart, segments) in in_busiest() {
        let streets: BTreeSet<u16> = segments
            .iter()
            .map(|s| world.city.segments[*s as usize].street)
            .collect();
        for street in streets {
            *by_street.entry(street).or_default() += 1;
        }
        let arrival = next
            .get(resident)
            .and_then(|a| a.iter().find(|(t, _)| t > depart));
        if let Some((_, kind)) = arrival {
            *by_purpose.entry(*kind).or_default() += 1;
        }
    }
    let streets: Vec<(String, usize)> = ranked(by_street)
        .into_iter()
        .map(|(s, n)| (world.city.streets[s as usize].clone(), n))
        .collect();
    let top = world
        .city
        .streets
        .iter()
        .position(|s| *s == streets[0].0)
        .unwrap() as u16;
    // Streets sharing an intersection with the busiest one.
    let nodes_of = |street: u16| -> BTreeSet<u32> {
        world
            .city
            .segments
            .iter()
            .filter(|s| s.street == street)
            .flat_map(|s| [s.a, s.b])
            .collect()
    };
    let top_nodes = nodes_of(top);
    let crossing = (0..world.city.streets.len() as u16)
        .filter(|s| *s != top && !nodes_of(*s).is_disjoint(&top_nodes))
        .map(|s| world.city.streets[s as usize].clone())
        .collect();
    let name = |kind: u8| {
        [
            Activity::Home,
            Activity::Work,
            Activity::School,
            Activity::Shop,
            Activity::Leisure,
        ][usize::from(kind)]
        .name()
    };
    let purposes = ranked(by_purpose)
        .into_iter()
        .map(|(k, n)| (name(k), n))
        .collect();
    Facts {
        hours,
        streets,
        purposes,
        crossing,
    }
}

/// The table is what the city does: the case file's answer, recomputed from the day's events.
#[test]
fn the_table_holds_what_the_days_events_say() {
    for case in &INVESTIGATIONS {
        let facts = facts(case);
        assert_eq!(facts.hours[0].0, case.hour, "hours {:?}", &facts.hours[..3]);
        assert_eq!(
            facts.streets[0].0,
            case.street,
            "streets {:?}",
            &facts.streets[..3]
        );
        assert_eq!(
            facts.purposes[0].0,
            case.purpose.name(),
            "purposes {:?}",
            facts.purposes
        );
        assert!(
            facts.crossing.contains(case.neighbour),
            "{} does not cross {}: {:?}",
            case.neighbour,
            case.street,
            facts.crossing
        );
    }
}

/// A second place that is close would make the answer a coin toss for a player who counts by eye.
#[test]
fn each_answer_wins_by_a_clear_margin() {
    for case in &INVESTIGATIONS {
        let facts = facts(case);
        let clear =
            |first: usize, second: usize, percent: usize| first * 100 >= second * (100 + percent);
        assert!(
            clear(facts.hours[0].1, facts.hours[1].1, 15),
            "{:?}",
            facts.hours
        );
        assert!(
            clear(facts.streets[0].1, facts.streets[1].1, 30),
            "{:?}",
            facts.streets
        );
        assert!(
            clear(facts.purposes[0].1, facts.purposes[1].1, 100),
            "{:?}",
            facts.purposes
        );
    }
}

#[test]
fn only_the_table_makes_a_city_a_case_file() {
    assert!(case_world().is_case_file());
    assert!(investigation_for("pier").is_none());
    assert!(!World::new(City::generate("pier", 2).unwrap()).is_case_file());
}

/// `web/src/investigation-fixture.json` is what the page's case tests read: the table. Rewrite it with
/// `METRO_WRITE_FIXTURE=1 cargo test -p felix-metro-sim the_investigation_fixture`.
#[test]
fn the_investigation_fixture_is_what_the_table_says() {
    let cases: Vec<String> = INVESTIGATIONS.iter().map(Investigation::to_json).collect();
    let json = format!("{{\"investigations\":[{}]}}\n", cases.join(","));
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../web/src/investigation-fixture.json"
    );
    if std::env::var_os("METRO_WRITE_FIXTURE").is_some() {
        std::fs::write(path, &json).unwrap();
    }
    assert!(
        std::fs::read_to_string(path).is_ok_and(|now| now == json),
        "web/src/investigation-fixture.json is out of date; rewrite it with METRO_WRITE_FIXTURE=1"
    );
}
