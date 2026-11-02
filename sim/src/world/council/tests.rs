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

/// A run of the chapter city to the first tick after its last day is scored, with the speed limits raised to
/// the roads' own on the first tick or left as the chapter opened them.
fn chapter_run(raise: bool) -> World {
    use felix_metro_core::record::{POLICY_AVENUE_LIMIT, POLICY_STREET_LIMIT};

    chapter_run_raising(if raise {
        &[POLICY_AVENUE_LIMIT, POLICY_STREET_LIMIT]
    } else {
        &[]
    })
}

/// The same run with only the limits of `kinds` raised.
fn chapter_run_raising(kinds: &[usize]) -> World {
    use felix_metro_core::chapter_for;
    use felix_metro_core::record::{Command, RESULT_APPLIED};

    let chapter = chapter_for("pier").unwrap();
    let mut world = World::new(City::generate(chapter.seed, chapter.districts_per_side).unwrap());
    for &kind in kinds {
        let command = Command::Policy {
            kind: kind as u8,
            value: 100,
        };
        assert_eq!(world.apply(&command).result, RESULT_APPLIED);
    }
    run_to(&mut world, TICKS_PER_DAY * chapter.days + 1);
    assert_eq!(world.council.days, chapter.days);
    world
}

#[test]
fn the_chapter_city_opens_with_a_commute_too_long_and_recalls_a_mayor_who_does_nothing() {
    let chapter = felix_metro_core::chapter_for("pier").unwrap();
    let world = chapter_run(false);
    let commuters = &world.council.standings[FACTION_COMMUTERS];
    assert!(commuters.measure > chapter.commute_ticks);
    assert_eq!(commuters.unhappy_days, PATIENCE);
}

#[test]
fn raising_both_limits_meets_the_chapters_goals() {
    let chapter = felix_metro_core::chapter_for("pier").unwrap();
    let world = chapter_run(true);
    let commuters = &world.council.standings[FACTION_COMMUTERS];
    assert!(commuters.measure <= chapter.commute_ticks);
    assert!(world.council.standings.iter().all(|s| s.unhappy_days == 0));
    assert!(world.funds() > 0);
}

#[test]
fn raising_only_one_limit_is_not_enough() {
    use felix_metro_core::record::{POLICY_AVENUE_LIMIT, POLICY_STREET_LIMIT};

    let chapter = felix_metro_core::chapter_for("pier").unwrap();
    let measure = |kind| chapter_run_raising(&[kind]).council.standings[FACTION_COMMUTERS].measure;
    // The docs say 17.5 and 20 minutes; these are those numbers in ticks.
    assert_eq!(measure(POLICY_AVENUE_LIMIT), 70);
    assert_eq!(measure(POLICY_STREET_LIMIT), 80);
    assert!(measure(POLICY_AVENUE_LIMIT) > chapter.commute_ticks);
}

/// `web/src/chapter-fixture.json` is what the page's goal tests read: the chapter table and the council and funds
/// after each run above. Rewrite it with `METRO_WRITE_FIXTURE=1 cargo test -p felix-metro-sim the_chapter_fixture`.
#[test]
fn the_chapter_fixture_is_what_the_sim_writes() {
    let run = |raise| {
        let world = chapter_run(raise);
        let standings: Vec<String> = world
            .council
            .standings
            .iter()
            .map(|s| {
                format!(
                    "{{\"demand\":{},\"measure\":{},\"satisfaction\":{},\"unhappyDays\":{}}}",
                    s.demand, s.measure, s.satisfaction, s.unhappy_days
                )
            })
            .collect();
        format!(
            "{{\"council\":{{\"type\":\"council\",\"days\":{},\"patience\":{PATIENCE},\"standings\":[{}]}},\"funds\":{}}}",
            world.council.days,
            standings.join(","),
            world.funds()
        )
    };
    let chapters: Vec<String> = felix_metro_core::CHAPTERS
        .iter()
        .map(felix_metro_core::Chapter::to_json)
        .collect();
    let json = format!(
        "{{\"chapters\":[{}],\"ignored\":{},\"raised\":{}}}\n",
        chapters.join(","),
        run(false),
        run(true)
    );
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../web/src/chapter-fixture.json"
    );
    if std::env::var_os("METRO_WRITE_FIXTURE").is_some() {
        std::fs::write(path, &json).unwrap();
    }
    assert!(
        std::fs::read_to_string(path).is_ok_and(|now| now == json),
        "web/src/chapter-fixture.json is out of date; rewrite it with METRO_WRITE_FIXTURE=1"
    );
}
