use super::*;
use crate::{City, rng::Rng};

fn route(rng: &mut Rng, len: usize) -> Vec<Leg> {
    (0..len)
        .map(|_| Leg {
            segment: rng.below(3000) as u32,
            speed: rng.below(256) as u8,
        })
        .collect()
}

fn vehicle(rng: &mut Rng) -> Vehicle {
    let len = rng.below(14);
    Vehicle {
        kind: rng.below(6) as u8,
        progress: rng.below(1000) as u16,
        route: route(rng, len),
    }
}

fn name(rng: &mut Rng) -> String {
    const WORDS: [&str; 5] = ["Ana", "Bo\"b", "Zoë", "雪", "back\\slash"];
    WORDS[rng.below(WORDS.len())].to_string()
}

fn event(rng: &mut Rng) -> Event {
    let resident = rng.next_u64() as u32;
    match rng.below(11) {
        0 => Event::Trip {
            resident,
            vehicle: rng.below(6) as u8,
            depart: rng.next_u64() as u32,
            route: {
                let len = rng.below(20);
                route(rng, len)
            },
        },
        1 => Event::Replan {
            resident,
            from_segment: rng.next_u64() as u32,
            route: {
                let len = rng.below(20);
                route(rng, len)
            },
        },
        2 => Event::Arrived {
            resident,
            lot: rng.next_u64() as u32,
        },
        3 => Event::Activity {
            resident,
            kind: rng.below(8) as u8,
            until: rng.next_u64() as u32,
        },
        4 => Event::Left {
            resident,
            district: rng.below(16) as u16,
            vehicle: vehicle(rng),
        },
        5 => Event::Entered {
            resident,
            district: rng.below(16) as u16,
            vehicle: vehicle(rng),
        },
        6 => Event::Built {
            lot: rng.next_u64() as u32,
            kind: rng.below(40) as u16,
            rotation: rng.below(4) as u8,
        },
        7 => Event::Demolished {
            lot: rng.next_u64() as u32,
            kind: NO_BUILDING,
            rotation: rng.below(4) as u8,
        },
        8 => Event::Road {
            segment: rng.next_u64() as u32,
            change: rng.below(4) as u8,
        },
        9 => Event::Command {
            principal: rng.next_u64(),
            name: name(rng),
            id: rng.next_u64() as u32,
            result: rng.below(3) as u8,
        },
        _ => Event::Speed {
            ticks_per_second: rng.below(33) as u8,
        },
    }
}

fn keyframe(rng: &mut Rng) -> Keyframe {
    Keyframe {
        buildings: (0..rng.below(8))
            .map(|_| BuildingDiff {
                lot: rng.below(2000) as u32,
                kind: rng.below(40) as u16,
                rotation: rng.below(4) as u8,
            })
            .collect(),
        roads: (0..rng.below(8))
            .map(|_| RoadDiff {
                segment: rng.next_u64() as u32,
                change: rng.below(4) as u8,
            })
            .collect(),
        residents: (0..rng.below(12))
            .map(|_| ResidentState {
                id: rng.next_u64() as u32,
                doing: if rng.below(2) == 0 {
                    Doing::Activity {
                        kind: rng.below(8) as u8,
                        until: rng.next_u64() as u32,
                    }
                } else {
                    Doing::Trip(vehicle(rng))
                },
            })
            .collect(),
        counts: Counts {
            home: rng.next_u64() as u32,
            at_work: rng.below(5000) as u32,
            on_road: 0,
            asleep: u32::MAX,
        },
    }
}

fn tick_record(rng: &mut Rng) -> TickRecord {
    TickRecord {
        header: Header {
            epoch: rng.next_u64() as u32,
            district: rng.below(16) as u16,
            tick: rng.next_u64() as u32,
            speed: rng.below(33) as u8,
            keyframe_offset: rng.next_u64(),
            wall_us: rng.next_u64(),
        },
        keyframe: (rng.below(3) == 0).then(|| keyframe(rng)),
        events: (0..rng.below(10)).map(|_| event(rng)).collect(),
    }
}

fn command_record(rng: &mut Rng) -> CommandRecord {
    let lot = rng.next_u64() as u32;
    CommandRecord {
        id: rng.next_u64() as u32,
        name: name(rng),
        command: match rng.below(6) {
            0 => Command::PlaceRoad {
                a: lot,
                b: rng.next_u64() as u32,
            },
            1 => Command::Zone {
                lot,
                zone: rng.below(5) as u8,
            },
            2 => Command::Build {
                lot,
                kind: rng.below(40) as u16,
                rotation: rng.below(4) as u8,
            },
            3 => Command::Demolish { lot },
            4 => Command::Speed {
                ticks_per_second: rng.below(33) as u8,
            },
            _ => Command::Fork {
                tick: lot,
                name: format!("{}-fork", name(rng)),
            },
        },
    }
}

