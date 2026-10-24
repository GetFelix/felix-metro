use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use felix_metro_core::City;
use felix_metro_core::record::{Event, TickRecord};

use tokio::sync::watch;

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
    /// Another writer appends a different record, and this commit never answers.
    Foreign,
    /// Answer with an error that sending again cannot fix.
    Permanent,
}

type Script = Arc<dyn Fn(u16, u64, u32) -> Option<Fault> + Send + Sync>;

/// A log in memory: each district is a shard whose offsets count records.
#[derive(Clone)]
struct Memory {
    shards: Arc<Mutex<HashMap<u16, Vec<Vec<u8>>>>>,
    keyframes: Arc<Mutex<HashMap<u16, u64>>>,
    sends: Arc<Mutex<HashMap<(u16, u64), u32>>>,
    /// `(district, offset)` of every append, in the order they happened.
    order: Arc<Mutex<Vec<(u16, u64)>>>,
    script: Script,
    /// Called with `(district, offset)` after each append.
    hook: Arc<dyn Fn(u16, u64) + Send + Sync>,
}

impl Memory {
    fn new(script: impl Fn(u16, u64, u32) -> Option<Fault> + Send + Sync + 'static) -> Memory {
        Memory {
            shards: Arc::default(),
            keyframes: Arc::default(),
            sends: Arc::default(),
            order: Arc::default(),
            script: Arc::new(script),
            hook: Arc::new(|_, _| {}),
        }
    }

    /// A healthy log that sets the speed after district 0 commits the given
    /// offsets. The runner reads the speed only once every district has
    /// answered, so each change lands on the tick after.
    fn steered(changes: &[(u64, u8)], speed: watch::Sender<u8>) -> Memory {
        let changes = changes.to_vec();
        let mut log = Memory::healthy();
        log.hook = Arc::new(move |district, offset| {
            if district == 0 {
                for (at, to) in &changes {
                    if *at == offset {
                        speed.send_replace(*to);
                    }
                }
            }
        });
        log
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
        drop(shards);
        self.order.lock().unwrap().push((district, expected));
        if keyframe {
            self.keyframes.lock().unwrap().insert(district, expected);
        }
        (self.hook)(district, expected);
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
            Some(Fault::Foreign) => {
                self.append(district, expected, vec![9, 9, 9], false);
                std::future::pending().await
            }
            Some(Fault::Permanent) => Err(felix_client::CommitError::Unsupported.into()),
            Some(Fault::Slow(wait)) => {
                tokio::time::sleep(wait).await;
                Ok(self.append(district, expected, record, keyframe))
            }
        }
    }

    async fn read(&self, district: u16, offset: u64) -> Result<Option<Vec<u8>>> {
        let shards = self.shards.lock().unwrap();
        Ok(shards
            .get(&district)
            .and_then(|shard| shard.get(offset as usize).cloned()))
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
    assert_whole(&log, 5);
    // A district that ran ahead would append tick t + 1 before the slow one
    // had tick t, so the offsets in append order would go back down.
    let order = log.order.lock().unwrap();
    assert_eq!(order.len(), 20);
    assert!(
        order.windows(2).all(|w| w[0].1 <= w[1].1),
        "appends out of tick order: {order:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_retry_that_finds_another_writers_record_stops_the_city() {
    // The first send is lost, but not before another sim appended at its offset.
    let log = Memory::new(|district, expected, attempt| {
        (district == 1 && expected == 3 && attempt == 1).then_some(Fault::Foreign)
    });
    let err = run_city("harbor", city(), settings(10), log)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("did not write"), "{err:#}");
}

#[tokio::test(start_paused = true)]
async fn an_error_that_cannot_pass_ends_the_run_after_a_few_sends() {
    let log = Memory::new(|district, expected, _| {
        (district == 2 && expected == 4).then_some(Fault::Permanent)
    });
    let mut s = settings(10);
    s.max_permanent = 3;
    let err = run_city("harbor", city(), s, log.clone())
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("district 2"), "{err:#}");
    // Not the 60 a transient error gets.
    assert_eq!(log.sends.lock().unwrap()[&(2, 4)], 3);
}

