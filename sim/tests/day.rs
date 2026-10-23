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
//!   `METRO_TEST_CITY` (`harbor`, 2 by 2 districts)

use std::collections::HashMap;
use std::sync::Arc;

use felix_metro_core::record::{Event, TickRecord};
use felix_metro_core::{City, TICKS_PER_DAY};
use felix_metro_sim::{
    Connection, FelixLog, Settings, connect, district_keys, events_stream, run_city,
};

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
    let shards = client
        .stream_shards(&connection.tenant, &connection.namespace, &stream)
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
    // Every crossing is a `left` in one district and an `entered` in another, in one tick.
    assert!(crossings.values().any(|c| c.0 > 0));
    assert!(crossings.values().all(|c| c.0 == c.1), "{crossings:?}");

    // The `keyframe` state key of each district points at its newest keyframe.
    let newest = u64::from((TICKS_PER_DAY - 1) / 240 * 240);
    for (district, key) in district_keys(shards, DISTRICTS).unwrap().iter().enumerate() {
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