fn registry_record(rng: &mut Rng) -> RegistryRecord {
    if rng.below(2) == 0 {
        RegistryRecord::Created {
            name: name(rng),
            seed: "harbor".into(),
            districts: rng.below(17) as u16,
            wall_us: rng.next_u64(),
        }
    } else {
        RegistryRecord::Forked {
            name: name(rng),
            parent: name(rng),
            tick: rng.next_u64() as u32,
            wall_us: rng.next_u64(),
        }
    }
}

/// Every strict prefix of `bytes` must be an error, and never a panic.
fn assert_prefixes_fail(bytes: &[u8]) {
    for n in 0..bytes.len() {
        assert!(Record::decode(&bytes[..n]).is_err(), "prefix of {n} bytes");
    }
}

#[test]
fn tick_records_roundtrip() {
    let mut rng = Rng::new("tick-roundtrip");
    for _ in 0..300 {
        let r = tick_record(&mut rng);
        let bytes = r.encode().unwrap();
        assert_eq!(TickRecord::decode(&bytes).unwrap(), r);
        assert_eq!(Record::decode(&bytes).unwrap(), Record::Tick(r));
    }
}

#[test]
fn command_and_registry_records_roundtrip() {
    let mut rng = Rng::new("command-roundtrip");
    for _ in 0..300 {
        let c = command_record(&mut rng);
        assert_eq!(CommandRecord::decode(&c.encode()).unwrap(), c);
        let e = registry_record(&mut rng);
        assert_eq!(RegistryRecord::decode(&e.encode()).unwrap(), e);
    }
}

#[test]
fn truncation_at_every_byte_is_an_error() {
    let mut rng = Rng::new("truncation");
    for _ in 0..60 {
        assert_prefixes_fail(&tick_record(&mut rng).encode().unwrap());
        assert_prefixes_fail(&command_record(&mut rng).encode());
        assert_prefixes_fail(&registry_record(&mut rng).encode());
    }
}

#[test]
fn trailing_bytes_and_unknown_kinds_are_errors() {
    let mut rng = Rng::new("trailing");
    let mut bytes = tick_record(&mut rng).encode().unwrap();
    bytes.push(0);
    assert_eq!(Record::decode(&bytes), Err(DecodeError::Trailing));
    assert_eq!(Record::decode(&[9, 0, 0]), Err(DecodeError::UnknownKind(9)));
    assert_eq!(Record::decode(&[]), Err(DecodeError::Truncated));
    // The right kind with the wrong decoder is also refused.
    let registry = registry_record(&mut rng).encode();
    assert_eq!(
        TickRecord::decode(&registry),
        Err(DecodeError::UnknownKind(KIND_REGISTRY))
    );
}

#[test]
fn unknown_tags_and_flags_are_errors() {
    let r = TickRecord {
        header: Header {
            epoch: 1,
            district: 0,
            tick: 5,
            speed: 4,
            keyframe_offset: 0,
            wall_us: 0,
        },
        keyframe: None,
        events: vec![Event::Speed {
            ticks_per_second: 4,
        }],
    };
    let mut bytes = r.encode().unwrap();
    bytes[TICK_HEADER_LEN] = 99;
    assert_eq!(TickRecord::decode(&bytes), Err(DecodeError::UnknownTag(99)));
    let mut bytes = r.encode().unwrap();
    bytes[12] |= 0x80;
    assert!(matches!(
        TickRecord::decode(&bytes),
        Err(DecodeError::Invalid(_))
    ));
}

#[test]
fn hostile_counts_do_not_allocate() {
    // A keyframe claiming 2^60 buildings in a few bytes.
    let mut w = wire::Writer(Vec::new());
    w.u8(KIND_TICK);
    w.u32(1);
    w.u16(0);
    w.u32(0);
    w.u8(1);
    w.u8(FLAG_KEYFRAME);
    w.u64(0);
    w.u64(0);
    w.u16(0);
    w.varint(1 << 60);
    assert_eq!(Record::decode(&w.0), Err(DecodeError::Truncated));
}

#[test]
fn varints_reject_overlong_and_overflowing_forms() {
    let mut r = wire::Reader::new(&[0x80; 11]);
    assert!(r.varint().is_err());
    let mut r = wire::Reader::new(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02]);
    assert!(r.varint().is_err());
    let mut r = wire::Reader::new(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    assert_eq!(r.varint(), Ok(u64::MAX));
}

