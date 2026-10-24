//! A city's clock: steps the world, commits one record per district per tick
//! and waits for every answer before the next tick.

use std::collections::VecDeque;
use std::future::Future;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use felix_metro_core::City;
use felix_metro_core::record::{Event, Header, TickRecord};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{info, warn};

use crate::commands::{Incoming, MAX_PER_TICK, apply_all};
use crate::control::check_speed;
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

    /// The record at `offset` in `district`'s shard, if there is one.
    fn read(
        &self,
        district: u16,
        offset: u64,
    ) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub epoch: u32,
    /// The city's speed when the run starts: 0 (paused), 4, 8 or 16 ticks per
    /// second, written in every header. 0 needs `speed`, or the run never moves.
    pub ticks_per_second: u8,
    /// Changes the speed while the run is going. The runner reads it between
    /// ticks, so a change lands on the next tick.
    pub speed: Option<watch::Receiver<u8>>,
    /// Wait out each tick's period. Tests turn this off to run a day in seconds.
    pub paced: bool,
    /// Stop before stepping this tick. `None` runs until stopped.
    pub stop_at: Option<u32>,
    /// How long one commit may go unanswered before it is sent again.
    pub commit_timeout: Duration,
    /// The wait before the first resend, doubled up to `max_backoff`.
    pub backoff: Duration,
    pub max_backoff: Duration,
    /// Sends in a row that may fail before the run gives up.
    pub max_failures: u32,
    /// Sends in a row that may fail with an error that looks permanent. A few
    /// are allowed because a rollout, such as a fleet finalizing a feature,
    /// answers the same way until it reaches every broker.
    pub max_permanent: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            epoch: 0,
            ticks_per_second: 4,
            speed: None,
            paced: true,
            stop_at: None,
            commit_timeout: Duration::from_secs(5),
            backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(2),
            max_failures: 60,
            max_permanent: 30,
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
///
/// A speed change is applied before the next tick is stepped: that tick's
/// header carries the new speed and each district's record a `speed` event.
/// Changing to 0 commits that tick as the last one, then the clock waits; a
/// resume continues at the next tick with no catch-up burst.
pub async fn run_city<L: Log>(name: &str, city: City, settings: Settings, log: L) -> Result<Done> {
    run_city_with(name, city, settings, log, None).await
}

