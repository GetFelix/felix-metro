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

/// A tracing writer that keeps what it is given.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn the_first_report_after_a_pause_does_not_average_over_it() {
    // A process-wide subscriber: a per-test one loses to callsites that other
    // parallel tests cached as disabled. Lines are picked out by city name.
    static LOGS: std::sync::OnceLock<Captured> = std::sync::OnceLock::new();
    let logs = LOGS.get_or_init(|| {
        let sink = Captured::default();
        let writer = sink.clone();
        let _ = tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish(),
        );
        sink
    });
    let (tx, rx) = watch::channel(8u8);
    let log = Memory::steered(&[(9, 0)], tx.clone());
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        tx.send_replace(16);
    });
    let mut s = settings(150);
    s.ticks_per_second = 8;
    s.speed = Some(rx);
    run_city("report-after-pause", city(), s, log)
        .await
        .unwrap();
    let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let rates: Vec<f64> = text
        .lines()
        .filter(|l| l.contains("ticks committed") && l.contains("city=\"report-after-pause\""))
        .filter_map(|l| {
            l.split(" hz=")
                .nth(1)?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        })
        .collect();
    assert!(!rates.is_empty(), "no report: {text}");
    assert!(rates.iter().all(|hz| *hz >= 8.0), "{rates:?}");
}