#[test]
fn too_many_events_is_refused_not_wrapped() {
    let r = TickRecord {
        header: Header {
            epoch: 0,
            district: 0,
            tick: 0,
            speed: 0,
            keyframe_offset: 0,
            wall_us: 0,
        },
        keyframe: None,
        events: vec![
            Event::Speed {
                ticks_per_second: 1
            };
            65_536
        ],
    };
    assert_eq!(r.encode(), Err(TooManyEvents));
}

#[test]
fn long_names_are_cut_on_a_character_boundary() {
    let long = "é".repeat(200);
    let c = CommandRecord {
        id: 1,
        name: long,
        command: Command::Demolish { lot: 3 },
    };
    let back = CommandRecord::decode(&c.encode()).unwrap();
    assert_eq!(back.name, "é".repeat(127));
}

/// A route of 12 real, connected segments from a generated city.
fn walk(city: &City, len: usize) -> Vec<Leg> {
    let mut rng = Rng::new("walk");
    let mut node = 0usize;
    let mut legs: Vec<Leg> = Vec::new();
    while legs.len() < len {
        let next = &city.adjacency[node];
        let (to, segment) = next[rng.below(next.len())];
        if legs.last().is_some_and(|l| l.segment == segment) {
            continue;
        }
        legs.push(Leg {
            segment,
            speed: 100,
        });
        node = to as usize;
    }
    legs
}

#[test]
fn a_typical_trip_is_about_sixty_bytes_or_less() {
    let city = City::generate("harbor", 2).unwrap();
    let record = TickRecord {
        header: Header {
            epoch: 1,
            district: 0,
            tick: 100,
            speed: 4,
            keyframe_offset: 0,
            wall_us: 0,
        },
        keyframe: None,
        events: vec![Event::Trip {
            resident: 1234,
            vehicle: 1,
            depart: 100,
            route: walk(&city, 12),
        }],
    };
    let trip = record.encode().unwrap().len() - TICK_HEADER_LEN;
    assert!(trip <= 60, "a 12-segment trip took {trip} bytes");
}

#[test]
fn a_city_nobody_built_in_has_an_empty_building_diff() {
    let city = City::generate("harbor", 2).unwrap();
    let mut current: Vec<BuildingDiff> = city
        .lots
        .iter()
        .map(|l| BuildingDiff {
            lot: l.id,
            kind: u16::from(l.kind.0),
            rotation: l.facing,
        })
        .collect();
    assert!(building_diffs(&city, &current).is_empty());
    current[5].kind = 3;
    current[9].rotation = (current[9].rotation + 1) % 4;
    let diff = building_diffs(&city, &current);
    assert_eq!(diff.iter().map(|d| d.lot).collect::<Vec<_>>(), [5, 9]);
    let keyframe = Keyframe {
        buildings: Vec::new(),
        roads: Vec::new(),
        residents: Vec::new(),
        counts: Counts::default(),
    };
    let r = TickRecord {
        header: Header {
            epoch: 1,
            district: 0,
            tick: 0,
            speed: 4,
            keyframe_offset: 0,
            wall_us: 0,
        },
        keyframe: Some(keyframe),
        events: Vec::new(),
    };
    assert!(r.encode().unwrap().len() < TICK_HEADER_LEN + 8);
}

#[test]
fn json_names_every_field_and_escapes_text() {
    let c = CommandRecord {
        id: 7,
        name: "Bo\"b\n".into(),
        command: Command::Fork {
            tick: 9,
            name: "x".into(),
        },
    };
    assert_eq!(
        c.to_json(),
        r#"{"kind":"command","id":7,"name":"Bo\"b\u000a","command":{"type":"fork","tick":9,"name":"x"}}"#
    );
    let t = TickRecord {
        header: Header {
            epoch: 2,
            district: 3,
            tick: 4,
            speed: 5,
            keyframe_offset: 6,
            wall_us: 7,
        },
        keyframe: None,
        events: vec![Event::Command {
            principal: 255,
            name: "Ana".into(),
            id: 1,
            result: 0,
        }],
    };
    assert_eq!(
        t.to_json(),
        r#"{"kind":"tick","epoch":2,"district":3,"tick":4,"speed":5,"keyframeOffset":6,"wallUs":7,"keyframe":null,"events":[{"type":"command","principal":"00000000000000ff","name":"Ana","id":1,"result":0}]}"#
    );
    assert_eq!(decode_json(&c.encode()).unwrap(), c.to_json());
}
