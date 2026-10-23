use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use felix_metro_core::City;
use felix_metro_core::record::TickRecord;

use super::*;

/// What the in-memory log does to a commit.
#[derive(Clone, Copy, Debug)]
enum Fault {
    /// Answer with an error and append nothing.
    Fail,
    /// Append, then never answer.
    LoseAnswer,
    /// Neither append nor answer.
    Hang,
    /// Append after waiting this long.
    Slow(Duration),
}

type Script = Arc<dyn Fn(u16, u64, u32) -> Option<Fault> + Send + Sync>;

/// A log in memory: each district is a shard whose offsets count records.
#[derive(Clone)]
struct Memory {
    shards: Arc<Mutex<HashMap<u16, Vec<Vec<u8>>>>>,
    keyframes: Arc<Mutex<HashMap<u16, u64>>>,
    sends: Arc<Mutex<HashMap<(u16, u64), u32>>>,
    script: Script,
}

impl Memory {
    fn new(script: impl Fn(u16, u64, u32) -> Option<Fault> + Send + Sync + 'static) -> Memory {
        Memory {
            shards: Arc::default(),
            keyframes: Arc::default(),
            sends: Arc::default(),
            script: Arc::new(script),
        }
    }

    fn healthy() -> Memory {
        Memory::new(|_, _, _| None)
    }

    fn records(&self, district: u16) -> Vec<TickRecord> {
        let shards = self.shards.lock().unwrap();
        shards
            .get(&district)
            .map(|r| r.iter().map(|b| TickRecord::decode(b).unwrap()).collect())
            .unwrap_or_default()
    }

    fn append(&self, district: u16, expected: u64, record: Vec<u8>, keyframe: bool) -> Write {
        let mut shards = self.shards.lock().unwrap();
        let shard = shards.entry(district).or_default();
        if shard.len() as u64 != expected {
            return Write::Refused {
                tail: shard.len() as u64,
            };
        }
        shard.push(record);
        if keyframe {
            self.keyframes.lock().unwrap().insert(district, expected);
        }
        Write::Written
    }
}

impl Log for Memory {
    async fn commit(
        &self,
        district: u16,
        expected: u64,
        record: Vec<u8>,
        keyframe: bool,
    ) -> Result<Write> {
        let attempt = {
            let mut sends = self.sends.lock().unwrap();
            let n = sends.entry((district, expected)).or_default();
            *n += 1;
            *n
        };
        match (self.script)(district, expected, attempt) {
            None => Ok(self.append(district, expected, record, keyframe)),
            Some(Fault::Fail) => Err(anyhow::anyhow!("connection reset")),
            Some(Fault::LoseAnswer) => {
                self.append(district, expected, record, keyframe);
                std::future::pending().await
            }
            Some(Fault::Hang) => std::future::pending().await,
            Some(Fault::Slow(wait)) => {
                tokio::time::sleep(wait).await;
                Ok(self.append(district, expected, record, keyframe))
            }
        }
    }
}

fn city() -> City {
    City::generate("harbor", 2).unwrap()
}

fn settings(ticks: u32) -> Settings {
    Settings {
        stop_at: Some(ticks),
        ..Settings::default()
    }
}

/// Every district has ticks `0..ticks` once each, in order.
fn assert_whole(log: &Memory, ticks: u32) {
    for district in 0..4 {
        let seen: Vec<u32> = log
            .records(district)
            .iter()
            .map(|r| r.header.tick)
            .collect();
        assert_eq!(seen, (0..ticks).collect::<Vec<_>>(), "district {district}");
    }
}

#[tokio::test(start_paused = true)]
async fn every_district_gets_every_tick_in_order() {
    let log = Memory::healthy();
    let done = run_city("harbor", city(), settings(500), log.clone())
        .await
        .unwrap();
    assert_eq!(
        done,
        Done {
            ticks: 500,
            retries: 0
        }
    );
    assert_whole(&log, 500);
}

