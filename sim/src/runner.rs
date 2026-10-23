//! A city's clock: steps the world, commits one record per district per tick
//! and waits for every answer before the next tick.

use std::future::Future;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use felix_metro_core::City;
use felix_metro_core::record::{Header, TickRecord};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{info, warn};

use crate::latency::Window;
use crate::world::World;

const REPORT_EVERY: Duration = Duration::from_secs(5);

/// What a commit did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Write {
    /// Appended at the expected offset.
    Written,
    /// Not appended: the shard's next offset is `tail`.
    Refused { tail: u64 },
}

/// Where a city's districts are committed. Every commit says the offset it
/// must land at, so the log knows a stale writer or a repeated record.
pub trait Log: Clone + Send + Sync + 'static {
    /// Appends `record` to `district`'s shard at exactly offset `expected`. A
    /// keyframe also leaves `expected` in the shard's `keyframe` state, in the
    /// same commit.
    fn commit(
        &self,
        district: u16,
        expected: u64,
        record: Vec<u8>,
        keyframe: bool,
    ) -> impl Future<Output = Result<Write>> + Send;
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub epoch: u32,
    /// The city's speed: ticks per second, written in every header.
    pub ticks_per_second: u8,
    /// Wait out each tick's period. Tests turn this off to run a day in seconds.
    pub paced: bool,
    /// Stop before stepping this tick. `None` runs until stopped.
    pub stop_at: Option<u32>,
    /// How long one commit may go unanswered before it is sent again.
    pub commit_timeout: Duration,
    /// The wait before the first resend, doubled up to `max_backoff`.
    pub backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            epoch: 0,
            ticks_per_second: 4,
            paced: true,
            stop_at: None,
            commit_timeout: Duration::from_secs(5),
            backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(2),
        }
    }
}

/// What a finished run did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Done {
    /// Ticks committed in every district.
    pub ticks: u32,
    /// Commits sent again after no answer or an error.
    pub retries: u64,
}

/// Where a district's next record goes.
#[derive(Clone, Copy, Default)]
struct Shard {
    /// The offset the next record must land at.
    next: u64,
    /// The offset of the district's latest keyframe.
    keyframe: u64,
}

/// Runs `city` from tick 0, committing to `log`, until `settings.stop_at`. A
/// tick is never skipped: when a commit is slow the clock runs late. Fails if
/// the log has a record this run did not write, which means another sim is
/// live (or this one is restarting over its own history).
pub async fn run_city<L: Log>(name: &str, city: City, settings: Settings, log: L) -> Result<Done> {
    let mut world = World::new(city);
    info!(
        city = name,
        districts = world.districts(),
        residents = world.residents(),
        ticks_per_second = settings.ticks_per_second,
        "city starts"
    );
    let period = Duration::from_secs(1) / u32::from(settings.ticks_per_second.max(1));
    let mut timer = tokio::time::interval(period);
    // A late tick is not made up with a burst: the next one is a period after it.
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut shards = vec![Shard::default(); world.districts()];
    let mut retries = 0u64;
    let mut report = Report::new(Instant::now());
    loop {
        let tick = world.next_tick();
        if settings.stop_at == Some(tick) {
            return Ok(Done {
                ticks: tick,
                retries,
            });
        }
        if settings.paced {
            timer.tick().await;
        }
        let started = Instant::now();
        let wall_us = unix_micros();
        let mut commits = JoinSet::new();
        for (district, step) in world.step().into_iter().enumerate() {
            let shard = shards[district];
            let keyframe = step.keyframe.is_some();
            // A keyframe names itself, which the expected offset makes possible.
            let keyframe_offset = if keyframe { shard.next } else { shard.keyframe };
            let record = TickRecord {
                header: Header {
                    epoch: settings.epoch,
                    district: district as u16,
                    tick,
                    speed: settings.ticks_per_second,
                    keyframe_offset,
                    wall_us,
                },
                keyframe: step.keyframe,
                events: step.events,
            };
            let bytes = record
                .encode()
                .with_context(|| format!("encode district {district} tick {tick}"))?;
            let log = log.clone();
            let (backoff, max_backoff, timeout) = (
                settings.backoff,
                settings.max_backoff,
                settings.commit_timeout,
            );
            commits.spawn(async move {
                let attempts = commit_until_written(
                    &log,
                    district as u16,
                    shard.next,
                    bytes,
                    keyframe,
                    (timeout, backoff, max_backoff),
                )
                .await?;
                Ok::<_, anyhow::Error>((district, keyframe, attempts))
            });
        }
        while let Some(done) = commits.join_next().await {
            let (district, keyframe, attempts) = done.context("a commit task stopped")??;
            let shard = &mut shards[district];
            if keyframe {
                shard.keyframe = shard.next;
            }
            shard.next += 1;
            retries += u64::from(attempts - 1);
            report.retried += u64::from(attempts - 1);
        }
        let took = started.elapsed();
        report.latency.record(took);
        if took > period {
            report.late += 1;
        }
        report.tick = tick;
        if tick.is_multiple_of(crate::world::KEYFRAME_EVERY) {
            info!(city = name, tick, offsets = ?shards.iter().map(|s| s.next).collect::<Vec<_>>(), "keyframe");
        }
        let now = Instant::now();
        if now.duration_since(report.since) >= REPORT_EVERY {
            report.log(name, now);
        }
    }
}

