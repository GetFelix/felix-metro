use felix_metro_core::City;
use felix_metro_core::record::{
    NO_BUILDING, REFUSED_BAD_KIND, REFUSED_BAD_SPEED, REFUSED_EMPTY, REFUSED_IN_USE,
    REFUSED_MALFORMED, REFUSED_OCCUPIED, REFUSED_UNKNOWN, REFUSED_UNSUPPORTED,
};
use felix_metro_core::{BuildingKind, KINDS};

use super::*;

pub(crate) fn city() -> City {
    City::generate("harbor", 2).unwrap()
}

/// A lot with a tree or a plaza prop on it, a builder's free ground.
pub(crate) fn free_lot(world: &World) -> u32 {
    (0..world.city.lots.len() as u32)
        .find(|&lot| {
            world
                .building(lot)
                .is_some_and(|(k, _)| k >= u16::from(BuildingKind::TREE_FIRST))
        })
        .expect("the city has a free lot")
}

/// A lot with a building no resident goes to.
fn spare_building(world: &World) -> u32 {
    (0..world.city.lots.len() as u32)
        .find(|lot| {
            world
                .building(*lot)
                .is_some_and(|(k, _)| k < u16::from(BuildingKind::TREE_FIRST))
                && !world.in_use.contains(lot)
        })
        .expect("the city has a building nobody uses")
}

fn used_building(world: &World) -> u32 {
    (0..world.city.lots.len() as u32)
        .find(|lot| {
            world.in_use.contains(lot)
                && world
                    .building(*lot)
                    .is_some_and(|(k, _)| k < u16::from(BuildingKind::TREE_FIRST))
        })
        .expect("residents use a building")
}

/// A lot with trees on it that residents go to, if the city has one.
fn used_park(world: &World) -> Option<u32> {
    (0..world.city.lots.len() as u32).find(|lot| {
        world.in_use.contains(lot)
            && world
                .building(*lot)
                .is_some_and(|(k, _)| k >= u16::from(BuildingKind::TREE_FIRST))
    })
}

pub(crate) fn command(principal: &str, id: u32, command: Command) -> Incoming {
    Incoming {
        principal: principal_hash(principal),
        command: Some(CommandRecord {
            id,
            name: principal.to_owned(),
            command,
        }),
    }
}

fn stamped(principal: &str, record: &[u8]) -> Vec<u8> {
    let mut out = (principal.len() as u16).to_be_bytes().to_vec();
    out.extend_from_slice(principal.as_bytes());
    out.extend_from_slice(record);
    out
}

fn results(events: &[Event]) -> Vec<u8> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Command { result, .. } => Some(*result),
            _ => None,
        })
        .collect()
}

#[test]
fn a_stamped_command_is_read_with_the_hash_of_its_sender() {
    let record = CommandRecord {
        id: 7,
        name: "Mayor".into(),
        command: Command::Demolish { lot: 3 },
    };
    let got = Incoming::from_payload(&stamped("mayor", &record.encode().unwrap())).unwrap();
    assert_eq!(got.principal, principal_hash("mayor"));
    assert_eq!(got.command, Some(record));
}

#[test]
fn a_payload_that_is_not_a_command_keeps_its_sender_and_loses_the_command() {
    let got = Incoming::from_payload(&stamped("mayor", b"\xff\xff")).unwrap();
    assert_eq!(got.principal, principal_hash("mayor"));
    assert_eq!(got.command, None);
}

#[test]
fn a_payload_with_no_stamp_has_nobody_to_blame_and_is_dropped() {
    assert_eq!(Incoming::from_payload(b""), None);
    assert_eq!(Incoming::from_payload(b"\x00\x09abc"), None);
}

#[test]
fn a_build_lands_in_the_lots_district_with_the_command_that_asked_for_it() {
    let mut world = World::new(city());
    let lot = free_lot(&world);
    let district = world.city.lots[lot as usize].district;
    let mut speed = 4;
    let out = apply_all(
        &mut world,
        vec![command(
            "mayor",
            9,
            Command::Build {
                lot,
                kind: 3,
                rotation: 2,
            },
        )],
        &mut speed,
    );
    for (d, events) in out.iter().enumerate() {
        if d as u16 != district {
            assert!(events.is_empty(), "district {d}");
        }
    }
    assert_eq!(
        out[usize::from(district)],
        vec![
            Event::Command {
                principal: principal_hash("mayor"),
                name: "mayor".into(),
                id: 9,
                result: RESULT_APPLIED,
            },
            Event::Built {
                lot,
                kind: 3,
                rotation: 2
            },
        ]
    );
    assert_eq!(world.building(lot), Some((3, 2)));
}