#[tokio::test(start_paused = true)]
async fn headers_carry_the_epoch_speed_and_the_keyframe_a_keyframe_names_itself() {
    let log = Memory::healthy();
    let mut s = settings(500);
    s.epoch = 7;
    s.ticks_per_second = 8;
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    for district in 0..4 {
        let mut latest = None;
        for (offset, r) in log.records(district).iter().enumerate() {
            assert_eq!((r.header.epoch, r.header.speed), (7, 8));
            assert_eq!(r.header.district, district);
            assert!(r.header.wall_us > 0);
            if r.header.tick % 240 == 0 {
                assert!(r.keyframe.is_some());
                latest = Some(offset as u64);
            } else {
                assert!(r.keyframe.is_none());
            }
            assert_eq!(Some(r.header.keyframe_offset), latest);
        }
        // The keyframe state key holds the offset of the latest one.
        assert_eq!(log.keyframes.lock().unwrap()[&district], 480);
    }
}

#[tokio::test(start_paused = true)]
async fn the_clock_is_four_ticks_a_second() {
    let log = Memory::healthy();
    let start = Instant::now();
    run_city("harbor", city(), settings(41), log).await.unwrap();
    // The first tick is due at once, then one every 250 ms.
    assert_eq!(start.elapsed(), Duration::from_secs(10));
}

#[tokio::test(start_paused = true)]
async fn a_failed_district_is_sent_again_and_the_tick_waits_for_it() {
    let log = Memory::new(|district, expected, attempt| {
        (district == 2 && expected % 7 == 3 && attempt <= 2).then_some(Fault::Fail)
    });
    let done = run_city("harbor", city(), settings(100), log.clone())
        .await
        .unwrap();
    assert_whole(&log, 100);
    assert_eq!(done.retries, 2 * 14);
    // The resend is the same bytes, so a reader sees one record.
    assert_eq!(log.records(2).len(), 100);
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_commit_is_sent_again_after_the_timeout() {
    let log = Memory::new(|district, expected, attempt| {
        (district == 1 && expected == 5 && attempt == 1).then_some(Fault::Hang)
    });
    let done = run_city("harbor", city(), settings(20), log.clone())
        .await
        .unwrap();
    assert_whole(&log, 20);
    assert_eq!(done.retries, 1);
}

#[tokio::test(start_paused = true)]
async fn a_record_that_landed_but_was_never_answered_is_not_written_twice() {
    let log = Memory::new(|district, expected, attempt| {
        (district == 3 && expected % 4 == 0 && attempt == 1).then_some(Fault::LoseAnswer)
    });
    let done = run_city("harbor", city(), settings(40), log.clone())
        .await
        .unwrap();
    assert_whole(&log, 40);
    assert_eq!(done.retries, 10);
}

#[tokio::test(start_paused = true)]
async fn a_slow_commit_makes_the_clock_late_and_never_drops_a_tick() {
    // One commit takes eight periods.
    let log = Memory::new(|district, expected, _| {
        (district == 0 && expected == 10).then_some(Fault::Slow(Duration::from_secs(2)))
    });
    let start = Instant::now();
    run_city("harbor", city(), settings(40), log.clone())
        .await
        .unwrap();
    assert_whole(&log, 40);
    // 40 periods and the stall, with no burst to catch up.
    assert!(
        start.elapsed() >= Duration::from_secs(11),
        "{:?}",
        start.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn the_next_tick_waits_for_every_district() {
    let log = Memory::new(|district, _, _| {
        (district == 3).then_some(Fault::Slow(Duration::from_millis(600)))
    });
    run_city("harbor", city(), settings(5), log.clone())
        .await
        .unwrap();
    // Had the fast districts run ahead, they would have been appended by now
    // and the slow one would still be at its first record when time stopped.
    assert_whole(&log, 5);
}

#[tokio::test(start_paused = true)]
async fn a_log_with_someone_elses_records_stops_the_city() {
    let log = Memory::healthy();
    log.append(1, 0, vec![1, 2, 3], false);
    let err = run_city("harbor", city(), settings(5), log)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("another sim"), "{err:#}");
}
