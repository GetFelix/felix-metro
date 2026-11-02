use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::OnceLock;

use felix_metro_core::record::{
    Command, Doing, Event, LEDGER_BUILD, LEDGER_DEMOLISH, REFUSED_IN_USE, REFUSED_NO_FUNDS,
    REFUSED_NOT_BUILT, REFUSED_NOT_STRAIGHT, REFUSED_OCCUPIED, REFUSED_ROAD_BLOCKED,
    REFUSED_ROAD_EXISTS, REFUSED_TOO_LONG, REFUSED_UNKNOWN, RESULT_APPLIED, ROAD_ADDED,
    ROAD_REMOVED,
};
use felix_metro_core::{City, Mode};

use super::*;
use crate::world::{Council, Departure};
use crate::world::{DistrictTick, State};
use felix_metro_core::TICKS_PER_HOUR;

fn harbor() -> City {
    City::generate("harbor", 2).unwrap()
}

fn place(a: u32, b: u32) -> Command {
    Command::PlaceRoad { a, b }
}

/// Whether every tile a road between the nodes would cover is bare ground the world lets a builder use.
fn free(world: &World, a: u32, b: u32) -> bool {
    world.city.road_tiles(a, b).is_ok_and(|tiles| {
        tiles.iter().all(|&(x, z)| {
            let lot = world.city.lot_at(x, z).unwrap().id;
            !world.in_use.contains(&lot) && world.building(lot).is_some_and(|(k, _)| is_empty(k))
        })
    })
}

/// Tiles of road between two nodes along the graph.
fn detour(city: &City, a: u32, b: u32) -> u32 {
    let mut best: HashMap<u32, u32> = HashMap::new();
    let mut heap = BinaryHeap::new();
    heap.push(Reverse((0, a)));
    while let Some(Reverse((d, n))) = heap.pop() {
        if n == b {
            return d;
        }
        if best.get(&n).is_some_and(|&x| x <= d) {
            continue;
        }
        best.insert(n, d);
        for &(m, s) in &city.adjacency[n as usize] {
            heap.push(Reverse((
                d + u32::from(city.segments[s as usize].length),
                m,
            )));
        }
    }
    u32::MAX
}

/// Every pair of nodes a road may be built between, most useful first: the pairs a long way round by road.
fn candidates(world: &World) -> Vec<(u32, u32)> {
    let n = world.city.nodes.len() as u32;
    let mut all: Vec<(u32, u32, u32)> = (0..n)
        .flat_map(|a| (a + 1..n).map(move |b| (a, b)))
        .filter(|&(a, b)| free(world, a, b))
        .map(|(a, b)| (a, b, detour(&world.city, a, b)))
        .collect();
    all.sort_by_key(|&(a, b, d)| (Reverse(d), a, b));
    all.into_iter().map(|(a, b, _)| (a, b)).collect()
}

/// Steps `world` to the end of `until`, keeping what each tick recorded.
fn run(world: &mut World, until: u32) -> Vec<Vec<DistrictTick>> {
    let mut out = Vec::new();
    while world.next_tick() < until {
        out.push(world.step());
    }
    out
}

fn events(ticks: &[Vec<DistrictTick>]) -> impl Iterator<Item = (u32, usize, &Event)> {
    ticks.iter().enumerate().flat_map(|(tick, districts)| {
        districts
            .iter()
            .enumerate()
            .flat_map(move |(d, t)| t.events.iter().map(move |e| (tick as u32, d, e)))
    })
}

/// A road that residents drive on in the morning rush, and the tick one first sets off along it.
/// Found by trying the pairs with the longest detours.
pub(crate) fn busy_road() -> (u32, u32, u32) {
    static FOUND: OnceLock<(u32, u32, u32)> = OnceLock::new();
    *FOUND.get_or_init(|| {
        let probe = World::new(harbor());
        for (a, b) in candidates(&probe).into_iter().take(12) {
            let mut world = World::new(harbor());
            assert_eq!(world.apply(&place(a, b)).result, RESULT_APPLIED);
            let id = world.city.segments.len() as u32 - 1;
            let ticks = run(&mut world, 2200);
            let first = events(&ticks).find_map(|(tick, _, e)| match e {
                Event::Trip { route, .. } if route.iter().any(|l| l.segment == id) => Some(tick),
                _ => None,
            });
            if let Some(tick) = first {
                return (a, b, tick);
            }
        }
        panic!("no new road was used before 09:00");
    })
}

