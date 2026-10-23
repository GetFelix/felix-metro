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
        progress: rng.below(1001) as u16,
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
                        lot: rng.next_u64() as u32,
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
        assert_eq!(CommandRecord::decode(&c.encode().unwrap()).unwrap(), c);
        let e = registry_record(&mut rng);
        assert_eq!(RegistryRecord::decode(&e.encode().unwrap()).unwrap(), e);
    }
}

#[test]
fn truncation_at_every_byte_is_an_error() {
    let mut rng = Rng::new("truncation");
    for _ in 0..60 {
        assert_prefixes_fail(&tick_record(&mut rng).encode().unwrap());
        assert_prefixes_fail(&command_record(&mut rng).encode().unwrap());
        assert_prefixes_fail(&registry_record(&mut rng).encode().unwrap());
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
    let registry = registry_record(&mut rng).encode().unwrap();
    assert_eq!(
        TickRecord::decode(&registry),
        Err(DecodeError::UnknownKind(KIND_REGISTRY))
    );
}

#[test]
fn unknown_header_flags_are_errors() {
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
    assert_eq!(TickRecord::decode(&bytes).unwrap().events, []);
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
    assert_eq!(r.encode(), Err(EncodeError::TooManyEvents));
}

#[test]
fn names_over_the_limit_are_refused() {
    let long = "é".repeat(33);
    assert_eq!(long.len(), 66);
    let ok = "é".repeat(32);
    let command = |name: &str, fork: &str| CommandRecord {
        id: 1,
        name: name.into(),
        command: Command::Fork {
            tick: 3,
            name: fork.into(),
        },
    };
    assert_eq!(
        command(&long, "x").encode(),
        Err(EncodeError::StringTooLong)
    );
    assert_eq!(
        command("x", &long).encode(),
        Err(EncodeError::StringTooLong)
    );
    let back = CommandRecord::decode(&command(&ok, &ok).encode().unwrap()).unwrap();
    assert_eq!(back.name, ok);
    let registry = RegistryRecord::Forked {
        name: "x".into(),
        parent: long.clone(),
        tick: 1,
        wall_us: 2,
    };
    assert_eq!(registry.encode(), Err(EncodeError::StringTooLong));
    let event = Event::Command {
        principal: 1,
        name: long.clone(),
        id: 1,
        result: 0,
    };
    let mut t = plain_tick(vec![event]);
    assert_eq!(t.encode(), Err(EncodeError::StringTooLong));
    // A reader refuses a long string a foreign writer produced.
    t.events = vec![Event::Command {
        principal: 1,
        name: "x".repeat(MAX_STR),
        id: 1,
        result: 0,
    }];
    let mut bytes = t.encode().unwrap();
    // tag, length, principal (8), name length byte
    let at = TICK_HEADER_LEN + 2 + 8;
    assert_eq!(bytes[at] as usize, MAX_STR);
    bytes[at] += 1;
    bytes.push(b'x');
    bytes[TICK_HEADER_LEN + 1] += 1;
    assert_eq!(
        TickRecord::decode(&bytes),
        Err(DecodeError::Invalid("string is too long"))
    );
}

fn plain_tick(events: Vec<Event>) -> TickRecord {
    TickRecord {
        header: Header {
            epoch: 1,
            district: 0,
            tick: 5,
            speed: 4,
            keyframe_offset: 0,
            wall_us: 0,
        },
        keyframe: None,
        events,
    }
}

/// A tick record's header for `events` events, with a keyframe if asked, then `body`.
fn raw_tick(keyframe: bool, events: u16, body: &[u8]) -> Vec<u8> {
    let mut bytes = plain_tick(Vec::new()).encode().unwrap();
    bytes.truncate(TICK_HEADER_LEN);
    bytes[12] = u8::from(keyframe);
    bytes[29..31].copy_from_slice(&events.to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}

#[test]
fn unknown_event_tags_are_skipped_and_the_rest_is_kept() {
    let speed = [EV_SPEED_TAG, 1, 4];
    let mut body = vec![99, 3, 1, 2, 3];
    body.extend_from_slice(&speed);
    let r = TickRecord::decode(&raw_tick(false, 2, &body)).unwrap();
    assert_eq!(
        r.events,
        [Event::Speed {
            ticks_per_second: 4
        }]
    );
}

const EV_SPEED_TAG: u8 = 11;

#[test]
fn an_event_body_may_grow_but_not_shrink() {
    let longer = [EV_SPEED_TAG, 3, 4, 0xaa, 0xbb];
    let r = TickRecord::decode(&raw_tick(false, 1, &longer)).unwrap();
    assert_eq!(
        r.events,
        [Event::Speed {
            ticks_per_second: 4
        }]
    );
    let empty = [EV_SPEED_TAG, 0];
    assert_eq!(
        TickRecord::decode(&raw_tick(false, 1, &empty)),
        Err(DecodeError::Truncated)
    );
    // An arrived event needs 8 bytes.
    let short = [3, 7, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(
        TickRecord::decode(&raw_tick(false, 1, &short)),
        Err(DecodeError::Truncated)
    );
}

#[test]
fn an_event_that_claims_more_bytes_than_remain_is_truncated() {
    assert_eq!(
        TickRecord::decode(&raw_tick(false, 1, &[EV_SPEED_TAG, 9, 4])),
        Err(DecodeError::Truncated)
    );
}

#[test]
fn unknown_resident_states_are_skipped_in_a_keyframe() {
    // No buildings, no roads, two residents, then counts. Resident 5 has
    // state tag 77; resident 6 is in an activity (kind 3, lot 9, until 5).
    let fixed = [
        0, 0, 2, //
        10, 77, 2, 0, 0, //
        2, 0, 6, 3, 9, 0, 0, 0, 5, //
        7, 1, 2, 3,
    ];
    let r = TickRecord::decode(&raw_tick(true, 0, &fixed)).unwrap();
    let k = r.keyframe.unwrap();
    assert_eq!(
        k.residents,
        [ResidentState {
            id: 6,
            doing: Doing::Activity {
                kind: 3,
                lot: 9,
                until: 5
            }
        }]
    );
    assert_eq!(k.counts.home, 7);
}

#[test]
fn progress_past_the_end_of_a_leg_is_refused() {
    let at_end = Vehicle {
        kind: 0,
        progress: MAX_PROGRESS,
        route: Vec::new(),
    };
    let left = |vehicle| Event::Left {
        resident: 1,
        district: 2,
        vehicle,
    };
    let bytes = plain_tick(vec![left(at_end.clone())]).encode().unwrap();
    assert!(TickRecord::decode(&bytes).is_ok());
    let over = Vehicle {
        progress: MAX_PROGRESS + 1,
        ..at_end
    };
    let bytes = plain_tick(vec![left(over)]).encode().unwrap();
    assert!(matches!(
        TickRecord::decode(&bytes),
        Err(DecodeError::Invalid(_))
    ));
}

#[test]
fn a_huge_delta_is_an_error_not_an_overflow() {
    // i64::MAX added to a previous id near u32::MAX overflows an i64.
    let mut w = wire::Writer(Vec::new());
    w.varint(u64::MAX - 1);
    assert!(wire::Reader::new(&w.0).delta(u32::MAX).is_err());
    w.0.clear();
    w.varint(u64::MAX);
    assert!(wire::Reader::new(&w.0).delta(u32::MAX).is_err());
    // Through a record: a first building at the top of u32, then the huge delta.
    let mut body = vec![2];
    let mut w = wire::Writer(Vec::new());
    w.delta(0, u32::MAX);
    body.extend_from_slice(&w.0);
    body.extend_from_slice(&[0, 0, 0]);
    w.0.clear();
    w.varint(u64::MAX - 1);
    body.extend_from_slice(&w.0);
    body.extend_from_slice(&[0, 0, 0]);
    assert!(matches!(
        TickRecord::decode(&raw_tick(true, 0, &body)),
        Err(DecodeError::Invalid(_))
    ));
}

#[test]
fn non_canonical_varints_are_refused() {
    assert!(wire::Reader::new(&[0x80, 0x00]).varint().is_err());
    assert!(wire::Reader::new(&[0xff, 0x80, 0x00]).varint().is_err());
    assert_eq!(wire::Reader::new(&[0x00]).varint(), Ok(0));
    assert_eq!(wire::Reader::new(&[0x80, 0x01]).varint(), Ok(128));
    // A retried tick is the same bytes: one value, one encoding.
    let mut rng = Rng::new("canonical");
    for _ in 0..200 {
        let v = rng.next_u64() >> rng.below(64);
        let mut w = wire::Writer(Vec::new());
        w.varint(v);
        assert_eq!(wire::Reader::new(&w.0).varint(), Ok(v));
    }
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
    assert_eq!(decode_json(&c.encode().unwrap()).unwrap(), c.to_json());
}
