use std::collections::HashMap;

use felix_metro_core::record::{Command, RESULT_APPLIED};
use felix_metro_core::{Archetype, City, SegmentClass, TICKS_PER_DAY, TICKS_PER_HOUR};

use super::*;
use crate::world::tests::restored;
use crate::world::{DistrictTick, World};

fn harbor() -> World {
    World::new(City::generate("harbor", 2).unwrap())
}

fn set(world: &mut World, kind: usize, value: u8) -> u8 {
    let command = Command::Policy {
        kind: kind as u8,
        value,
    };
    world.apply(&command).result
}

#[test]
fn values_outside_a_policys_range_are_malformed() {
    let mut policy = Policy::new();
    for (kind, value) in [
        (POLICY_SHOP_HOURS, MAX_SHOP_HOURS + 1),
        (POLICY_AVENUE_LIMIT, MIN_LIMIT - 1),
        (POLICY_STREET_LIMIT, 101),
        (POLICIES, 1),
    ] {
        assert_eq!(policy.set(kind as u8, value, 0), Err(REFUSED_MALFORMED));
    }
    assert_eq!(policy, Policy::new(), "a refusal changes nothing");
}

#[test]
fn a_policy_waits_a_cooldown_before_it_changes_again() {
    let mut policy = Policy::new();
    assert_eq!(policy.set(POLICY_SHOP_HOURS as u8, 2, 100), Ok(()));
    let again = 100 + COOLDOWN;
    assert_eq!(
        policy.set(POLICY_SHOP_HOURS as u8, 1, again - 1),
        Err(REFUSED_COOLDOWN)
    );
    // Another policy has its own cooldown.
    assert_eq!(policy.set(POLICY_STREET_LIMIT as u8, 60, again - 1), Ok(()));
    assert_eq!(policy.set(POLICY_SHOP_HOURS as u8, 1, again), Ok(()));
    assert_eq!(policy.late_close(), TICKS_PER_HOUR);
}

#[test]
fn setting_the_value_a_policy_has_is_refused_and_starts_no_cooldown() {
    let mut policy = Policy::new();
    assert_eq!(
        policy.set(POLICY_AVENUE_LIMIT as u8, 100, 5),
        Err(REFUSED_UNCHANGED)
    );
    assert_eq!(policy.set(POLICY_AVENUE_LIMIT as u8, 70, 6), Ok(()));
}

#[test]
fn a_command_changes_the_world_and_says_so_in_district_zero() {
    let mut world = harbor();
    let applied = world.apply(&Command::Policy {
        kind: POLICY_SHOP_HOURS as u8,
        value: 2,
    });
    assert_eq!((applied.district, applied.result), (0, RESULT_APPLIED));
    assert_eq!(applied.events, vec![world.policy.event()]);
    assert_eq!(world.policy.shop_hours(), 2);
    assert_eq!(set(&mut world, POLICY_SHOP_HOURS, 3), REFUSED_COOLDOWN);
    assert_eq!(set(&mut world, 9, 3), REFUSED_MALFORMED);
    assert_eq!(world.policy.shop_hours(), 2);
}

/// Each resident's trips on the first day, by departure tick.
fn departures(ticks: &[Vec<DistrictTick>]) -> HashMap<u32, Vec<u32>> {
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    for event in ticks.iter().flatten().flat_map(|d| &d.events) {
        if let Event::Trip {
            resident, depart, ..
        } = event
        {
            out.entry(*resident).or_default().push(*depart);
        }
    }
    out
}

fn day_with(kind: usize, value: u8) -> (World, Vec<Vec<DistrictTick>>) {
    let mut world = harbor();
    set(&mut world, kind, value);
    let ticks = (0..TICKS_PER_DAY).map(|_| world.step()).collect();
    (world, ticks)
}

#[test]
fn shopkeepers_close_later_and_nobody_else_is_moved() {
    let (usual, ticks) = day_with(POLICY_SHOP_HOURS, 0);
    let base = departures(&ticks);
    let (late, ticks) = day_with(POLICY_SHOP_HOURS, 3);
    let later = departures(&ticks);
    let mut moved = 0;
    for person in &usual.people {
        let id = person.resident.id;
        let (Some(a), Some(b)) = (base.get(&id), later.get(&id)) else {
            continue;
        };
        if person.resident.archetype == Archetype::Shopkeeper {
            // The trip out of the shop is the second of their day.
            assert_eq!(b[1], a[1] + 3 * TICKS_PER_HOUR, "shopkeeper {id}");
            moved += 1;
        } else {
            assert_eq!(a[0], b[0], "resident {id} still leaves home on time");
        }
    }
    assert!(moved > 0, "the city has shopkeepers");
    assert_eq!(late.policy.late_close(), 3 * TICKS_PER_HOUR);
}

#[test]
fn a_speed_limit_slows_every_trip_on_that_class_of_road() {
    let limit = 50;
    let (world, ticks) = day_with(POLICY_AVENUE_LIMIT, limit);
    let (mut avenue_legs, mut street_legs_over) = (0, 0);
    for event in ticks.iter().flatten().flat_map(|d| &d.events) {
        let Event::Trip { vehicle, route, .. } = event else {
            continue;
        };
        if *vehicle == 0 {
            continue;
        }
        for leg in route {
            match world.city.segments[leg.segment as usize].class {
                SegmentClass::Avenue => {
                    assert!(leg.speed <= limit, "{leg:?}");
                    avenue_legs += 1;
                }
                SegmentClass::Street => street_legs_over += u32::from(leg.speed > limit),
            }
        }
    }
    assert!(avenue_legs > 0, "someone drove an avenue");
    assert!(street_legs_over > 0, "streets keep their own speed");
}

#[test]
fn a_world_restored_across_a_policy_change_steps_as_the_original_does() {
    // Shops stay open late from the first morning, then close at the usual time again at 17:30 on the
    // second day, a cooldown later. A restart at 17:00 finds shopkeepers still at work until 20:00.
    let city = City::generate("harbor", 2).unwrap();
    let lower = TICKS_PER_DAY + 17 * TICKS_PER_HOUR + TICKS_PER_HOUR / 2;
    let at = TICKS_PER_DAY + 17 * TICKS_PER_HOUR;
    let steps = |world: &mut World, from: u32, to: u32| -> Vec<Vec<DistrictTick>> {
        (from..to)
            .map(|tick| {
                if tick == 100 {
                    assert_eq!(set(world, POLICY_SHOP_HOURS, 3), RESULT_APPLIED);
                    assert_eq!(set(world, POLICY_STREET_LIMIT, 60), RESULT_APPLIED);
                }
                if tick == lower {
                    assert_eq!(set(world, POLICY_SHOP_HOURS, 0), RESULT_APPLIED);
                }
                world.step()
            })
            .collect()
    };
    let mut world = World::new(city.clone());
    let ticks = steps(&mut world, 0, at + 400);
    let mut restored = restored(&city, &ticks, at);
    assert_eq!(restored.policy, world_policy_at(&ticks, at));
    let rest = steps(&mut restored, at + 1, at + 400);
    for (n, step) in rest.iter().enumerate() {
        let tick = at as usize + 1 + n;
        assert!(*step == ticks[tick], "restored at {at}, tick {tick}");
    }
}

fn world_policy_at(ticks: &[Vec<DistrictTick>], at: u32) -> Policy {
    ticks[at as usize][0]
        .events
        .iter()
        .find_map(Policy::from_event)
        .unwrap()
}
