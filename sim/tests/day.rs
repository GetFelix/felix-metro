//! A city runs for a simulated day against a real broker, and the log is read
//! back to check that every district has every tick in order.
//!
//! Needs a broker with the stream `metro.events.<city>` (one shard a district,
//! empty) and a token that may publish to and read it, so it is ignored by
//! default. CI starts one (see `sim/ci/`). Settings, all from the environment:
//!
//! - `METRO_TEST_BROKER` (default `127.0.0.1:5000`), `METRO_TEST_SERVER_NAME`
//!   (`localhost`), `METRO_TEST_CA_FILE`, `METRO_TEST_TOKEN_FILE` (required)
//! - `METRO_TEST_TENANT` (`metro`), `METRO_TEST_NAMESPACE` (`default`) and
//!   `METRO_TEST_CITY` (`harbor`, 2 by 2 districts) and `METRO_TEST_SPEED_CITY`
//!   (`speedway`, also 2 by 2, for the speed test, which needs its own empty stream)

use std::collections::HashMap;
use std::sync::Arc;

use felix_metro_core::record::{Doing, Event, TickRecord};
use felix_metro_core::{City, TICKS_PER_DAY};
use felix_metro_sim::{
    Connection, FelixLog, Settings, connect, district_keys, events_stream, run_city,
};
use felix_metro_sim::{Log, Write};
use std::time::Duration;
use tokio::sync::watch;