#[tokio::test(start_paused = true)]
async fn a_district_that_keeps_failing_ends_the_run_instead_of_freezing_the_city() {
    let log = Memory::new(|district, expected, _| {
        (district == 0 && expected == 2).then_some(Fault::Fail)
    });
    let mut s = settings(10);
    s.max_failures = 5;
    let err = run_city("harbor", city(), s, log.clone())
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("5 sends in a row"), "{err:#}");
    assert_eq!(log.sends.lock().unwrap()[&(0, 2)], 5);
}

#[tokio::test(start_paused = true)]
async fn a_refusal_that_clears_is_ridden_out() {
    let log = Memory::new(|district, expected, attempt| {
        (district == 2 && expected == 4 && attempt <= 5).then_some(Fault::Permanent)
    });
    run_city("harbor", city(), settings(10), log.clone())
        .await
        .unwrap();
    assert_whole(&log, 10);
}

#[tokio::test(start_paused = true)]
async fn a_city_that_starts_paused_with_no_way_to_resume_is_refused() {
    let mut s = settings(5);
    s.ticks_per_second = 0;
    assert!(
        run_city("harbor", city(), s, Memory::healthy())
            .await
            .is_err()
    );
}

#[tokio::test(start_paused = true)]
async fn only_pause_and_the_three_speeds_are_accepted() {
    for n in [1, 5, 15, 17, 255] {
        let mut s = settings(5);
        s.ticks_per_second = n;
        assert!(
            run_city("harbor", city(), s, Memory::healthy())
                .await
                .is_err(),
            "{n}"
        );
    }
    let (tx, rx) = watch::channel(4u8);
    let mut s = settings(5);
    s.speed = Some(rx);
    tx.send_replace(9);
    assert!(
        run_city("harbor", city(), s, Memory::healthy())
            .await
            .is_err()
    );
}

#[tokio::test(start_paused = true)]
async fn each_speed_runs_at_its_rate_with_one_record_per_tick_per_district() {
    for (speed, period_ms) in [(4u8, 250u64), (8, 125), (16, 62)] {
        let log = Memory::healthy();
        let mut s = settings(41);
        s.ticks_per_second = speed;
        let start = Instant::now();
        run_city("harbor", city(), s, log.clone()).await.unwrap();
        assert_whole(&log, 41);
        // The first tick is due at once. 1 s / 16 is 62.5 ms, which the
        // timer rounds down to a whole millisecond.
        let periods = 40 * period_ms;
        let took = start.elapsed().as_millis() as u64;
        assert!(took.abs_diff(periods) <= 40, "{speed} Hz took {took} ms");
        for district in 0..4 {
            for r in log.records(district) {
                assert_eq!(r.header.speed, speed);
                assert!(!r.events.iter().any(|e| matches!(e, Event::Speed { .. })));
            }
        }
    }
}