/// Sends `bytes` until the log has it, and returns how many sends that took.
async fn commit_until_written<L: Log>(
    log: &L,
    district: u16,
    expected: u64,
    bytes: Vec<u8>,
    keyframe: bool,
    (timeout, backoff, max_backoff): (Duration, Duration, Duration),
) -> Result<u32> {
    let mut wait = backoff;
    for attempt in 1.. {
        let answer = tokio::time::timeout(
            timeout,
            log.commit(district, expected, bytes.clone(), keyframe),
        )
        .await;
        match answer {
            Ok(Ok(Write::Written)) => return Ok(attempt),
            // An earlier send landed after we gave up on it, and nothing else
            // has been appended since. On a first send the same tail means
            // someone else wrote there.
            Ok(Ok(Write::Refused { tail })) if attempt > 1 && tail == expected + 1 => {
                return Ok(attempt);
            }
            Ok(Ok(Write::Refused { tail })) => bail!(
                "district {district}: the log is at {tail}, not {expected}; another sim is writing it, or this city already has history"
            ),
            Ok(Err(err)) => {
                warn!(district, expected, attempt, error = %format!("{err:#}"), "commit failed, sending again");
            }
            Err(_) => {
                warn!(
                    district,
                    expected, attempt, "no answer within {timeout:?}, sending again"
                );
            }
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(max_backoff);
    }
    unreachable!("the loop only ends by returning")
}

/// Microseconds since the Unix epoch on this host's clock.
fn unix_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_micros()).unwrap_or(u64::MAX)
        })
}

/// What a city did since the last report.
struct Report {
    since: Instant,
    /// Time from stepping a tick to the last district's answer.
    latency: Window,
    tick: u32,
    retried: u64,
    /// Ticks that took longer than their period.
    late: u64,
}

impl Report {
    fn new(since: Instant) -> Self {
        Self {
            since,
            latency: Window::default(),
            tick: 0,
            retried: 0,
            late: 0,
        }
    }

    fn log(&mut self, city: &str, now: Instant) {
        let seconds = now.duration_since(self.since).as_secs_f64();
        let committed = self.latency.len();
        let hz = (committed as f64 / seconds * 10.0).round() / 10.0;
        let ms = |d: Duration| (d.as_secs_f64() * 1e5).round() / 100.0;
        if let Some(summary) = self.latency.take_summary() {
            info!(
                city,
                tick = self.tick,
                committed,
                hz,
                p50_ms = ms(summary.p50),
                p99_ms = ms(summary.p99),
                max_ms = ms(summary.max),
                late = self.late,
                retried = self.retried,
                "ticks committed"
            );
        }
        *self = Self::new(now);
    }
}

#[cfg(test)]
mod tests;