#[test]
fn a_road_is_added_paid_for_and_listed_in_the_keyframe() {
    let (a, b, _) = busy_road();
    let mut world = World::new(harbor());
    let funds = world.funds();
    let upkeep: u64 = world.upkeep.iter().sum();
    let tiles = world.city.road_tiles(a, b).unwrap().len() as u64;
    let applied = world.apply(&place(a, b));
    let id = world.city.segments.len() as u32 - 1;
    assert_eq!(applied.result, RESULT_APPLIED);
    assert_eq!(
        applied.events,
        vec![
            Event::Roadwork {
                segment: id,
                change: ROAD_ADDED,
                a,
                b
            },
            Event::Ledger {
                reason: LEDGER_BUILD,
                earned: 0,
                spent: 100 * tiles
            },
        ]
    );
    assert_eq!(world.funds(), funds - 100 * tiles as i64);
    // Each tile of the segment, the node it ends on included, is $1 a day.
    assert_eq!(world.upkeep.iter().sum::<u64>(), upkeep + tiles + 1);
    assert_eq!(world.cars.len(), world.city.segments.len());
    let step = world.step();
    let frame = step[usize::from(applied.district)]
        .keyframe
        .as_ref()
        .unwrap();
    assert_eq!(frame.roads.len(), 1);
    let road = frame.roads[0];
    assert_eq!(
        (road.segment, road.change, road.a, road.b),
        (id, ROAD_ADDED, a, b)
    );
}

#[test]
fn a_road_that_breaks_a_rule_is_refused_with_its_own_code_and_changes_nothing() {
    let mut world = World::new(harbor());
    let city = &world.city;
    let n = city.nodes.len() as u32;
    let same_line = |a: u32, b: u32| {
        city.nodes[a as usize].0 == city.nodes[b as usize].0
            || city.nodes[a as usize].1 == city.nodes[b as usize].1
    };
    let pair = |want: Option<felix_metro_core::RoadError>| {
        (0..n)
            .flat_map(|a| (0..n).map(move |b| (a, b)))
            .find(|&(a, b)| a != b && same_line(a, b) && city.road_tiles(a, b).err() == want)
            .unwrap()
    };
    let joined = (0, city.adjacency[0][0].0);
    let too_long = pair(Some(felix_metro_core::RoadError::TooLong));
    let blocked = pair(Some(felix_metro_core::RoadError::Blocked));
    let diagonal = (0..n)
        .flat_map(|a| (0..n).map(move |b| (a, b)))
        .find(|&(a, b)| !same_line(a, b))
        .unwrap();
    let cases = [
        (place(0, 0), REFUSED_NOT_STRAIGHT),
        (place(diagonal.0, diagonal.1), REFUSED_NOT_STRAIGHT),
        (place(too_long.0, too_long.1), REFUSED_TOO_LONG),
        (place(joined.0, joined.1), REFUSED_ROAD_EXISTS),
        (place(blocked.0, blocked.1), REFUSED_ROAD_BLOCKED),
        (place(n, 0), REFUSED_UNKNOWN),
        (place(0, n + 4), REFUSED_UNKNOWN),
    ];
    let hash = world.city.hash();
    let funds = world.funds();
    for (command, code) in cases {
        let applied = world.apply(&command);
        assert_eq!(applied.result, code, "{command:?}");
        assert!(applied.events.is_empty());
    }
    assert_eq!((world.city.hash(), world.funds()), (hash, funds));
    assert!(world.removed.is_empty());
}

#[test]
fn a_road_over_land_residents_use_or_a_building_is_refused() {
    let mut world = World::new(harbor());
    let n = world.city.nodes.len() as u32;
    let geometric: Vec<(u32, u32)> = (0..n)
        .flat_map(|a| (a + 1..n).map(move |b| (a, b)))
        .filter(|&(a, b)| world.city.road_tiles(a, b).is_ok())
        .collect();
    let on_used = geometric.iter().copied().find(|&(a, b)| {
        world
            .city
            .road_tiles(a, b)
            .unwrap()
            .iter()
            .any(|&(x, z)| world.in_use.contains(&world.city.lot_at(x, z).unwrap().id))
    });
    let (a, b) = on_used.expect("some road would cross a lot residents use");
    assert_eq!(world.apply(&place(a, b)).result, REFUSED_IN_USE);

    // A building a builder raised is in the way too.
    let (a, b, _) = busy_road();
    let (x, z) = world.city.road_tiles(a, b).unwrap()[0];
    let lot = world.city.lot_at(x, z).unwrap().id;
    let built = world.apply(&Command::Build {
        lot,
        kind: 4,
        rotation: 0,
    });
    assert_eq!(built.result, RESULT_APPLIED);
    assert_eq!(world.apply(&place(a, b)).result, REFUSED_OCCUPIED);
}