/// Like [`run_city`], applying the builders' commands that arrive on `commands`.
/// They are applied in order before the next tick is stepped, so that tick's
/// records carry the `command` events and what they changed, and its keyframe
/// shows the result. A paused city keeps them until a `speed` command or the
/// operator resumes it.
pub async fn run_city_with<L: Log>(
    name: &str,
    city: City,
    settings: Settings,
    log: L,
    mut inbox: Option<mpsc::Receiver<Incoming>>,
) -> Result<Done> {
    let mut speed = check_speed(settings.ticks_per_second)?;
    let mut control = settings.speed.clone();
    if speed == 0 && control.is_none() && inbox.is_none() {
        bail!("the city starts paused and nothing can resume it");
    }
    let mut world = World::new(city);
    info!(
        city = name,
        districts = world.districts(),
        residents = world.residents(),
        ticks_per_second = settings.ticks_per_second,
        "city starts"
    );
    let mut period = tick_period(speed);
    let mut timer = new_timer(period, true);
    // Set once the tick that carried speed 0 is committed.
    let mut parked = speed == 0;
    let mut shards = vec![Shard::default(); world.districts()];
    let mut retries = 0u64;
    let mut report = Report::new(Instant::now());
    let mut queue: VecDeque<Incoming> = VecDeque::new();
    loop {
        let tick = world.next_tick();
        if settings.stop_at == Some(tick) {
            return Ok(Done {
                ticks: tick,
                retries,
            });
        }
        let mut wanted = speed;
        if parked {
            if control.is_none() && inbox.is_none() {
                bail!("the city is paused and nothing can resume it");
            }
            loop {
                tokio::select! {
                    speed_set = wait_resumed(&mut control) => {
                        wanted = check_speed(speed_set?)?;
                        break;
                    }
                    got = next_incoming(&mut inbox) => match got {
                        Some(got) => {
                            let wakes = got.resumes();
                            queue.push_back(got);
                            if wakes {
                                break;
                            }
                        }
                        None => {
                            inbox = None;
                            if control.is_none() {
                                bail!("the city is paused and nothing can resume it");
                            }
                        }
                    },
                }
            }
        } else if let Some(control) = control.as_mut() {
            wanted = check_speed(*control.borrow_and_update())?;
        }
        if let Some(inbox) = inbox.as_mut() {
            while queue.len() < MAX_PER_TICK {
                let Ok(got) = inbox.try_recv() else { break };
                queue.push_back(got);
            }
        }
        let taken: Vec<Incoming> = queue.drain(..queue.len().min(MAX_PER_TICK)).collect();
        let mut commanded = apply_all(&mut world, taken, &mut wanted);
        let mut changed = None;
        if wanted != speed {
            speed = wanted;
            changed = Some(speed);
            if speed != 0 {
                period = tick_period(speed);
                // The first tick back from a pause is due at once.
                timer = new_timer(period, parked);
            }
        }
        if parked {
            // Don't average the first report over the pause.
            report = Report::new(Instant::now());
        }
        if settings.paced {
            timer.tick().await;
        }
        let started = Instant::now();
        let wall_us = unix_micros();
        let mut commits = JoinSet::new();
        for (district, step) in world.step().into_iter().enumerate() {
            let commanded = std::mem::take(&mut commanded[district]);
            let shard = shards[district];
            let keyframe = step.keyframe.is_some();
            // A keyframe names itself, which the expected offset makes possible.
            let keyframe_offset = if keyframe { shard.next } else { shard.keyframe };
            let record = TickRecord {
                header: Header {
                    epoch: settings.epoch,
                    district: district as u16,
                    tick,
                    speed,
                    keyframe_offset,
                    wall_us,
                },
                keyframe: step.keyframe,
                events: changed
                    .map(|ticks_per_second| Event::Speed { ticks_per_second })
                    .into_iter()
                    .chain(commanded)
                    .chain(step.events)
                    .collect(),
            };
            let bytes = record
                .encode()
                .with_context(|| format!("encode district {district} tick {tick}"))?;
            let log = log.clone();
            let retry = Retry {
                timeout: settings.commit_timeout,
                backoff: settings.backoff,
                max_backoff: settings.max_backoff,
                max_failures: settings.max_failures,
                max_permanent: settings.max_permanent,
            };
            commits.spawn(async move {
                let attempts =
                    commit_until_written(&log, district as u16, shard.next, bytes, keyframe, retry)
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
        parked = speed == 0;
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

/// The speed the operator's control resumes a paused city at, or never when
/// there is no control.
async fn wait_resumed(control: &mut Option<watch::Receiver<u8>>) -> Result<u8> {
    match control {
        Some(control) => Ok(*control
            .wait_for(|s| *s != 0)
            .await
            .context("the speed control was dropped while the city was paused")?),
        None => std::future::pending().await,
    }
}

/// The next command, or never when there is no inbox.
async fn next_incoming(inbox: &mut Option<mpsc::Receiver<Incoming>>) -> Option<Incoming> {
    match inbox {
        Some(inbox) => inbox.recv().await,
        None => std::future::pending().await,
    }
}

/// The time between ticks at `speed`. Paused counts as 1 Hz, which only keeps
/// the lateness check from dividing by zero.
fn tick_period(speed: u8) -> Duration {
    Duration::from_secs(1) / u32::from(speed.max(1))
}

/// A timer whose first tick is due at once or one period from now.
fn new_timer(period: Duration, immediate: bool) -> tokio::time::Interval {
    let mut timer = if immediate {
        tokio::time::interval(period)
    } else {
        tokio::time::interval_at(Instant::now() + period, period)
    };
    // A late tick is not made up with a burst: the next one is a period after it.
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    timer
}

/// How a commit is sent again.
#[derive(Clone, Copy)]
struct Retry {
    timeout: Duration,
    backoff: Duration,
    max_backoff: Duration,
    max_failures: u32,
    max_permanent: u32,
}

/// True for an error that sending again cannot fix, such as a revoked token,
/// a deleted stream or a record the broker will not take. Anything else, a
/// dropped connection or a leader change, may pass.
fn is_permanent(err: &anyhow::Error) -> bool {
    use felix_client::{BrokerError, CommitError, PublishRefused, RetryClass};
    err.downcast_ref::<CommitError>().is_some()
        || err.downcast_ref::<PublishRefused>().is_some()
        || err
            .downcast_ref::<BrokerError>()
            .is_some_and(|e| e.retry == RetryClass::Fatal)
}

/// Sends `bytes` until the log has it, and returns how many sends that took.
async fn commit_until_written<L: Log>(
    log: &L,
    district: u16,
    expected: u64,
    bytes: Vec<u8>,
    keyframe: bool,
    retry: Retry,
) -> Result<u32> {
    let mut wait = retry.backoff;
    let mut failures = 0u32;
    let mut permanent = 0u32;
    for attempt in 1.. {
        let answer = tokio::time::timeout(
            retry.timeout,
            log.commit(district, expected, bytes.clone(), keyframe),
        )
        .await;
        match answer {
            Ok(Ok(Write::Written)) => return Ok(attempt),
            // An earlier send may have landed after we gave up on it. Only the
            // record itself says so: a second writer could be at `expected`.
            Ok(Ok(Write::Refused { tail })) if attempt > 1 && tail == expected + 1 => {
                match log.read(district, expected).await {
                    Ok(Some(stored)) if stored == bytes => return Ok(attempt),
                    Ok(_) => bail!(
                        "district {district}: offset {expected} holds a record this sim did not write; another sim is writing it"
                    ),
                    Err(err) => {
                        failures += 1;
                        warn!(district, expected, attempt, error = %format!("{err:#}"), "could not read back the record, sending again");
                    }
                }
            }
            Ok(Ok(Write::Refused { tail })) => bail!(
                "district {district}: the log is at {tail}, not {expected}; another sim is writing it, or this city already has history"
            ),
            Ok(Err(err)) if is_permanent(&err) => {
                permanent += 1;
                if permanent >= retry.max_permanent {
                    return Err(err.context(format!(
                        "district {district}: the log refused offset {expected} {permanent} times in a row, and sending again will not change that"
                    )));
                }
                warn!(district, expected, attempt, error = %format!("{err:#}"), "commit refused, sending again");
            }
            Ok(Err(err)) => {
                permanent = 0;
                failures += 1;
                warn!(district, expected, attempt, error = %format!("{err:#}"), "commit failed, sending again");
            }
            Err(_) => {
                failures += 1;
                warn!(
                    district,
                    expected, attempt, "no answer within {:?}, sending again", retry.timeout
                );
            }
        }
        if failures >= retry.max_failures {
            bail!(
                "district {district}: offset {expected} failed {failures} sends in a row; giving up so the city does not freeze"
            );
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(retry.max_backoff);
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