const DISTRICTS_PER_SIDE: u16 = 2;
const DISTRICTS: usize = 4;

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn connection() -> Connection {
    Connection {
        brokers: vec![var("METRO_TEST_BROKER").unwrap_or_else(|| "127.0.0.1:5000".into())],
        server_name: var("METRO_TEST_SERVER_NAME").unwrap_or_else(|| "localhost".into()),
        ca_file: var("METRO_TEST_CA_FILE").map(Into::into),
        token_file: var("METRO_TEST_TOKEN_FILE")
            .expect("METRO_TEST_TOKEN_FILE names the sim's token")
            .into(),
        tenant: var("METRO_TEST_TENANT").unwrap_or_else(|| "metro".into()),
        namespace: var("METRO_TEST_NAMESPACE").unwrap_or_else(|| "default".into()),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a Felix broker; CI runs it"]
async fn a_city_runs_a_day_with_every_tick_in_every_district() {
    // The sim's own log lines, with `--nocapture`.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_test_writer()
        .init();
    let connection = connection();
    let city_name = var("METRO_TEST_CITY").unwrap_or_else(|| "harbor".into());
    let stream = events_stream(&city_name);
    let client = Arc::new(connect(&connection).await.expect("connect to Felix"));
    let log = FelixLog::open(Arc::clone(&client), &connection, &city_name, DISTRICTS)
        .await
        .expect("open the city's stream");

    let city = City::generate(&city_name, DISTRICTS_PER_SIDE).unwrap();
    assert_eq!(city.districts.len(), DISTRICTS);
    let settings = Settings {
        // Faster than real time: the commits set the pace.
        paced: false,
        stop_at: Some(TICKS_PER_DAY),
        ..Settings::default()
    };
    let started = std::time::Instant::now();
    let done = run_city(&city_name, city, settings, log)
        .await
        .expect("a day's run");
    eprintln!(
        "{} ticks in {:?}, {} retries",
        done.ticks,
        started.elapsed(),
        done.retries
    );
    assert_eq!(done.ticks, TICKS_PER_DAY);

    // Read every shard back. District `i` is on shard `i`, and only it.
    let (shards, routing) = client
        .client()
        .await
        .stream_routing(&connection.tenant, &connection.namespace, &stream)
        .await
        .unwrap();
    let mut records: HashMap<u16, Vec<(u64, TickRecord)>> = HashMap::new();
    for shard in 0..shards {
        let mut from = 0;
        loop {
            let page = client
                .read(
                    &connection.tenant,
                    &connection.namespace,
                    &stream,
                    shard,
                    from,
                    None,
                    1000,
                )
                .await
                .unwrap_or_else(|e| panic!("read shard {shard} from {from}: {e:#}"));
            if page.records.is_empty() {
                break;
            }
            for record in &page.records {
                let tick = TickRecord::decode(&record.payload).expect("a tick record");
                assert_eq!(
                    u32::from(tick.header.district),
                    shard,
                    "district {} on shard {shard}",
                    tick.header.district
                );
                records
                    .entry(tick.header.district)
                    .or_default()
                    .push((record.offset, tick));
            }
            from = page.next_offset;
        }
    }

    assert_eq!(records.len(), DISTRICTS, "districts with records");
    let mut crossings: HashMap<u32, (u32, u32)> = HashMap::new();
    for district in 0..DISTRICTS as u16 {
        let rows = &records[&district];
        assert_eq!(rows.len(), TICKS_PER_DAY as usize, "district {district}");
        let mut keyframe = None;
        for (i, (offset, record)) in rows.iter().enumerate() {
            let tick = i as u32;
            assert_eq!(
                *offset,
                u64::from(tick),
                "district {district} offsets are dense"
            );
            assert_eq!(
                record.header.tick, tick,
                "district {district}: tick {tick} in order"
            );
            assert_eq!(record.header.epoch, 0);
            assert_eq!(record.header.speed, 4);
            assert!(record.header.wall_us > 0);
            if tick.is_multiple_of(240) {
                assert!(record.keyframe.is_some(), "district {district} tick {tick}");
                keyframe = Some(*offset);
            } else {
                assert!(record.keyframe.is_none());
            }
            assert_eq!(Some(record.header.keyframe_offset), keyframe);
            for event in &record.events {
                match event {
                    Event::Left { .. } => crossings.entry(tick).or_default().0 += 1,
                    Event::Entered { .. } => crossings.entry(tick).or_default().1 += 1,
                    _ => {}
                }
            }
        }
    }
    // Replaying the events leaves each vehicle in the district the next
    // keyframe draws it in: none left behind where it crossed or arrived.
    let mut vehicles: HashMap<u32, u16> = HashMap::new();
    #[allow(clippy::needless_range_loop)] // indexes every district's records by tick
    for tick in 0..TICKS_PER_DAY as usize {
        // Left first, then in, then arrived: districts are visited in order.
        for pass in 0..3 {
            for district in 0..DISTRICTS as u16 {
                for event in &records[&district][tick].1.events {
                    match (pass, event) {
                        (0, Event::Left { resident, .. }) => {
                            assert_eq!(vehicles.remove(resident), Some(district), "tick {tick}");
                        }
                        (1, Event::Trip { resident, .. } | Event::Entered { resident, .. }) => {
                            assert!(vehicles.insert(*resident, district).is_none());
                        }
                        (2, Event::Arrived { resident, .. }) => {
                            assert_eq!(vehicles.remove(resident), Some(district), "tick {tick}");
                        }
                        _ => {}
                    }
                }
            }
        }
        if tick % 240 == 0 {
            let mut drawn = HashMap::new();
            for district in 0..DISTRICTS as u16 {
                let frame = records[&district][tick].1.keyframe.as_ref().unwrap();
                for r in &frame.residents {
                    if matches!(r.doing, Doing::Trip(_)) {
                        drawn.insert(r.id, district);
                    }
                }
            }
            assert_eq!(vehicles, drawn, "tick {tick}");
        }
    }
    // Every crossing is a `left` in one district and an `entered` in another, in one tick.
    assert!(crossings.values().any(|c| c.0 > 0));
    assert!(crossings.values().all(|c| c.0 == c.1), "{crossings:?}");

    // The `keyframe` state key of each district points at its newest keyframe.
    let newest = u64::from((TICKS_PER_DAY - 1) / 240 * 240);
    for (district, key) in district_keys(shards, routing, DISTRICTS)
        .unwrap()
        .iter()
        .enumerate()
    {
        let state = client
            .state_get(
                &connection.tenant,
                &connection.namespace,
                &stream,
                key.as_bytes(),
                "keyframe",
            )
            .await
            .unwrap();
        assert_eq!(state.version, Some(newest), "district {district}");
        assert_eq!(state.value.as_deref(), Some(&newest.to_le_bytes()[..]));
    }
}

/// A log that sets the city's speed after district 0 commits given offsets.
/// The runner reads the speed once every district has answered, so a change
/// lands on the tick after.
#[derive(Clone)]
struct Steered {
    inner: FelixLog,
    changes: Arc<Vec<(u64, u8)>>,
    speed: watch::Sender<u8>,
    resume_after: Duration,
}

impl Log for Steered {
    async fn commit(
        &self,
        district: u16,
        expected: u64,
        record: Vec<u8>,
        keyframe: bool,
    ) -> anyhow::Result<Write> {
        let written = self
            .inner
            .commit(district, expected, record, keyframe)
            .await?;
        if district == 0 && written == Write::Written {
            for (_, to) in self.changes.iter().filter(|(at, _)| *at == expected) {
                self.speed.send_replace(*to);
                if *to == 0 {
                    // A pause needs someone to end it.
                    let (speed, after) = (self.speed.clone(), self.resume_after);
                    tokio::spawn(async move {
                        tokio::time::sleep(after).await;
                        speed.send_replace(4);
                    });
                }
            }
        }
        Ok(written)
    }

    async fn read(&self, district: u16, offset: u64) -> anyhow::Result<Option<Vec<u8>>> {
        self.inner.read(district, offset).await
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a Felix broker; CI runs it"]
async fn a_city_runs_through_pause_and_every_speed_with_no_gap() {
    let connection = connection();
    let city_name = var("METRO_TEST_SPEED_CITY").unwrap_or_else(|| "speedway".into());
    let stream = events_stream(&city_name);
    let client = Arc::new(connect(&connection).await.expect("connect to Felix"));
    let inner = FelixLog::open(Arc::clone(&client), &connection, &city_name, DISTRICTS)
        .await
        .expect("open the city's stream");
    let (speed, rx) = watch::channel(4u8);
    let pause = Duration::from_millis(500);
    let log = Steered {
        inner,
        // 4 Hz to tick 7, 8 Hz to 15, 16 Hz to 31, paused after 32, then 4 Hz.
        changes: Arc::new(vec![(7, 8), (15, 16), (31, 0)]),
        speed,
        resume_after: pause,
    };
    let city = City::generate(&city_name, DISTRICTS_PER_SIDE).unwrap();
    let ticks = 40;
    let settings = Settings {
        speed: Some(rx),
        stop_at: Some(ticks),
        ..Settings::default()
    };
    run_city(&city_name, city, settings, log)
        .await
        .expect("the run");

    let mut by_district: HashMap<u16, Vec<TickRecord>> = HashMap::new();
    for shard in 0..DISTRICTS as u32 {
        let mut from = 0;
        loop {
            let page = client
                .read(
                    &connection.tenant,
                    &connection.namespace,
                    &stream,
                    shard,
                    from,
                    None,
                    1000,
                )
                .await
                .unwrap();
            if page.records.is_empty() {
                break;
            }
            for record in &page.records {
                let tick = TickRecord::decode(&record.payload).expect("a tick record");
                by_district
                    .entry(tick.header.district)
                    .or_default()
                    .push(tick);
            }
            from = page.next_offset;
        }
    }
    assert_eq!(by_district.len(), DISTRICTS);
    for district in 0..DISTRICTS as u16 {
        let rows = &by_district[&district];
        assert_eq!(rows.len(), ticks as usize, "district {district}");
        for (i, record) in rows.iter().enumerate() {
            let tick = i as u32;
            assert_eq!(
                record.header.tick, tick,
                "district {district}: no gap or repeat"
            );
            let (speed, change) = match tick {
                0..=7 => (4, None),
                8 => (8, Some(8)),
                9..=15 => (8, None),
                16 => (16, Some(16)),
                17..=31 => (16, None),
                32 => (0, Some(0)),
                33 => (4, Some(4)),
                _ => (4, None),
            };
            let event = record.events.iter().find_map(|e| match e {
                Event::Speed { ticks_per_second } => Some(*ticks_per_second),
                _ => None,
            });
            assert_eq!(
                (record.header.speed, event),
                (speed, change),
                "district {district} tick {tick}"
            );
        }
        // The clock stood still for the pause: tick 33 came after it, and
        // resuming did not squeeze the ticks after it together.
        let wall = |t: usize| rows[t].header.wall_us;
        assert!(
            wall(33) - wall(32) >= 300_000,
            "district {district}: {} us between the pause and the resume",
            wall(33) - wall(32)
        );
        assert!(
            wall(39) - wall(33) >= 1_000_000,
            "district {district}: ticks 33 to 39 at 4 Hz"
        );
    }
}