#[test]
fn a_road_the_city_cannot_pay_for_is_refused() {
    let (a, b, _) = busy_road();
    let mut world = World::new(harbor());
    let tiles = world.city.road_tiles(a, b).unwrap().len() as i64;
    world.set_funds(100 * tiles - 1);
    assert_eq!(world.apply(&place(a, b)).result, REFUSED_NO_FUNDS);
    world.set_funds(100 * tiles);
    assert_eq!(world.apply(&place(a, b)).result, RESULT_APPLIED);
    assert_eq!(world.funds(), 0);
}

#[test]
fn removing_a_road_frees_the_ground_and_costs_something() {
    let (a, b, _) = busy_road();
    let mut world = World::new(harbor());
    let before = (
        world.city.roads.clone(),
        world.upkeep.clone(),
        world.funds(),
    );
    world.apply(&place(a, b));
    let id = world.city.segments.len() as u32 - 1;
    let funds = world.funds();
    let removed = world.apply(&Command::RemoveRoad { segment: id });
    assert_eq!(removed.result, RESULT_APPLIED);
    assert_eq!(
        removed.events,
        vec![
            Event::Roadwork {
                segment: id,
                change: ROAD_REMOVED,
                a,
                b
            },
            Event::Ledger {
                reason: LEDGER_DEMOLISH,
                earned: 0,
                spent: 100
            },
        ]
    );
    assert_eq!(world.funds(), funds - 100);
    assert_eq!(world.city.roads, before.0);
    assert_eq!(world.upkeep, before.1);
    assert_eq!(world.removed, vec![id]);
    // The ground is free again, and the id is not.
    let (x, z) = world.city.road_tiles(a, b).unwrap()[0];
    assert!(!world.city.is_road(x, z));
    let again = world.apply(&place(a, b));
    assert_eq!(again.result, RESULT_APPLIED);
    assert_eq!(world.city.segments.len() as u32, id + 2);
    // A removed segment stays in the keyframe, so a page that starts there knows the id is spent.
    let frames = world.step();
    let listed: Vec<_> = frames
        .iter()
        .flat_map(|d| d.keyframe.as_ref().unwrap().roads.iter())
        .map(|r| (r.segment, r.change))
        .collect();
    assert_eq!(listed, vec![(id, ROAD_REMOVED), (id + 1, ROAD_ADDED)]);
}

#[test]
fn only_a_road_a_builder_added_can_be_removed() {
    let mut world = World::new(harbor());
    let generated = Command::RemoveRoad { segment: 0 };
    assert_eq!(world.apply(&generated).result, REFUSED_NOT_BUILT);
    let unknown = Command::RemoveRoad {
        segment: world.city.segments.len() as u32,
    };
    assert_eq!(world.apply(&unknown).result, REFUSED_UNKNOWN);
    let (a, b, _) = busy_road();
    world.apply(&place(a, b));
    let id = world.city.segments.len() as u32 - 1;
    assert_eq!(
        world.apply(&Command::RemoveRoad { segment: id }).result,
        RESULT_APPLIED
    );
    assert_eq!(
        world.apply(&Command::RemoveRoad { segment: id }).result,
        REFUSED_NOT_BUILT
    );
    // A removal the city cannot pay for is refused too.
    world.apply(&place(a, b));
    let id = world.city.segments.len() as u32 - 1;
    world.set_funds(99);
    assert_eq!(
        world.apply(&Command::RemoveRoad { segment: id }).result,
        REFUSED_NO_FUNDS
    );
    assert_eq!(world.funds(), 99);
}

#[test]
fn a_lot_under_a_road_cannot_be_built_on_until_the_road_goes() {
    let (a, b, _) = busy_road();
    let mut world = World::new(harbor());
    let (x, z) = world.city.road_tiles(a, b).unwrap()[0];
    world.apply(&place(a, b));
    let id = world.city.segments.len() as u32 - 1;
    let lot = world.city.lot_at(x, z).unwrap().id;
    let build = Command::Build {
        lot,
        kind: 4,
        rotation: 0,
    };
    assert_eq!(world.apply(&build).result, REFUSED_ROAD_BLOCKED);
    world.apply(&Command::RemoveRoad { segment: id });
    assert_eq!(world.apply(&build).result, RESULT_APPLIED);
}