#[test]
fn a_demolish_records_what_stood_there() {
    let mut world = World::new(city());
    let lot = spare_building(&world);
    let (kind, rotation) = world.building(lot).unwrap();
    let mut speed = 4;
    let out = apply_all(
        &mut world,
        vec![command("mayor", 1, Command::Demolish { lot })],
        &mut speed,
    );
    let events: Vec<_> = out.into_iter().flatten().collect();
    assert_eq!(results(&events), vec![RESULT_APPLIED]);
    assert!(events.contains(&Event::Demolished {
        lot,
        kind,
        rotation
    }));
    assert_eq!(world.building(lot), Some((NO_BUILDING, 0)));
}

#[test]
fn each_refusal_says_why_and_leaves_the_city_as_it_was() {
    let free = free_lot(&World::new(city()));
    let spare = spare_building(&World::new(city()));
    let used = used_building(&World::new(city()));
    let park = used_park(&World::new(city())).expect("residents go to a park");
    let beyond = city().lots.len() as u32;
    let tree = u16::from(BuildingKind::TREE_FIRST);
    let cases = [
        (
            Command::Build {
                lot: beyond,
                kind: 0,
                rotation: 0,
            },
            REFUSED_UNKNOWN,
        ),
        (
            Command::Build {
                lot: spare,
                kind: 0,
                rotation: 0,
            },
            REFUSED_OCCUPIED,
        ),
        (
            Command::Build {
                lot: free,
                kind: tree,
                rotation: 0,
            },
            REFUSED_BAD_KIND,
        ),
        (
            Command::Build {
                lot: free,
                kind: KINDS.len() as u16 + 50,
                rotation: 0,
            },
            REFUSED_BAD_KIND,
        ),
        (
            Command::Build {
                lot: free,
                kind: 0,
                rotation: 4,
            },
            REFUSED_BAD_KIND,
        ),
        (Command::Demolish { lot: beyond }, REFUSED_UNKNOWN),
        (Command::Demolish { lot: free }, REFUSED_EMPTY),
        (Command::Demolish { lot: used }, REFUSED_IN_USE),
        (
            Command::Build {
                lot: park,
                kind: 0,
                rotation: 0,
            },
            REFUSED_IN_USE,
        ),
        (Command::PlaceRoad { a: 0, b: 1 }, REFUSED_UNSUPPORTED),
        (Command::Zone { lot: free, zone: 1 }, REFUSED_UNSUPPORTED),
        (
            Command::Speed {
                ticks_per_second: 5,
            },
            REFUSED_BAD_SPEED,
        ),
        (
            Command::Fork {
                tick: 0,
                name: "x".into(),
            },
            REFUSED_UNSUPPORTED,
        ),
    ];
    for (command_, expected) in cases {
        let mut refused = World::new(city());
        let mut speed = 4;
        let out = apply_all(
            &mut refused,
            vec![command("mayor", 1, command_.clone())],
            &mut speed,
        );
        let events: Vec<_> = out.into_iter().flatten().collect();
        assert_eq!(results(&events), vec![expected], "{command_:?}");
        // The refusal is the only thing recorded, and it moved neither the
        // speed nor the world: it steps exactly as one nobody asked anything of.
        assert_eq!(events.len(), 1, "{command_:?}");
        assert_eq!(speed, 4, "{command_:?}");
        let mut untouched = World::new(city());
        for _ in 0..=240 {
            assert!(refused.step() == untouched.step(), "{command_:?}");
        }
    }
}

#[test]
fn bytes_that_are_not_a_command_are_refused_in_district_zero() {
    let mut world = World::new(city());
    let mut speed = 4;
    let bad = Incoming {
        principal: principal_hash("mayor"),
        command: None,
    };
    let out = apply_all(&mut world, vec![bad], &mut speed);
    assert_eq!(results(&out[0]), vec![REFUSED_MALFORMED]);
}

#[test]
fn commands_apply_in_the_order_they_arrived() {
    let mut world = World::new(city());
    let lot = free_lot(&world);
    let mut speed = 4;
    let out = apply_all(
        &mut world,
        vec![
            command(
                "a",
                1,
                Command::Build {
                    lot,
                    kind: 1,
                    rotation: 0,
                },
            ),
            command(
                "b",
                2,
                Command::Build {
                    lot,
                    kind: 2,
                    rotation: 0,
                },
            ),
            command("b", 3, Command::Demolish { lot }),
            command(
                "a",
                4,
                Command::Build {
                    lot,
                    kind: 5,
                    rotation: 1,
                },
            ),
        ],
        &mut speed,
    );
    let events: Vec<_> = out.into_iter().flatten().collect();
    assert_eq!(
        results(&events),
        vec![
            RESULT_APPLIED,
            REFUSED_OCCUPIED,
            RESULT_APPLIED,
            RESULT_APPLIED
        ]
    );
    assert_eq!(world.building(lot), Some((5, 1)));
}

#[test]
fn a_speed_command_moves_the_wanted_speed() {
    let mut world = World::new(city());
    let mut speed = 4;
    apply_all(
        &mut world,
        vec![command(
            "mayor",
            1,
            Command::Speed {
                ticks_per_second: 16,
            },
        )],
        &mut speed,
    );
    assert_eq!(speed, 16);
}
