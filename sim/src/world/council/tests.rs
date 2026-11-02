use felix_metro_core::record::{BuildingDiff, Event};
use felix_metro_core::{BuildingKind, TICKS_PER_DAY, TICKS_PER_HOUR};

use std::collections::HashSet;

use super::*;

fn harbor() -> World {
    World::new(City::generate("harbor", 2).unwrap())
}

fn run_to(world: &mut World, tick: u32) {
    while world.next_tick() < tick {
        world.step();
    }
}

#[test]
fn satisfaction_is_full_at_the_demand_and_falls_in_proportion() {
    // A commute of 48 ticks is what commuters ask for; 96 is twice as long.
    assert_eq!(satisfaction(48, 40, true), 100);
    assert_eq!(satisfaction(48, 48, true), 100);
    assert_eq!(satisfaction(48, 96, true), 50);
    assert_eq!(satisfaction(80, 100, false), 100);
    assert_eq!(satisfaction(80, 40, false), 50);
    assert_eq!(satisfaction(80, 0, false), 0);
}

#[test]
fn nothing_is_scored_before_the_first_day_ends() {
    let mut world = harbor();
    run_to(&mut world, TICKS_PER_DAY);
    assert_eq!(world.council.days, 0);
    assert!(world.council.tally.commutes > 0, "the day is being counted");
    run_to(&mut world, TICKS_PER_DAY + 1);
    let council = &world.council;
    assert_eq!(council.days, 1);
    assert_eq!(council.tally.commutes, 0, "the next day starts at zero");
    assert!(council.standings.iter().all(|s| s.measure > 0));
}

#[test]
fn a_faction_stays_unhappy_for_days_in_a_row_until_the_day_it_is_not() {
    let mut council = Council::new();
    let bad_day = |council: &mut Council| {
        // Nobody commuted in a reasonable time and no home is quiet.
        council.arrived(Activity::Work, 400);
        council.score(0, 4);
    };
    for day in 1..=PATIENCE {
        bad_day(&mut council);
        assert_eq!(council.standings[FACTION_COMMUTERS].unhappy_days, day);
        assert_eq!(council.standings[FACTION_RESIDENTS].unhappy_days, day);
    }
    // One good day clears a faction's count and only that faction's.
    council.arrived(Activity::Work, 20);
    council.score(0, 4);
    assert_eq!(council.standings[FACTION_COMMUTERS].unhappy_days, 0);
    assert_eq!(
        council.standings[FACTION_RESIDENTS].unhappy_days,
        PATIENCE + 1
    );
    assert_eq!(council.days, PATIENCE as u32 + 1);
}

#[test]
fn a_day_with_nothing_to_judge_does_not_upset_anyone() {
    let mut council = Council::new();
    council.score(100, 0);
    assert!(council.standings.iter().all(|s| s.satisfaction == 100));
    assert!(council.standings.iter().all(|s| s.unhappy_days == 0));
}

#[test]
fn trips_are_counted_by_what_the_resident_arrives_to_do() {
    let mut council = Council::new();
    council.arrived(Activity::Work, 30);
    council.arrived(Activity::School, 10);
    council.arrived(Activity::Shop, 5);
    council.arrived(Activity::Home, 50);
    council.arrived(Activity::Leisure, 50);
    assert_eq!(
        council.tally,
        Tally {
            commutes: 2,
            commute_ticks: 40,
            visits: 1
        }
    );
}

#[test]
fn a_factory_beside_homes_makes_them_noisy() {
    let mut world = harbor();
    let before = world.quiet_percent();
    // Put a factory on every lot, then take them away again.
    let mut changed = Vec::new();
    for lot in &world.city.lots {
        if in_scope(&world.city, lot.district) && lot.door().is_some() {
            changed.push(BuildingDiff {
                lot: lot.id,
                kind: u16::from(BuildingKind::FACTORY_FIRST),
                rotation: 0,
            });
        }
    }
    for diff in &changed {
        world.set_building(*diff);
    }
    assert_eq!(
        world.quiet_percent(),
        0,
        "factories everywhere, was {before}%"
    );
    for diff in &changed {
        let lot = &world.city.lots[diff.lot as usize];
        world.set_building(BuildingDiff {
            lot: diff.lot,
            kind: u16::from(lot.kind.0),
            rotation: lot.facing,
        });
    }
    assert_eq!(world.quiet_percent(), before);
}

#[test]
fn only_the_shore_districts_are_scored_for_their_residents() {
    let city = City::generate("harbor", 3).unwrap();
    assert!(city.shore.is_some(), "the harbor city has water");
    let scored = (0..city.districts.len() as u16)
        .filter(|&d| in_scope(&city, d))
        .count();
    assert_eq!(scored, 3, "one edge of a 3 by 3 city");
}

#[test]
fn only_district_zero_writes_the_council_and_only_on_keyframe_ticks() {
    let mut world = harbor();
    for tick in 0..2 * TICKS_PER_HOUR {
        let step = world.step();
        for (district, d) in step.iter().enumerate() {
            let has = d.events.iter().any(|e| matches!(e, Event::Council { .. }));
            assert_eq!(
                has,
                district == 0 && tick % TICKS_PER_HOUR == 0,
                "district {district}, tick {tick}"
            );
        }
    }
}

#[test]
fn only_shops_residents_go_to_count_as_shops() {
    let mut world = harbor();
    let visited: HashSet<u32> = world
        .people
        .iter()
        .flat_map(|p| &p.resident.schedule.blocks)
        .filter(|b| b.activity == Activity::Shop)
        .map(|b| b.lot)
        .collect();
    let standing = world.shops_standing();
    assert_eq!(standing as usize, visited.len());

    // A shop nobody has a shop block at gets no visits, so it must not count.
    let elsewhere = world
        .city
        .lots
        .iter()
        .find(|l| l.door().is_some() && !visited.contains(&l.id))
        .unwrap()
        .id;
    world.set_building(BuildingDiff {
        lot: elsewhere,
        kind: u16::from(BuildingKind::COMMERCIAL_FIRST),
        rotation: 0,
    });
    assert_eq!(world.shops_standing(), standing);

    // A shop that residents go to stops counting once it is cleared.
    let gone = *visited.iter().min().unwrap();
    world.set_building(BuildingDiff {
        lot: gone,
        kind: u16::from(BuildingKind::TREE_FIRST),
        rotation: 0,
    });
    assert_eq!(world.shops_standing(), standing - 1);
}