#[tokio::test(start_paused = true)]
async fn a_flip_within_one_tick_nets_to_no_event() {
    let (tx, rx) = watch::channel(4u8);
    // 4 -> 0 -> 4 before the runner looks again.
    let log = Memory::steered(&[(9, 0), (9, 4)], tx);
    let mut s = settings(20);
    s.speed = Some(rx);
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    assert_whole(&log, 20);
    for district in 0..4 {
        for (tick, speed, event) in speeds(&log, district) {
            assert_eq!((speed, event), (4, None), "district {district} tick {tick}");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_resume_arriving_during_the_pause_ticks_commit_resumes_cleanly() {
    let (tx, rx) = watch::channel(4u8);
    // 0 lands on tick 10; the resume arrives while tick 10 is committing.
    let log = Memory::steered(&[(9, 0), (10, 8)], tx);
    let mut s = settings(20);
    s.speed = Some(rx);
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    assert_whole(&log, 20);
    for district in 0..4 {
        let events: Vec<_> = speeds(&log, district)
            .into_iter()
            .filter(|(_, _, e)| e.is_some())
            .collect();
        // The pause tick carries its event, and the resume tick another.
        assert_eq!(
            events,
            [(10, 0, Some(0)), (11, 8, Some(8))],
            "district {district}"
        );
    }
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
        // Pause lands on tick 200 and the resume on 201; the other changes
        // sit on the tick after their trigger.
        let changes: Vec<_> = speeds(&steered, district)
            .into_iter()
            .filter(|(_, _, e)| e.is_some())
            .collect();
        assert_eq!(
            changes,
            [
                (100, 16, Some(16)),
                (200, 0, Some(0)),
                (201, 8, Some(8)),
                (400, 4, Some(4))
            ],
            "district {district}"
        );
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

fn warm(warmup: u32, stop: u32) -> Settings {
    Settings {
        warmup_ticks: warmup,
        ..settings(stop)
    }
}

#[tokio::test(start_paused = true)]
async fn a_new_city_commits_its_warmup_at_once_then_runs_at_normal_speed() {
    let log = Memory::healthy();
    let (warming, seen) = watch::channel(true);
    let mut s = warm(500, 700);
    s.warming = Some(warming);
    let start = Instant::now();
    let done = run_city("harbor", city(), s, log.clone()).await.unwrap();
    assert_eq!(done.ticks, 700);
    assert_whole(&log, 700);
    // The first live tick is due at once, then one every 250 ms: 200 live ticks.
    assert_eq!(start.elapsed(), Duration::from_millis(199 * 250));
    assert!(!*seen.borrow());
    for district in 0..4 {
        let records = log.records(district);
        let mut latest = None;
        for (offset, r) in records.iter().enumerate() {
            if r.header.tick % 240 == 0 {
                latest = Some(offset as u64);
            }
            assert_eq!(Some(r.header.keyframe_offset), latest);
        }
        assert_eq!(log.keyframes.lock().unwrap()[&district], 480);
        // Warm-up ticks are stamped as if they ran at 4 Hz up to go-live.
        for pair in records[..500].windows(2) {
            assert_eq!(pair[1].header.wall_us - pair[0].header.wall_us, 250_000);
        }
        assert!(records[500].header.wall_us > records[499].header.wall_us);
    }
}

#[tokio::test(start_paused = true)]
async fn the_warmup_keeps_each_districts_order_through_failures() {
    let log = Memory::new(|district, offset, attempt| {
        (district == 2 && offset % 97 == 5 && attempt == 1).then_some(Fault::Fail)
    });
    let done = run_city("harbor", city(), warm(400, 400), log.clone())
        .await
        .unwrap();
    assert_eq!(done.ticks, 400);
    assert!(done.retries >= 4, "{done:?}");
    assert_whole(&log, 400);
}

#[tokio::test(start_paused = true)]
async fn another_writer_in_the_warmup_stops_the_city() {
    let log = Memory::new(|district, offset, attempt| {
        (district == 1 && offset == 30 && attempt == 1).then_some(Fault::Foreign)
    });
    let err = run_city("harbor", city(), warm(400, 400), log)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("another sim"), "{err:#}");
}

#[tokio::test(start_paused = true)]
async fn a_city_with_history_does_not_warm_up_again() {
    let log = Memory::healthy();
    log.append(1, 0, vec![1, 2, 3], false);
    let err = run_city("harbor", city(), warm(2000, 2000), log.clone())
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("another sim"), "{err:#}");
    // A warm-up would have run district 0 hundreds of ticks ahead before the refusal.
    assert!(log.records(0).len() <= 1, "{}", log.records(0).len());
}

#[tokio::test(start_paused = true)]
async fn without_a_warmup_the_city_starts_at_tick_zero_as_before() {
    let log = Memory::healthy();
    let (warming, seen) = watch::channel(true);
    let mut s = warm(0, 41);
    s.warming = Some(warming);
    let start = Instant::now();
    run_city("harbor", city(), s, log.clone()).await.unwrap();
    assert_eq!(start.elapsed(), Duration::from_secs(10));
    assert_whole(&log, 41);
    assert!(!*seen.borrow());
}

#[tokio::test(start_paused = true)]
async fn a_city_that_starts_paused_skips_the_warmup() {
    let log = Memory::healthy();
    let (control, speed) = watch::channel(0u8);
    let mut s = warm(300, 10);
    s.ticks_per_second = 0;
    s.speed = Some(speed);
    let task = tokio::spawn(run_city("harbor", city(), s, log.clone()));
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(log.records(0).is_empty());
    control.send_replace(4);
    task.await.unwrap().unwrap();
    assert_whole(&log, 10);
}

mod builders {
    use felix_metro_core::record::{
        Command, REFUSED_IN_USE, REFUSED_OCCUPIED, RESULT_APPLIED, principal_hash,
    };

    use super::*;
    use crate::commands::tests::{city as harbor, command, free_lot};

    fn command_events(log: &Memory, district: u16) -> Vec<(u32, u64, u32, u8)> {
        let mut out = Vec::new();
        for r in log.records(district) {
            for e in &r.events {
                if let Event::Command {
                    principal,
                    id,
                    result,
                    ..
                } = e
                {
                    out.push((r.header.tick, *principal, *id, *result));
                }
            }
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn a_command_is_recorded_on_the_next_tick_in_the_district_it_touched() {
        let world = World::new(harbor());
        let lot = free_lot(&world);
        let district = world.city.lots[lot as usize].district;
        let used = *world.in_use.iter().min().unwrap();
        let used_district = world.city.lots[used as usize].district;
        let (send, inbox) = mpsc::channel(16);
        // Sent after tick 5 is committed in district 0, so it is applied for tick 6.
        let mut log = Memory::healthy();
        log.hook = Arc::new(move |d, offset| {
            if d == 0 && offset == 5 {
                for c in [
                    command(
                        "mayor",
                        11,
                        Command::Build {
                            lot,
                            kind: 4,
                            rotation: 1,
                        },
                    ),
                    command("mayor", 12, Command::Demolish { lot: used }),
                    command(
                        "viewer",
                        13,
                        Command::Build {
                            lot,
                            kind: 6,
                            rotation: 0,
                        },
                    ),
                ] {
                    send.try_send(c).unwrap();
                }
            }
        });
        run_city_with("harbor", harbor(), settings(245), log.clone(), Some(inbox))
            .await
            .unwrap();
        assert_whole(&log, 245);

        let mayor = principal_hash("mayor");
        let viewer = principal_hash("viewer");
        let mut expected: HashMap<u16, Vec<(u32, u64, u32, u8)>> = HashMap::new();
        expected
            .entry(district)
            .or_default()
            .push((6, mayor, 11, RESULT_APPLIED));
        expected
            .entry(used_district)
            .or_default()
            .push((6, mayor, 12, REFUSED_IN_USE));
        expected
            .entry(district)
            .or_default()
            .push((6, viewer, 13, REFUSED_OCCUPIED));
        for d in 0..4 {
            let mut want = expected.remove(&d).unwrap_or_default();
            want.sort_by_key(|c| c.2);
            let mut got = command_events(&log, d);
            got.sort_by_key(|c| c.2);
            assert_eq!(got, want, "district {d}");
        }

        // The change is a `built` event in the same record, in the lot's district only.
        let record = &log.records(district)[6];
        let command_at = record
            .events
            .iter()
            .position(|e| matches!(e, Event::Command { id: 11, .. }))
            .unwrap();
        assert_eq!(
            record.events[command_at + 1],
            Event::Built {
                lot,
                kind: 4,
                rotation: 1
            }
        );
        for d in (0..4).filter(|d| *d != district) {
            let events = &log.records(d)[6].events;
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, Event::Built { .. } | Event::Demolished { .. }))
            );
        }

        // A keyframe after it holds the change, and the one before did not.
        let before = log.records(district)[0].keyframe.clone().unwrap();
        assert!(before.buildings.is_empty());
        let after = log.records(district)[240].keyframe.clone().unwrap();
        assert_eq!(
            after.buildings,
            vec![felix_metro_core::record::BuildingDiff {
                lot,
                kind: 4,
                rotation: 1
            }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_speed_command_resumes_a_paused_city_and_is_recorded() {
        let (send, inbox) = mpsc::channel(4);
        send.try_send(command(
            "mayor",
            1,
            Command::Speed {
                ticks_per_second: 8,
            },
        ))
        .unwrap();
        let mut s = settings(4);
        s.ticks_per_second = 0;
        let log = Memory::healthy();
        run_city_with("harbor", harbor(), s, log.clone(), Some(inbox))
            .await
            .unwrap();
        assert_whole(&log, 4);
        let first = &log.records(0)[0];
        assert_eq!(first.header.speed, 8);
        assert!(first.events.iter().any(|e| matches!(
            e,
            Event::Speed {
                ticks_per_second: 8
            }
        )));
        assert_eq!(
            command_events(&log, 0),
            vec![(0, principal_hash("mayor"), 1, RESULT_APPLIED)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_build_sent_while_paused_waits_for_the_resume() {
        let (send, inbox) = mpsc::channel(4);
        let lot = free_lot(&World::new(harbor()));
        send.try_send(command(
            "mayor",
            1,
            Command::Build {
                lot,
                kind: 2,
                rotation: 0,
            },
        ))
        .unwrap();
        send.try_send(command(
            "mayor",
            2,
            Command::Speed {
                ticks_per_second: 4,
            },
        ))
        .unwrap();
        let mut s = settings(2);
        s.ticks_per_second = 0;
        let log = Memory::healthy();
        run_city_with("harbor", harbor(), s, log.clone(), Some(inbox))
            .await
            .unwrap();
        let all: Vec<u32> = (0..4)
            .flat_map(|d| command_events(&log, d))
            .map(|c| c.0)
            .collect();
        assert_eq!(all, vec![0, 0]);
    }

    /// A hang is a failure: a stranded command parks the city for good.
    async fn bounded<T>(what: &str, run: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(600), run)
            .await
            .unwrap_or_else(|_| panic!("{what}: the city never finished"))
    }

    fn speed_command(id: u32, ticks_per_second: u8) -> Incoming {
        command("mayor", id, Command::Speed { ticks_per_second })
    }

    /// Settings wired as the real binary does: the operator's watch both ways.
    fn wired(ticks: u32, start: u8) -> (Settings, watch::Sender<u8>) {
        let (tx, rx) = watch::channel(start);
        let mut s = settings(ticks);
        s.ticks_per_second = start;
        s.speed = Some(rx);
        s.speed_out = Some(tx.clone());
        (s, tx)
    }

    fn speed_events(log: &Memory, district: u16) -> usize {
        log.records(district)
            .iter()
            .flat_map(|r| &r.events)
            .filter(|e| matches!(e, Event::Speed { .. }))
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn a_commanded_speed_sticks_when_the_operator_watch_is_wired() {
        let (send, inbox) = mpsc::channel(4);
        send.try_send(speed_command(1, 8)).unwrap();
        let (s, tx) = wired(6, 4);
        let log = Memory::healthy();
        bounded(
            "a_commanded_speed_sticks_when_the_operator_watch_is_wired",
            run_city_with("harbor", harbor(), s, log.clone(), Some(inbox)),
        )
        .await
        .unwrap();
        for district in 0..4 {
            assert!(log.records(district).iter().all(|r| r.header.speed == 8));
            assert_eq!(speed_events(&log, district), 1, "district {district}");
        }
        assert_eq!(*tx.borrow(), 8, "the endpoint reports the commanded speed");
    }

    #[tokio::test(start_paused = true)]
    async fn a_commanded_pause_holds_until_something_resumes_the_city() {
        let (send, inbox) = mpsc::channel(4);
        send.try_send(speed_command(1, 0)).unwrap();
        let (s, _tx) = wired(3, 4);
        let log = Memory::healthy();
        let started = Instant::now();
        let resume = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            send.send(speed_command(2, 4)).await.unwrap();
            send
        });
        bounded(
            "a_commanded_pause_holds_until_something_resumes_the_city",
            run_city_with("harbor", harbor(), s, log.clone(), Some(inbox)),
        )
        .await
        .unwrap();
        drop(resume);
        assert!(
            started.elapsed() >= Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_whole(&log, 3);
        assert_eq!(speeds(&log, 0)[0].1, 0);
        assert_eq!(speeds(&log, 0)[1].1, 4);
    }

    #[tokio::test(start_paused = true)]
    async fn a_city_started_paused_stays_resumed_after_a_command() {
        let (send, inbox) = mpsc::channel(4);
        send.try_send(speed_command(1, 8)).unwrap();
        let (s, _tx) = wired(5, 0);
        let log = Memory::healthy();
        tokio::time::timeout(
            Duration::from_secs(60),
            run_city_with("harbor", harbor(), s, log.clone(), Some(inbox)),
        )
        .await
        .expect("the city fell back to the stale paused watch")
        .unwrap();
        drop(send);
        assert_whole(&log, 5);
        assert!(log.records(0).iter().all(|r| r.header.speed == 8));
        assert_eq!(speed_events(&log, 0), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_operator_change_after_a_command_still_wins() {
        let (send, inbox) = mpsc::channel(4);
        send.try_send(speed_command(1, 8)).unwrap();
        let (s, tx) = wired(6, 4);
        let log = Memory::steered(&[(1, 16)], tx);
        let mut s = s;
        s.speed_out = None;
        run_city_with("harbor", harbor(), s, log.clone(), Some(inbox))
            .await
            .unwrap();
        let seen: Vec<u8> = log.records(0).iter().map(|r| r.header.speed).collect();
        assert_eq!(seen, vec![8, 8, 16, 16, 16, 16]);
        drop(send);
    }

    #[tokio::test(start_paused = true)]
    async fn a_paused_city_holds_a_bounded_queue_and_refuses_the_rest_once_resumed() {
        use crate::commands::{MAX_HELD, MAX_PER_TICK};
        use felix_metro_core::record::REFUSED_BUSY;
        let extra = 10;
        let (send, inbox) = mpsc::channel(MAX_HELD + extra + 4);
        let lot = free_lot(&World::new(harbor()));
        for id in 1..=(MAX_HELD + extra) as u32 {
            send.try_send(command(
                "mayor",
                id,
                Command::Build {
                    lot,
                    kind: 2,
                    rotation: 0,
                },
            ))
            .unwrap();
        }
        let resume_id = (MAX_HELD + extra) as u32 + 1;
        send.try_send(speed_command(resume_id, 4)).unwrap();
        let ticks = (MAX_HELD / MAX_PER_TICK) as u32 + 4;
        let (s, _tx) = wired(ticks, 0);
        let log = Memory::healthy();
        bounded(
            "a_paused_city_holds_a_bounded_queue_and_refuses_the_rest_once_resumed",
            run_city_with("harbor", harbor(), s, log.clone(), Some(inbox)),
        )
        .await
        .unwrap();
        // The sim never skipped a tick.
        assert_whole(&log, ticks);
        let mut results: HashMap<u32, u8> = HashMap::new();
        for d in 0..4 {
            for (_, _, id, result) in command_events(&log, d) {
                assert!(
                    results.insert(id, result).is_none(),
                    "id {id} recorded twice"
                );
            }
        }
        // Every command got exactly one result.
        assert_eq!(results.len(), MAX_HELD + extra + 1);
        let busy = results.values().filter(|r| **r == REFUSED_BUSY).count();
        assert_eq!(busy, extra);
        assert_eq!(results[&resume_id], RESULT_APPLIED);
        drop(send);
    }

    fn build(id: u32, lot: u32) -> Incoming {
        command(
            "mayor",
            id,
            Command::Build {
                lot,
                kind: 2,
                rotation: 0,
            },
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_resume_behind_a_pause_in_the_queue_is_not_stranded() {
        use crate::commands::MAX_PER_TICK;
        let lot = free_lot(&World::new(harbor()));
        let extra = 300;
        let (send, inbox) = mpsc::channel(extra + 8);
        send.try_send(speed_command(1, 0)).unwrap();
        for id in 2..(extra as u32 + 2) {
            send.try_send(build(id, lot)).unwrap();
        }
        let resume_id = extra as u32 + 2;
        send.try_send(speed_command(resume_id, 4)).unwrap();
        assert!(extra + 2 > MAX_PER_TICK);
        let (s, _tx) = wired(8, 0);
        let log = Memory::healthy();
        bounded(
            "resume",
            run_city_with("harbor", harbor(), s, log.clone(), Some(inbox)),
        )
        .await
        .unwrap();
        assert_whole(&log, 8);
        let mut ids: Vec<u32> = (0..4)
            .flat_map(|d| command_events(&log, d))
            .map(|c| c.2)
            .collect();
        ids.sort();
        assert_eq!(ids, (1..=resume_id).collect::<Vec<_>>());
        assert_eq!(log.records(0).last().unwrap().header.speed, 4);
        drop(send);
    }

    #[tokio::test(start_paused = true)]
    async fn a_flood_past_what_a_paused_city_remembers_stays_bounded_and_resumes() {
        use crate::commands::{MAX_HELD, MAX_REFUSED};
        use felix_metro_core::record::REFUSED_BUSY;
        let sent = MAX_HELD + MAX_REFUSED + 500;
        let (send, inbox) = mpsc::channel(sent + 4);
        let lot = free_lot(&World::new(harbor()));
        for id in 1..=sent as u32 {
            send.try_send(build(id, lot)).unwrap();
        }
        let resume_id = sent as u32 + 1;
        send.try_send(speed_command(resume_id, 4)).unwrap();
        let ticks = 24;
        let (s, _tx) = wired(ticks, 0);
        let log = Memory::healthy();
        bounded(
            "flood",
            run_city_with("harbor", harbor(), s, log.clone(), Some(inbox)),
        )
        .await
        .unwrap();
        assert_whole(&log, ticks);
        let results: Vec<(u32, u8)> = (0..4)
            .flat_map(|d| command_events(&log, d))
            .map(|c| (c.2, c.3))
            .collect();
        // Held, remembered-to-refuse and the resume get a result; the rest were dropped.
        assert_eq!(results.len(), MAX_HELD + MAX_REFUSED + 1);
        let busy = results.iter().filter(|r| r.1 == REFUSED_BUSY).count();
        assert_eq!(busy, MAX_REFUSED);
        assert!(results.contains(&(resume_id, RESULT_APPLIED)));
        drop(send);
    }

    #[test]
    fn an_operator_setting_after_the_runner_read_is_not_overwritten() {
        let (tx, mut rx) = watch::channel(4u8);
        // The runner read 4, then the operator set 16 before the write-back.
        tx.send_replace(16);
        assert!(!publish_speed(&tx, Some(&mut rx), 8));
        assert_eq!(*tx.borrow(), 16);
        assert!(rx.has_changed().unwrap(), "the setting is still to be read");
        // With nothing newer, the commanded speed is reported and not re-read.
        rx.borrow_and_update();
        assert!(publish_speed(&tx, Some(&mut rx), 8));
        assert_eq!(*tx.borrow(), 8);
        assert!(!rx.has_changed().unwrap());
    }
}
