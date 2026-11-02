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
    match rng.below(15) {
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
        10 => Event::Speed {
            ticks_per_second: rng.below(33) as u8,
        },
        11 => Event::CommandCursor {
            next: rng.next_u64() >> rng.below(64),
        },
        12 => Event::Ledger {
            reason: rng.below(3) as u8,
            earned: rng.next_u64() >> rng.below(64),
            spent: rng.next_u64() >> rng.below(64),
        },
        13 => Event::Balance {
            amount: (rng.next_u64() as i64) >> rng.below(64),
        },
        _ => Event::Forked {
            tick: rng.next_u64() as u32,
            name: name(rng),
            principal: rng.next_u64(),
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
        events: (0..rng.below(10))
            .flat_map(|_| {
                let e = event(rng);
                // An arrival is an `arrived` and the same resident's `activity`, which share an entry on the wire.
                match e {
                    Event::Arrived { resident, .. } if rng.below(2) == 0 => vec![
                        e,
                        Event::Activity {
                            resident,
                            kind: rng.below(8) as u8,
                            until: rng.next_u64() as u32,
                        },
                    ],
                    e => vec![e],
                }
            })
            .collect(),
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
            principal: rng.next_u64(),
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
    bytes[PLAIN_HEADER] = 1 << 4 | UNKNOWN_EVENT_TAG;
    assert_eq!(TickRecord::decode(&bytes).unwrap().events, []);
    let mut bytes = r.encode().unwrap();
    bytes[FLAGS_AT] |= 0x80;
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
    w.varint(1);
    w.varint(0);
    w.varint(0);
    w.u8(1);
    w.u8(FLAG_KEYFRAME);
    w.varint(0);
    w.u64(0);
    w.varint(0);
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
        principal: 3,
    };
    assert_eq!(registry.encode(), Err(EncodeError::StringTooLong));
    let event = Event::Command {
        principal: 1,
        name: long.clone(),
        id: 1,
        result: 0,
    };
    assert_eq!(
        plain_tick(vec![event]).encode(),
        Err(EncodeError::StringTooLong)
    );
    // A reader refuses a long string a foreign writer produced.
    let mut w = wire::Writer(Vec::new());
    w.framed(10, 4, |b| {
        b.u64(1);
        b.u8(MAX_STR as u8 + 1);
        b.0.extend_from_slice(&[b'x'; MAX_STR + 1]);
        b.u32(1);
        b.u8(0);
        Ok(())
    })
    .unwrap();
    let bytes = raw_tick(false, 1, &w.0);
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

/// The bytes of a `plain_tick` before its first event, and where its flags and event count are in them.
const PLAIN_HEADER: usize = 16;
const FLAGS_AT: usize = 5;
const COUNT_AT: usize = 15;

/// A tag no build has used.
const UNKNOWN_EVENT_TAG: u8 = 14;

/// A tick record's header for `events` events, with a keyframe if asked, then `body`.
fn raw_tick(keyframe: bool, events: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = plain_tick(Vec::new()).encode().unwrap();
    assert_eq!(bytes.len(), PLAIN_HEADER);
    bytes[FLAGS_AT] = u8::from(keyframe);
    bytes[COUNT_AT] = events;
    bytes.extend_from_slice(body);
    bytes
}

/// The frame head of an event with a `len`-byte body.
const fn head(tag: u8, len: u8) -> u8 {
    len << 4 | tag
}

#[test]
fn unknown_event_tags_are_skipped_and_the_rest_is_kept() {
    let speed = [head(EV_SPEED_TAG, 1), 4];
    let mut body = vec![head(UNKNOWN_EVENT_TAG, 3), 1, 2, 3];
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
fn an_unknown_extended_kind_is_skipped_and_the_rest_is_kept() {
    let mut body = vec![head(15, 3), 99, 1, 2];
    body.extend_from_slice(&[head(EV_SPEED_TAG, 1), 4]);
    let r = TickRecord::decode(&raw_tick(false, 2, &body)).unwrap();
    assert_eq!(
        r.events,
        [Event::Speed {
            ticks_per_second: 4
        }]
    );
}

#[test]
fn an_event_body_may_grow_but_not_shrink() {
    let longer = [head(EV_SPEED_TAG, 3), 4, 0xaa, 0xbb];
    let r = TickRecord::decode(&raw_tick(false, 1, &longer)).unwrap();
    assert_eq!(
        r.events,
        [Event::Speed {
            ticks_per_second: 4
        }]
    );
    let empty = [head(EV_SPEED_TAG, 0)];
    assert_eq!(
        TickRecord::decode(&raw_tick(false, 1, &empty)),
        Err(DecodeError::Truncated)
    );
    // An arrived event needs a resident and a lot.
    let short = [head(3, 1), 5];
    assert_eq!(
        TickRecord::decode(&raw_tick(false, 1, &short)),
        Err(DecodeError::Truncated)
    );
}

#[test]
fn an_event_that_claims_more_bytes_than_remain_is_truncated() {
    assert_eq!(
        TickRecord::decode(&raw_tick(false, 1, &[head(EV_SPEED_TAG, 9), 4])),
        Err(DecodeError::Truncated)
    );
}

#[test]
fn unknown_resident_states_are_skipped_in_a_keyframe() {
    // No buildings, no roads, two residents, then counts. Resident 5 (id delta
    // 5, zigzag 10) has state tag 3 and a two-byte body; resident 6 (delta 1,
    // zigzag 2) is in an activity (kind 3, lot 9, until the record's own tick, 5).
    let fixed = [
        0,
        0,
        2, //
        10,
        2 << 2 | 3,
        0,
        0, //
        2,
        3 << 2,
        3,
        9,
        0, //
        7,
        1,
        2,
        3,
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
    let left = |vehicle| Event::Entered {
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
        // A dead end has one way out, which is the way back.
        if next.len() > 1 && legs.last().is_some_and(|l| l.segment == segment) {
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
fn a_typical_trip_is_about_forty_bytes_or_less() {
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
    let trip = record.encode().unwrap().len() - PLAIN_HEADER;
    assert!(trip <= 40, "a 12-segment trip took {trip} bytes");
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
    assert!(r.encode().unwrap().len() < PLAIN_HEADER + 8);
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

#[test]
fn a_fork_is_an_event_and_a_registry_record_with_who_made_it() {
    let forked = Event::Forked {
        tick: 480,
        name: "harbor~bridge".into(),
        principal: 255,
    };
    let bytes = plain_tick(vec![forked.clone()]).encode().unwrap();
    assert_eq!(TickRecord::decode(&bytes).unwrap().events, [forked]);
    assert_eq!(
        plain_tick(vec![Event::Forked {
            tick: 480,
            name: "harbor~bridge".into(),
            principal: 255,
        }])
        .to_json()
        .split("\"events\":")
        .nth(1),
        Some(
            r#"[{"type":"forked","tick":480,"name":"harbor~bridge","principal":"00000000000000ff"}]}"#
        )
    );
    let listed = RegistryRecord::Forked {
        name: "harbor~bridge".into(),
        parent: "harbor".into(),
        tick: 480,
        wall_us: 9,
        principal: 255,
    };
    assert_eq!(
        decode_json(&listed.encode().unwrap()).unwrap(),
        r#"{"kind":"registry","type":"forked","name":"harbor~bridge","parent":"harbor","tick":480,"wallUs":9,"principal":"00000000000000ff"}"#
    );
}

#[test]
fn a_stamp_splits_into_the_principal_and_the_record() {
    assert_eq!(
        split_stamp(b"\x00\x03ana\x01\x02"),
        Some(("ana", &b"\x01\x02"[..]))
    );
    assert_eq!(split_stamp(b"\x00\x00"), Some(("", &b""[..])));
}

#[test]
fn a_bad_stamp_is_none() {
    assert_eq!(split_stamp(b""), None);
    assert_eq!(split_stamp(b"\x00"), None);
    assert_eq!(split_stamp(b"\x00\x05ana"), None);
    assert_eq!(split_stamp(b"\x00\x02\xff\xfe"), None);
}

#[test]
fn the_principal_hash_is_fnv_1a_and_pinned() {
    assert_eq!(principal_hash(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(principal_hash("a"), 0xaf63_dc4c_8601_ec8c);
    assert_ne!(principal_hash("mayor"), principal_hash("viewer"));
}

fn arrival(resident: u32, lot: u32) -> [Event; 2] {
    [
        Event::Arrived { resident, lot },
        Event::Activity {
            resident,
            kind: 1,
            until: 5 + 96,
        },
    ]
}

#[test]
fn an_arrival_is_one_entry_and_reads_back_as_two_events() {
    let one = plain_tick(arrival(1234, 900).to_vec());
    let bytes = one.encode().unwrap();
    assert_eq!(TickRecord::decode(&bytes).unwrap(), one);
    // The count in the header is the entries written, not the events they read back as.
    assert_eq!(bytes[COUNT_AT], 1);
    // Frame head, resident (2), lot (2), kind, until as a delta from the tick (2).
    assert_eq!(bytes.len(), PLAIN_HEADER + 1 + 2 + 2 + 1 + 2);
}

#[test]
fn an_activity_that_is_not_the_arrivals_stays_its_own_event() {
    let [arrived, activity] = arrival(1, 2);
    let other = Event::Activity {
        resident: 9,
        kind: 1,
        until: 6,
    };
    for events in [
        vec![arrived.clone(), other.clone()],
        vec![activity.clone(), arrived.clone()],
        vec![
            arrived.clone(),
            Event::Speed {
                ticks_per_second: 4,
            },
            activity.clone(),
        ],
    ] {
        let bytes = plain_tick(events.clone()).encode().unwrap();
        assert_eq!(bytes[COUNT_AT] as usize, events.len());
        assert_eq!(TickRecord::decode(&bytes).unwrap().events, events);
    }
}

#[test]
fn separate_arrived_and_activity_entries_still_read() {
    let [arrived, activity] = arrival(7, 8);
    let mut w = wire::Writer(Vec::new());
    w.framed(3, 4, |b| {
        b.varint(7);
        b.varint(8);
        Ok(())
    })
    .unwrap();
    w.framed(4, 4, |b| {
        b.varint(7);
        b.u8(1);
        b.delta(5, 101);
        Ok(())
    })
    .unwrap();
    let r = TickRecord::decode(&raw_tick(false, 2, &w.0)).unwrap();
    assert_eq!(r.events, [arrived, activity]);
}

#[test]
fn times_are_coded_from_the_tick_of_the_record() {
    let near = plain_tick(vec![Event::Trip {
        resident: 300,
        vehicle: 1,
        depart: 5,
        route: Vec::new(),
    }]);
    let far = TickRecord {
        events: vec![Event::Trip {
            resident: 300,
            vehicle: 1,
            depart: 5_000_000,
            route: Vec::new(),
        }],
        ..near.clone()
    };
    let (n, f) = (near.encode().unwrap(), far.encode().unwrap());
    // Frame head (the longer body needs two bytes), resident (2), vehicle, depart (1 or 4), route count.
    assert_eq!(n.len(), PLAIN_HEADER + 1 + 2 + 1 + 1 + 1);
    assert_eq!(f.len(), PLAIN_HEADER + 2 + 2 + 1 + 4 + 1);
    assert_eq!(TickRecord::decode(&f).unwrap(), far);
    // A time before the tick is a negative delta.
    let early = TickRecord {
        events: vec![Event::Activity {
            resident: 1,
            kind: 0,
            until: 0,
        }],
        ..near
    };
    assert_eq!(TickRecord::decode(&early.encode().unwrap()).unwrap(), early);
}

#[test]
fn a_departure_carries_no_vehicle() {
    let left = plain_tick(vec![Event::Left {
        resident: 5,
        district: 3,
    }]);
    let bytes = left.encode().unwrap();
    // Frame head, resident, district.
    assert_eq!(bytes.len(), PLAIN_HEADER + 3);
    assert_eq!(TickRecord::decode(&bytes).unwrap(), left);
    assert_eq!(
        left.to_json(),
        r#"{"kind":"tick","epoch":1,"district":0,"tick":5,"speed":4,"keyframeOffset":0,"wallUs":0,"keyframe":null,"events":[{"type":"left","resident":5,"district":3}]}"#
    );
}

#[test]
fn the_earlier_tick_layout_is_refused_by_its_kind() {
    let mut bytes = plain_tick(Vec::new()).encode().unwrap();
    bytes[0] = 1;
    assert_eq!(Record::decode(&bytes), Err(DecodeError::UnknownKind(1)));
}

#[test]
fn a_tick_with_nothing_in_it_is_sixteen_bytes() {
    assert_eq!(plain_tick(Vec::new()).encode().unwrap().len(), PLAIN_HEADER);
}

#[test]
fn a_district_past_u16_is_an_error() {
    let mut w = wire::Writer(Vec::new());
    w.u8(KIND_TICK);
    w.varint(1);
    w.varint(70_000);
    assert!(matches!(
        Record::decode(&w.0),
        Err(DecodeError::Invalid(_)) | Err(DecodeError::Truncated)
    ));
    w.varint(0);
    w.u8(4);
    w.u8(0);
    w.varint(0);
    w.u64(0);
    w.varint(0);
    assert_eq!(Record::decode(&w.0), Err(DecodeError::Invalid("district")));
}