/// Speed header and `speed` events of one district, by tick.
fn speeds(log: &Memory, district: u16) -> Vec<(u32, u8, Option<u8>)> {
    log.records(district)
        .iter()
        .map(|r| {
            let event = r.events.iter().find_map(|e| match e {
                Event::Speed { ticks_per_second } => Some(*ticks_per_second),
                _ => None,
            });
            (r.header.tick, r.header.speed, event)
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_change_lands_on_the_next_tick_in_every_district_and_on_no_other() {
    let (tx, rx) = watch::channel(4u8);
    let log = Memory::steered(&[(9, 8), (19, 16), (29, 4)], tx);
    let mut s = settings(40);
    s.speed = Some(rx);
    let start = Instant::now();
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    assert_whole(&log, 40);
    for district in 0..4 {
        for (tick, speed, event) in speeds(&log, district) {
            let expect = match tick {
                0..=9 => 4,
                10..=19 => 8,
                20..=29 => 16,
                _ => 4,
            };
            let change = matches!(tick, 10 | 20 | 30).then_some(expect);
            assert_eq!(
                (speed, event),
                (expect, change),
                "district {district} tick {tick}"
            );
        }
    }
    // Each stretch runs at its own rate, and the first tick after a change
    // waits one period of the new rate.
    let took = start.elapsed().as_millis() as u64;
    assert!(took.abs_diff(6625) <= 60, "took {took} ms");
}

#[tokio::test(start_paused = true)]
async fn pause_commits_no_ticks_and_resume_continues_without_a_burst() {
    let (tx, rx) = watch::channel(8u8);
    let log = Memory::steered(&[(9, 0)], tx.clone());
    let resume = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        tx.send_replace(16);
    });
    let mut s = settings(30);
    s.ticks_per_second = 8;
    s.speed = Some(rx);
    let start = Instant::now();
    let probe = log.clone();
    let watcher = tokio::spawn(async move {
        // Well inside the pause: the log must not have moved.
        tokio::time::sleep(Duration::from_secs(30)).await;
        probe.records(0).len()
    });
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    resume.await.unwrap();
    assert_eq!(watcher.await.unwrap(), 11, "ticks 0 to 10, then nothing");
    assert_whole(&log, 30);
    for district in 0..4 {
        for (tick, speed, event) in speeds(&log, district) {
            let expect = match tick {
                0..=9 => (8, None),
                10 => (0, Some(0)),
                11 => (16, Some(16)),
                _ => (16, None),
            };
            assert_eq!((speed, event), expect, "district {district} tick {tick}");
        }
    }
    // Tick 11 at the resume, then 18 more at 16 Hz: a burst to catch up
    // would end much sooner.
    let took = start.elapsed().as_millis() as u64;
    assert!(took.abs_diff(61_100) <= 100, "took {took} ms");
}

#[tokio::test(start_paused = true)]
async fn a_city_can_start_paused_and_then_run() {
    let (tx, rx) = watch::channel(0u8);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        tx.send_replace(8);
    });
    let log = Memory::healthy();
    let mut s = settings(10);
    s.ticks_per_second = 0;
    s.speed = Some(rx);
    let start = Instant::now();
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    assert_whole(&log, 10);
    assert_eq!(speeds(&log, 0)[0], (0, 8, Some(8)));
    assert!(start.elapsed() >= Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn the_log_and_the_city_are_the_same_at_any_speed_and_a_seek_finds_its_tick() {
    let slow = Memory::healthy();
    run_city("harbor", city(), settings(500), slow.clone())
        .await
        .unwrap();

    let (tx, rx) = watch::channel(4u8);
    let steered = Memory::steered(&[(99, 16), (199, 0), (300, 8), (399, 4)], tx.clone());
    let resume = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        tx.send_replace(8);
    });
    let mut s = settings(500);
    s.speed = Some(rx);
    run_city("harbor", city(), s, steered.clone())
        .await
        .unwrap();
    resume.await.unwrap();

    for district in 0..4u16 {
        let (a, b) = (slow.records(district), steered.records(district));
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            // Only the speed and its events differ.
            assert_eq!(x.keyframe, y.keyframe);
            let rest = |r: &TickRecord| -> Vec<Event> {
                r.events
                    .iter()
                    .filter(|e| !matches!(e, Event::Speed { .. }))
                    .cloned()
                    .collect()
            };
            assert_eq!(
                rest(x),
                rest(y),
                "district {district} tick {}",
                x.header.tick
            );
            assert_eq!(x.header.keyframe_offset, y.header.keyframe_offset);
        }
        // Seek the way a viewer will, by tick number alone: guess an offset,
        // read it, and correct by the difference. Speed is never consulted.
        for target in [0u32, 99, 100, 199, 200, 201, 300, 301, 399, 400, 499] {
            let mut guess = 0u64;
            for _ in 0..4 {
                let shard = steered.shards.lock().unwrap();
                let at = TickRecord::decode(&shard[&district][guess as usize]).unwrap();
                if at.header.tick == target {
                    break;
                }
                guess = (guess as i64 + i64::from(target) - i64::from(at.header.tick)) as u64;
            }
            let shard = steered.shards.lock().unwrap();
            let found = TickRecord::decode(&shard[&district][guess as usize]).unwrap();
            assert_eq!(found.header.tick, target, "district {district}");
            assert_eq!(guess, u64::from(target));
        }
    }
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