/// Residents driving on segment `id` now, and residents with it still ahead, at the tick about to be stepped.
fn riders(world: &World, id: u32) -> (Vec<u32>, Vec<u32>) {
    let tick = world.next_tick();
    let (mut on, mut ahead) = (Vec::new(), Vec::new());
    for person in &world.people {
        let State::Travelling { trip, .. } = &person.state else {
            continue;
        };
        if trip.arrive() <= tick {
            continue;
        }
        let (leg, _) = trip.leg_progress(tick);
        let legs = trip.legs();
        if legs[leg].segment == id {
            on.push(person.resident.id);
        } else if legs[leg + 1..].iter().any(|l| l.segment == id) {
            ahead.push(person.resident.id);
        }
    }
    (on, ahead)
}

/// A world with the busy road built, stepped to a tick when some vehicle is on it and another has it ahead.
pub(crate) fn world_with_riders() -> (World, u32, Vec<u32>, Vec<u32>) {
    let (a, b, _) = busy_road();
    let mut world = World::new(harbor());
    world.apply(&place(a, b));
    let id = world.city.segments.len() as u32 - 1;
    loop {
        let (on, ahead) = riders(&world, id);
        // Late in an hour, so a keyframe soon after the removal still has the replanned vehicles on the road.
        let late = world.next_tick() % TICKS_PER_HOUR >= TICKS_PER_HOUR - 20;
        if late && !on.is_empty() && !ahead.is_empty() {
            return (world, id, on, ahead);
        }
        assert!(
            world.next_tick() < 4200,
            "the road never had both kinds of rider"
        );
        world.step();
    }
}

#[test]
fn a_vehicle_on_or_bound_for_a_removed_road_is_replanned_in_the_same_tick() {
    let (mut world, id, on, ahead) = world_with_riders();
    let tick = world.next_tick();
    assert_eq!(
        world.apply(&Command::RemoveRoad { segment: id }).result,
        RESULT_APPLIED
    );
    let step = world.step();
    let replans: Vec<(u32, u32, Vec<u32>)> = step
        .iter()
        .flat_map(|d| &d.events)
        .filter_map(|e| match e {
            Event::Replan {
                resident,
                node,
                route,
                ..
            } => Some((*resident, *node, route.iter().map(|l| l.segment).collect())),
            _ => None,
        })
        .collect();
    let mut told: Vec<u32> = replans.iter().map(|r| r.0).collect();
    told.sort();
    let mut wanted: Vec<u32> = on.iter().chain(&ahead).copied().collect();
    wanted.sort();
    assert_eq!(
        told, wanted,
        "exactly the vehicles that needed it, at tick {tick}"
    );
    for (resident, node, route) in &replans {
        assert!(
            !route.contains(&id),
            "resident {resident} was sent along the road that went"
        );
        assert!((*node as usize) < world.city.nodes.len());
    }
    // From now on nobody is on the segment, in a position or in a route, for as long as anyone could have been.
    for _ in 0..400 {
        let now = world.next_tick();
        for person in &world.people {
            if let State::Travelling { trip, .. } = &person.state
                && trip.arrive() > now
            {
                assert_ne!(trip.position_at(&world.city, now).segment, id);
                let (leg, _) = trip.leg_progress(now);
                assert!(trip.legs()[leg..].iter().all(|l| l.segment != id));
            }
        }
        for d in world.step() {
            if let Some(k) = d.keyframe {
                for r in k.residents {
                    if let Doing::Trip(v) = r.doing {
                        assert!(v.route.iter().all(|l| l.segment != id));
                    }
                }
            }
        }
    }
}

#[test]
fn a_replan_keeps_the_kind_of_trip_and_none_happens_without_a_removal() {
    let (mut world, id, _, _) = world_with_riders();
    let step = world.step();
    assert!(
        !step
            .iter()
            .flat_map(|d| &d.events)
            .any(|e| matches!(e, Event::Replan { .. }))
    );
    assert!(world.removed.is_empty());
    world.apply(&Command::RemoveRoad { segment: id });
    let before: Vec<(u32, Mode)> = world
        .people
        .iter()
        .filter_map(|p| match &p.state {
            State::Travelling { trip, .. } => Some((p.resident.id, trip.mode)),
            _ => None,
        })
        .collect();
    let step = world.step();
    for e in step.iter().flat_map(|d| &d.events) {
        if let Event::Replan {
            resident, vehicle, ..
        } = e
        {
            let mode = before.iter().find(|b| b.0 == *resident).unwrap().1;
            assert_eq!(*vehicle == 0, mode == Mode::Walk);
        }
    }
    // The next step has nothing left to replan.
    assert!(world.removed.is_empty());
}

