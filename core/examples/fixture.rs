//! Prints, as JSON, a summary and hash of a few generated cities and a set of
//! encoded records with what they decode to, for the web tests to compare with
//! the WebAssembly build.

use std::fmt::Write;

use felix_metro_core::{
    City, Congestion, Mode, Places, Resident, day_hash,
    record::{
        BuildingDiff, Command, CommandRecord, Counts, Doing, Event, Header, Keyframe, Leg,
        RegistryRecord, ResidentState, RoadDiff, TickRecord, Vehicle, decode_json,
    },
};

fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn route(city: &City, from: usize, len: usize) -> Vec<Leg> {
    (from..from + len)
        .map(|i| Leg {
            segment: city.segments[i % city.segments.len()].id,
            speed: 80 + (i % 40) as u8,
        })
        .collect()
}

fn header(tick: u32, keyframe_offset: u64) -> Header {
    Header {
        epoch: 3,
        district: 2,
        tick,
        speed: 4,
        keyframe_offset,
        wall_us: 1_760_000_000_000_000 + u64::from(tick) * 250_000,
    }
}

fn records() -> Vec<(&'static str, Vec<u8>)> {
    let city = City::generate("harbor", 2).unwrap();
    let vehicle = Vehicle {
        kind: 1,
        progress: 420,
        route: route(&city, 30, 6),
    };
    let quiet = TickRecord {
        header: header(100, 4096),
        keyframe: None,
        events: Vec::new(),
    };
    let busy = TickRecord {
        header: header(101, 4096),
        keyframe: None,
        events: vec![
            Event::Trip {
                resident: 1234,
                vehicle: 1,
                depart: 101,
                route: route(&city, 10, 12),
            },
            Event::Replan {
                resident: 77,
                from_segment: 12,
                route: route(&city, 200, 5),
            },
            Event::Arrived {
                resident: 9,
                lot: 55,
            },
            Event::Activity {
                resident: 9,
                kind: 2,
                until: 160,
            },
            Event::Left {
                resident: 5,
                district: 3,
                vehicle: vehicle.clone(),
            },
            Event::Entered {
                resident: 6,
                district: 1,
                vehicle: vehicle.clone(),
            },
            Event::Built {
                lot: 17,
                kind: 4,
                rotation: 2,
            },
            Event::Demolished {
                lot: 18,
                kind: 65535,
                rotation: 0,
            },
            Event::Road {
                segment: 40,
                change: 0,
            },
            Event::Command {
                principal: 0xdead_beef_0123_4567,
                name: "Ana \"the\" Builder".into(),
                id: 12,
                result: 0,
            },
            Event::Speed {
                ticks_per_second: 8,
            },
        ],
    };
    let key = TickRecord {
        header: header(240, 8192),
        keyframe: Some(Keyframe {
            buildings: vec![
                BuildingDiff {
                    lot: 17,
                    kind: 4,
                    rotation: 2,
                },
                BuildingDiff {
                    lot: 18,
                    kind: 65535,
                    rotation: 0,
                },
            ],
            roads: vec![RoadDiff {
                segment: 40,
                change: 0,
            }],
            residents: vec![
                ResidentState {
                    id: 3,
                    doing: Doing::Activity {
                        kind: 0,
                        lot: 17,
                        until: 300,
                    },
                },
                ResidentState {
                    id: 5,
                    doing: Doing::Trip(vehicle),
                },
            ],
            counts: Counts {
                home: 120,
                at_work: 80,
                on_road: 14,
                asleep: 6,
            },
        }),
        events: vec![Event::Speed {
            ticks_per_second: 4,
        }],
    };
    let commands = [
        CommandRecord {
            id: 1,
            name: "Ana".into(),
            command: Command::PlaceRoad { a: 4, b: 9 },
        },
        CommandRecord {
            id: 2,
            name: "Ben".into(),
            command: Command::Build {
                lot: 17,
                kind: 4,
                rotation: 2,
            },
        },
        CommandRecord {
            id: 3,
            name: "Ana".into(),
            command: Command::Fork {
                tick: 960,
                name: "harbor~bridge-closed".into(),
            },
        },
    ];
    let registry = [
        RegistryRecord::Created {
            name: "harbor".into(),
            seed: "harbor".into(),
            districts: 2,
            wall_us: 1_760_000_000_000_000,
        },
        RegistryRecord::Forked {
            name: "harbor~bridge-closed".into(),
            parent: "harbor".into(),
            tick: 960,
            wall_us: 1_760_000_240_000_000,
        },
    ];
    let mut out = vec![
        ("tick", quiet.encode().unwrap()),
        ("tick", busy.encode().unwrap()),
        ("keyframe", key.encode().unwrap()),
    ];
    out.extend(commands.iter().map(|c| ("command", c.encode().unwrap())));
    out.extend(registry.iter().map(|r| ("registry", r.encode().unwrap())));
    out
}

