use felix_metro_core::record::{Command, Event, LEDGER_DAY, REFUSED_NO_FUNDS, RESULT_APPLIED};
use felix_metro_core::{City, TICKS_PER_DAY};

use super::*;
use crate::commands::tests::{city, free_lot};

/// The balance a district's keyframe tick wrote.
fn balance(step: &[crate::world::DistrictTick]) -> i64 {
    step.iter()
        .flat_map(|d| &d.events)
        .filter_map(|e| match e {
            Event::Balance { amount } => Some(*amount),
            _ => None,
        })
        .sum()
}

#[test]
fn the_opening_funds_are_split_without_losing_a_unit() {
    for districts in [1, 4, 9, 16] {
        let total: i64 = (0..districts).map(|d| opening_share(districts, d)).sum();
        assert_eq!(total, START_FUNDS, "{districts} districts");
    }
}

#[test]
fn a_day_ends_with_one_ledger_event_a_district_and_the_keyframe_agrees() {
    let mut world = World::new(City::generate("harbor", 2).unwrap());
    let before = world.funds();
    let mut days = Vec::new();
    for tick in 0..=TICKS_PER_DAY {
        let step = world.step();
        if tick == TICKS_PER_DAY - 1 {
            assert!(
                step.iter().all(|d| !d.events.iter().any(is_day)),
                "day not over"
            );
        }
        if tick == TICKS_PER_DAY {
            days = step;
        }
    }
    let ledgers: Vec<_> = days
        .iter()
        .map(|d| d.events.iter().filter(|e| is_day(e)).count())
        .collect();
    assert_eq!(ledgers, vec![1; 4]);
    let net: i64 = days
        .iter()
        .flat_map(|d| &d.events)
        .map(|e| match e {
            Event::Ledger {
                reason: LEDGER_DAY,
                earned,
                spent,
            } => *earned as i64 - *spent as i64,
            _ => 0,
        })
        .sum();
    assert!(
        net > 0,
        "a city nobody has changed should pay its way: {net}"
    );
    assert_eq!(balance(&days), before + net);
    assert_eq!(world.funds(), before + net);
}

fn is_day(e: &Event) -> bool {
    matches!(
        e,
        Event::Ledger {
            reason: LEDGER_DAY,
            ..
        }
    )
}

#[test]
fn building_costs_money_and_a_poor_city_cannot_build() {
    let mut world = World::new(city());
    let lot = free_lot(&world);
    world.set_funds(1000);
    let kind = 3;
    let built = world.apply(&Command::Build {
        lot,
        kind,
        rotation: 0,
    });
    assert_eq!(built.result, RESULT_APPLIED);
    assert_eq!(world.funds(), 1000 - build_cost(kind) as i64);

    let lot = (0..world.city.lots.len() as u32)
        .find(|&l| l != lot && world.building(l).is_some_and(|(k, _)| k >= 38))
        .unwrap();
    world.set_funds(build_cost(kind) as i64 - 1);
    let refused = world.apply(&Command::Build {
        lot,
        kind,
        rotation: 0,
    });
    assert_eq!(refused.result, REFUSED_NO_FUNDS);
    assert!(refused.events.is_empty());
    assert_eq!(world.funds(), build_cost(kind) as i64 - 1);
    assert!(world.building(lot).unwrap().0 >= 38, "nothing was built");
}

#[test]
fn demolishing_costs_money_too() {
    let mut world = World::new(city());
    let lot = free_lot(&world);
    world.set_funds(100_000);
    world.apply(&Command::Build {
        lot,
        kind: 3,
        rotation: 0,
    });
    world.set_funds(DEMOLISH_COST as i64 - 1);
    let refused = world.apply(&Command::Demolish { lot });
    assert_eq!(refused.result, REFUSED_NO_FUNDS);
    world.set_funds(DEMOLISH_COST as i64);
    let done = world.apply(&Command::Demolish { lot });
    assert_eq!(done.result, RESULT_APPLIED);
    assert_eq!(world.funds(), 0);
}