/// What the world is rebuilt from at keyframe tick `at`: each district's keyframe, the balances, the council and the
/// latest `trip` or `replan` of everyone, as a restart reads them back from the log.
fn restore_at(ticks: &[Vec<DistrictTick>], at: u32) -> World {
    let frames: Vec<_> = ticks[at as usize]
        .iter()
        .map(|d| d.keyframe.clone().unwrap())
        .collect();
    let balances: Vec<i64> = ticks[at as usize]
        .iter()
        .map(|d| {
            d.events
                .iter()
                .find_map(|e| match e {
                    Event::Balance { amount } => Some(*amount),
                    _ => None,
                })
                .unwrap()
        })
        .collect();
    let mut departures = HashMap::new();
    for (tick, step) in ticks[..=at as usize].iter().enumerate() {
        for event in step.iter().flat_map(|d| &d.events) {
            match event {
                Event::Trip {
                    resident,
                    vehicle,
                    depart,
                    route,
                } => {
                    departures.insert(
                        *resident,
                        Departure {
                            depart: *depart,
                            vehicle: *vehicle,
                            route: route.clone(),
                            node: None,
                        },
                    );
                }
                Event::Replan {
                    resident,
                    vehicle,
                    node,
                    route,
                } => {
                    departures.insert(
                        *resident,
                        Departure {
                            depart: tick as u32,
                            vehicle: *vehicle,
                            route: route.clone(),
                            node: Some(*node),
                        },
                    );
                }
                _ => {}
            }
        }
    }
    let council = ticks[at as usize][0]
        .events
        .iter()
        .find_map(Council::from_event)
        .unwrap();
    World::restore(harbor(), at, &frames, &balances, council, &departures).unwrap()
}

#[test]
fn a_world_restored_on_either_side_of_a_removal_steps_as_the_original_does() {
    let (a, b, _) = busy_road();
    let (probe, id, _, _) = world_with_riders();
    let removal = probe.next_tick();
    let mut original = World::new(harbor());
    original.apply(&place(a, b));
    let mut ticks = run(&mut original, removal);
    // The runner records a command's changes beside the step's events; here they are kept apart.
    let removal_events = original.apply(&Command::RemoveRoad { segment: id });
    let end = removal + 500;
    ticks.extend(run(&mut original, end));
    assert!(events(&ticks).any(|(_, _, e)| matches!(e, Event::Replan { .. })));

    let keyframes: Vec<u32> = (0..end).filter(|t| t % TICKS_PER_HOUR == 0).collect();
    let before = *keyframes.iter().rfind(|&&t| t < removal).unwrap();
    let after = *keyframes.iter().find(|&&t| t > removal).unwrap();
    // Someone sent round the removal is still on the road at the later keyframe, so it is rebuilt from a `replan`.
    let replanned: Vec<u32> = events(&ticks)
        .filter_map(|(_, _, e)| match e {
            Event::Replan { resident, .. } => Some(*resident),
            _ => None,
        })
        .collect();
    let on_road_at_after: Vec<u32> = ticks[after as usize]
        .iter()
        .filter_map(|d| d.keyframe.as_ref())
        .flat_map(|k| &k.residents)
        .filter(|r| matches!(r.doing, Doing::Trip(_)))
        .map(|r| r.id)
        .collect();
    assert!(replanned.iter().any(|r| on_road_at_after.contains(r)));
    for at in [before, after] {
        let mut restored = restore_at(&ticks, at);
        assert_eq!(restored.next_tick(), at + 1);
        for tick in at + 1..end {
            for (district, d) in ticks[tick as usize].iter().enumerate() {
                for event in &d.events {
                    restored.apply_logged(district, event);
                }
            }
            if tick == removal {
                for event in &removal_events.events {
                    restored.apply_logged(usize::from(removal_events.district), event);
                }
            }
            assert!(
                restored.step() == ticks[tick as usize],
                "restored at {at}, tick {tick}"
            );
        }
        assert_eq!(restored.city.hash(), original.city.hash());
    }
}