/// A few residents' first days as a `trip` event describes them, with where each trip is every few ticks.
fn trips() -> Vec<String> {
    let mut out = Vec::new();
    for (seed, d, index) in [("harbor", 2, 0), ("harbor", 2, 41), ("meadow", 2, 7)] {
        let city = City::generate(seed, d).unwrap();
        let places = Places::new(&city);
        let resident = Resident::new(&city, &places, index).unwrap();
        for trip in resident.day_trips(&city, 0, &Congestion::FREE, 0).unwrap() {
            let vehicle = if trip.mode == Mode::Walk {
                0
            } else {
                resident.vehicle
            };
            let route: Vec<String> = trip
                .legs()
                .iter()
                .map(|l| format!("[{},{}]", l.segment, l.speed))
                .collect();
            let at: Vec<String> = (trip.depart..=trip.arrive())
                .step_by(5)
                .map(|tick| {
                    let p = trip.position_at(&city, tick);
                    format!("[{tick},{},{}]", p.x, p.z)
                })
                .collect();
            out.push(format!(
                "    {{\"seed\": \"{seed}\", \"districts\": {d}, \"resident\": {index}, \"vehicle\": {vehicle}, \"depart\": {}, \"route\": [{}], \"arrive\": {}, \"at\": [{}]}}",
                trip.depart,
                route.join(","),
                trip.arrive(),
                at.join(",")
            ));
        }
    }
    out
}

fn main() {
    let cases = [("harbor", 2), ("meadow", 2), ("harbor", 4)];
    let cities: Vec<String> = cases
        .iter()
        .map(|&(seed, d)| {
            let city = City::generate(seed, d).unwrap();
            format!(
                "    {{\"seed\": \"{seed}\", \"districts\": {d}, \"lots\": {}, \"segments\": {}, \"shore\": {}, \"hash\": \"{:016x}\"}}",
                city.lots.len(),
                city.segments.len(),
                city.shore.map_or("null".to_string(), |e| e.to_string()),
                city.hash()
            )
        })
        .collect();
    let recs: Vec<String> = records()
        .iter()
        .map(|(name, bytes)| {
            let json = decode_json(bytes).unwrap();
            format!(
                "    {{\"name\": \"{name}\", \"record\": \"{}\", \"json\": {json}, \"hash\": \"{:016x}\"}}",
                hex(bytes),
                fnv1a(&json)
            )
        })
        .collect();
    let days: Vec<String> = [("harbor", 2, 0), ("harbor", 2, 41), ("meadow", 2, 7), ("harbor", 4, 100)]
        .iter()
        .map(|&(seed, d, index)| {
            format!(
                "    {{\"seed\": \"{seed}\", \"districts\": {d}, \"index\": {index}, \"hash\": \"{:016x}\"}}",
                day_hash(seed, d, index).unwrap()
            )
        })
        .collect();
    println!(
        "{{\n  \"cities\": [\n{}\n  ],\n  \"days\": [\n{}\n  ],\n  \"trips\": [\n{}\n  ],\n  \"records\": [\n{}\n  ]\n}}",
        cities.join(",\n"),
        days.join(",\n"),
        trips().join(",\n"),
        recs.join(",\n")
    );
}
