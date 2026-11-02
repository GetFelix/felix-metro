//! A city's clock: steps the world, commits one record per district per tick
//! and waits for every answer before the next tick.

use std::collections::VecDeque;
use std::future::Future;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use felix_metro_core::record::{Event, Header, TickRecord};
use felix_metro_core::{City, TICKS_PER_DAY};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{info, warn};

use crate::commands::{Incoming, MAX_HELD, MAX_PER_TICK, MAX_REFUSED, apply_all, refuse_busy};
use crate::control::check_speed;
use crate::latency::Window;
use crate::markers::{self, Marked, Today};
use crate::resume::{History, LOOKBACK, read_history, retrying};
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
    /// keyframe also leaves `expected` in the shard's `keyframe` state, and
    /// `markers` leaves a day's timeline markers in the shard's state, in the
    /// same commit.
    fn commit(
        &self,
        district: u16,
        expected: u64,
        record: Vec<u8>,
        keyframe: bool,
        markers: Option<&Marked>,
    ) -> impl Future<Output = Result<Write>> + Send;

    /// The timeline markers stored for city day `day`, or `None` when none were.
    fn markers(&self, day: u32) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;

    /// The record at `offset` in `district`'s shard, if there is one.
    fn read(
        &self,
        district: u16,
        offset: u64,
    ) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;

    /// The offset of the newest keyframe `district` committed, or `None` before
    /// its first.
    fn keyframe(&self, district: u16) -> impl Future<Output = Result<Option<u64>>> + Send;

    /// Up to `max` records of `district` from `offset` on, each with its
    /// offset. Empty at the tail.
    fn read_from(
        &self,
        district: u16,
        offset: u64,
        max: u32,
    ) -> impl Future<Output = Result<Vec<(u64, Vec<u8>)>>> + Send;

    /// The commands at offsets `from..until` of the city's command stream, less
    /// any that carry no sender stamp.
    fn commands(&self, from: u64, until: u64)
    -> impl Future<Output = Result<Vec<Incoming>>> + Send;
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
    /// Where a commanded speed is written, so the operator's endpoint reports
    /// what the city runs at. Without it the runner still keeps the command
    /// and reads `speed` only when it changes.
    pub speed_out: Option<watch::Sender<u8>>,
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
    /// Ticks to commit as fast as the log takes them before the clock starts,
    /// when the city has no history yet. 0 starts live at tick 0. A city that
    /// starts paused skips it.
    pub warmup_ticks: u32,
    /// True while the warm-up has not finished, so the operator's endpoint can
    /// say when the city went live. The runner clears it, also when there is
    /// no warm-up to do.
    pub warming: Option<watch::Sender<bool>>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            epoch: 0,
            ticks_per_second: 4,
            speed: None,
            speed_out: None,
            paced: true,
            stop_at: None,
            commit_timeout: Duration::from_secs(5),
            backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(2),
            max_failures: 60,
            max_permanent: 30,
            warmup_ticks: 0,
            warming: None,
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

/// Runs `city`, committing to `log`, until `settings.stop_at`. A new city
/// starts at tick 0; one whose log holds records carries on from the next tick
/// (see [`run_with_history`]). A tick is never skipped: when a commit is slow
/// the clock runs late. Fails if the log has a record this run did not write,
/// which means another sim is live.
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
    inbox: Option<mpsc::Receiver<Incoming>>,
) -> Result<Done> {
    let history = load_history(&log, city.districts.len(), &settings).await?;
    run_with_history(name, city, settings, log, inbox, history).await
}

/// Reads what the log holds of a city with `districts` districts, or `None`
/// for a city that has not started. The caller opens the command stream at
/// [`History::commands_from`] before running.
pub async fn load_history<L: Log>(
    log: &L,
    districts: usize,
    settings: &Settings,
) -> Result<Option<History>> {
    read_history(log, districts, Retry::of(settings), LOOKBACK).await
}

/// Like [`run_city_with`], over a history already read.
///
/// With a history, the city carries on from the tick after the newest one the
/// log holds: the world is rebuilt from the newest keyframe and the records
/// after it, a tick some districts committed and others did not is finished
/// (what the commands of that tick did is re-derived from the command stream),
/// and the city runs at the speed it last had. The epoch stays the same, since
/// the ticks continue.
pub async fn run_with_history<L: Log>(
    name: &str,
    city: City,
    mut settings: Settings,
    log: L,
    mut inbox: Option<mpsc::Receiver<Incoming>>,
    history: Option<History>,
) -> Result<Done> {
    let mut control = settings.speed.clone();
    let mut shards = vec![Shard::default(); city.districts.len()];
    let mut retries = 0u64;
    let mut report = Report::new(Instant::now());
    // The command stream offset the commands applied so far reach. A run with
    // no inbox reads no commands and keeps none.
    let mut cursor = inbox.is_some().then_some(0);
    let retry = Retry::of(&settings);
    let (mut world, mut speed) = match &history {
        None => (World::new(city), check_speed(settings.ticks_per_second)?),
        Some(history) => {
            settings.epoch = history.epoch();
            cursor = history.commands_from();
            for (shard, tail) in shards.iter_mut().zip(history.tails()) {
                *shard = Shard {
                    next: tail.next,
                    keyframe: tail.keyframe,
                };
            }
            let speed = check_speed(history.speed())?;
            (history.world(city)?, speed)
        }
    };
    if speed == 0 && control.is_none() && inbox.is_none() {
        bail!("the city starts paused and nothing can resume it");
    }
    info!(
        city = name,
        districts = world.districts(),
        residents = world.residents(),
        ticks_per_second = speed,
        resumed_at = history.as_ref().map(|_| world.next_tick()),
        "city starts"
    );
    if history.is_some() {
        // A restarted city runs at the speed it was left at, whatever the operator started the sim with.
        if let Some(out) = &settings.speed_out {
            out.send_replace(speed);
            if let Some(control) = control.as_mut() {
                control.borrow_and_update();
            }
        }
    }
    let mut period = tick_period(speed);
    let mut timer = new_timer(period, true);
    // Set once the tick that carried speed 0 is committed.
    let mut parked = speed == 0;
    let mut today = Today::default();
    let mut queue: VecDeque<Incoming> = VecDeque::new();
    let mut refused: VecDeque<Incoming> = VecDeque::new();
    if let Some(history) = &history {
        for tick in history.unfinished() {
            let (at, changed) = history.speed_at(tick);
            let incoming = match history.commands_in(tick) {
                Some((from, to)) => {
                    retrying(retry, "read the commands of the unfinished tick", || {
                        log.commands(from, to)
                    })
                    .await?
                }
                None => Vec::new(),
            };
            let said = history.cursor_event(tick);
            cursor = said.or(cursor);
            let mut wanted = at;
            let commanded = apply_all(&mut world, incoming, &mut wanted);
            let marked = mark(&log, retry, &mut today, tick, &commanded).await?;
            let step = world.step();
            let tick_retries = commit_tick(
                &log,
                retry,
                Tick {
                    epoch: settings.epoch,
                    number: tick,
                    speed: at,
                    changed: changed.then_some(at),
                    cursor: said,
                    wall_us: unix_micros(),
                },
                step,
                commanded,
                marked,
                &mut shards,
                |district| !history.lacks(district, tick),
            )
            .await?;
            retries += tick_retries;
        }
        info!(
            city = name,
            tick = world.next_tick(),
            "city resumed from its log"
        );
    } else {
        let warm = settings
            .warmup_ticks
            .min(settings.stop_at.unwrap_or(u32::MAX));
        if warm > 0 && speed != 0 {
            let plan = WarmUp {
                ticks: warm,
                speed,
                cursor,
            };
            retries += warm_up(name, &mut world, &mut shards, plan, &log, &settings).await?;
            timer = new_timer(period, true);
            report = Report::new(Instant::now());
        }
    }
    if let Some(warming) = &settings.warming {
        warming.send_replace(false);
    }
    loop {
        let tick = world.next_tick();
        if settings.stop_at.is_some_and(|stop| tick >= stop) {
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
            // A resume still in the queue (left behind by a pause that came
            // ahead of it) is already here: waiting would strand it.
            if let Some(at) = queue.iter().find_map(Incoming::resumes_at) {
                wanted = at;
            } else {
                let mut dropped = 0u64;
                loop {
                    tokio::select! {
                        speed_set = wait_resumed(&mut control) => {
                            wanted = check_speed(speed_set?)?;
                            break;
                        }
                        got = next_incoming(&mut inbox) => match got {
                            Some(got) => {
                                let wakes = got.resumes_at();
                                // The command that resumes the city is always kept, or it could not.
                                if wakes.is_some() || queue.len() < MAX_HELD {
                                    queue.push_back(got);
                                } else if refused.len() < MAX_REFUSED {
                                    refused.push_back(got);
                                } else {
                                    dropped += 1;
                                    if dropped == 1 {
                                        warn!(city = name, "the paused city holds no more commands; dropping the rest");
                                    }
                                }
                                if let Some(at) = wakes {
                                    // Commands queued ahead of it may take several ticks to apply.
                                    wanted = at;
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
                if dropped > 0 {
                    warn!(
                        city = name,
                        dropped, "commands dropped while the city was paused"
                    );
                }
            }
        }
        // Read right before the commands apply, so a later command overrides
        // an earlier operator setting and the write-back below can tell a
        // setting that arrives after this read.
        if let Some(control) = control.as_mut()
            && control.has_changed().unwrap_or(false)
        {
            wanted = check_speed(*control.borrow_and_update())?;
        }
        if let Some(inbox) = inbox.as_mut() {
            while queue.len() < MAX_PER_TICK {
                let Ok(got) = inbox.try_recv() else { break };
                queue.push_back(got);
            }
        }
        let taken: Vec<Incoming> = queue.drain(..queue.len().min(MAX_PER_TICK)).collect();
        let room = MAX_PER_TICK - taken.len();
        let mut moved = advance(&mut cursor, &taken);
        let mut commanded = apply_all(&mut world, taken, &mut wanted);
        // Commands the paused city had no room for are refused once its queue is clear.
        if queue.is_empty() {
            let busy: Vec<Incoming> = refused.drain(..refused.len().min(room)).collect();
            moved |= advance(&mut cursor, &busy);
            commanded[0].extend(busy.into_iter().map(refuse_busy));
        }
        let mut changed = None;
        if wanted != speed {
            speed = wanted;
            changed = Some(speed);
            if let Some(out) = &settings.speed_out {
                publish_speed(out, control.as_mut(), speed);
            }
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
        let marked = mark(&log, retry, &mut today, tick, &commanded).await?;
        let step = world.step();
        let keyframe = step[0].keyframe.is_some();
        let attempts = commit_tick(
            &log,
            retry,
            Tick {
                epoch: settings.epoch,
                number: tick,
                speed,
                changed,
                cursor: cursor.filter(|_| moved || keyframe),
                wall_us: unix_micros(),
            },
            step,
            commanded,
            marked,
            &mut shards,
            |_| false,
        )
        .await?;
        retries += attempts;
        report.retried += attempts;
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

/// Moves `cursor` past the commands in `taken`; true if it moved.
fn advance(cursor: &mut Option<u64>, taken: &[Incoming]) -> bool {
    let reached = taken.iter().filter_map(|c| c.offset).map(|o| o + 1).max();
    match reached {
        Some(reached) if cursor.is_none_or(|c| reached > c) => {
            *cursor = Some(reached);
            true
        }
        _ => false,
    }
}

/// What a tick's records have in common.
struct Tick {
    epoch: u32,
    number: u32,
    speed: u8,
    /// Set on the tick the speed changed, and goes in a `speed` event.
    changed: Option<u8>,
    /// The command stream position to record, on the ticks that record one.
    cursor: Option<u64>,
    wall_us: u64,
}

/// The markers the tick's applied commands make, with the day's list read first when this run has not
/// written to that day yet. `None` for a tick that marks nothing, which is nearly every tick.
async fn mark<L: Log>(
    log: &L,
    retry: Retry,
    today: &mut Today,
    tick: u32,
    commanded: &[Vec<Event>],
) -> Result<Option<Marked>> {
    let new = markers::from_commands(tick, commanded);
    if new.is_empty() {
        return Ok(None);
    }
    let day = tick / TICKS_PER_DAY;
    if today.day() != Some(day) {
        let stored = retrying(retry, "read the day's markers", || log.markers(day)).await?;
        *today = Today::load(day, stored.as_deref())?;
    }
    today.add(tick, new)
}

/// Encodes the tick's record for each district and commits them, except the
/// districts `has` says already hold the tick. Waits for every answer, then
/// moves the districts' offsets on. `marked` goes in district 0's commit.
/// Returns the commits that had to be sent again.
async fn commit_tick<L: Log>(
    log: &L,
    retry: Retry,
    tick: Tick,
    step: Vec<crate::world::DistrictTick>,
    mut commanded: Vec<Vec<Event>>,
    marked: Option<Marked>,
    shards: &mut [Shard],
    has: impl Fn(usize) -> bool,
) -> Result<u64> {
    let mut commits = JoinSet::new();
    for (district, step) in step.into_iter().enumerate() {
        if has(district) {
            continue;
        }
        let commanded = std::mem::take(&mut commanded[district]);
        let shard = shards[district];
        let keyframe = step.keyframe.is_some();
        // A keyframe names itself, which the expected offset makes possible.
        let keyframe_offset = if keyframe { shard.next } else { shard.keyframe };
        let record = TickRecord {
            header: Header {
                epoch: tick.epoch,
                district: district as u16,
                tick: tick.number,
                speed: tick.speed,
                keyframe_offset,
                wall_us: tick.wall_us,
            },
            keyframe: step.keyframe,
            events: tick
                .changed
                .map(|ticks_per_second| Event::Speed { ticks_per_second })
                .into_iter()
                .chain(commanded)
                .chain(step.events)
                .chain(tick.cursor.map(|next| Event::CommandCursor { next }))
                .collect(),
        };
        let bytes = record
            .encode()
            .with_context(|| format!("encode district {district} tick {}", tick.number))?;
        let log = log.clone();
        let marked = if district == 0 { marked.clone() } else { None };
        commits.spawn(async move {
            let attempts = commit_until_written(
                &log,
                district as u16,
                shard.next,
                bytes,
                (keyframe, marked.as_ref()),
                retry,
            )
            .await?;
            Ok::<_, anyhow::Error>((district, keyframe, attempts))
        });
    }
    let mut retries = 0;
    while let Some(done) = commits.join_next().await {
        let (district, keyframe, attempts) = done.context("a commit task stopped")??;
        let shard = &mut shards[district];
        if keyframe {
            shard.keyframe = shard.next;
        }
        shard.next += 1;
        retries += u64::from(attempts - 1);
    }
    Ok(retries)
}

/// Reports a commanded `speed` on the operator's watch, unless the operator
/// set something after the runner last read it: that setting is newer and is
/// applied on the next tick. Returns whether it wrote.
fn publish_speed(
    out: &watch::Sender<u8>,
    control: Option<&mut watch::Receiver<u8>>,
    speed: u8,
) -> bool {
    let Some(control) = control else {
        out.send_replace(speed);
        return true;
    };
    // The check runs under the sender's lock, so no setting slips in after it.
    let wrote = out.send_if_modified(|current| {
        if control.has_changed().unwrap_or(false) {
            return false;
        }
        *current = speed;
        true
    });
    if wrote {
        // Our own write is not a new setting to act on.
        control.borrow_and_update();
    }
    wrote
}

/// The speed the operator's control resumes a paused city at, or never when
/// there is no control.
async fn wait_resumed(control: &mut Option<watch::Receiver<u8>>) -> Result<u8> {
    let Some(control) = control else {
        return std::future::pending().await;
    };
    // Waits for a new setting: a value already there is what a command
    // replaced, not an instruction to resume.
    loop {
        control
            .changed()
            .await
            .context("the speed control was dropped while the city was paused")?;
        let set = *control.borrow_and_update();
        if set != 0 {
            return Ok(set);
        }
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
pub(crate) struct Retry {
    pub(crate) timeout: Duration,
    pub(crate) backoff: Duration,
    pub(crate) max_backoff: Duration,
    pub(crate) max_failures: u32,
    pub(crate) max_permanent: u32,
}

impl Retry {
    pub(crate) fn of(settings: &Settings) -> Self {
        Retry {
            timeout: settings.commit_timeout,
            backoff: settings.backoff,
            max_backoff: settings.max_backoff,
            max_failures: settings.max_failures,
            max_permanent: settings.max_permanent,
        }
    }
}

/// Ticks a district's committer may be behind the stepping, so a slow shard
/// holds the stepping back instead of piling records up in memory.
const WARMUP_AHEAD: usize = 256;

/// What a warm-up commits.
#[derive(Clone, Copy)]
struct WarmUp {
    ticks: u32,
    /// The speed the ticks are stamped as if they had run at.
    speed: u8,
    /// The command stream position the keyframes record.
    cursor: Option<u64>,
}

/// Commits ticks `0..ticks` of a new city without waiting out their periods.
/// Each district has its own committer, one record at a time at the offset the
/// stepping already knows, so the expected-offset fence holds and a district
/// can run ahead of the others by up to [`WARMUP_AHEAD`] ticks. Records are
/// stamped as if the ticks had run at `speed` and ended where this started, so
/// wall time and tick agree for anything that maps one to the other. Returns
/// the commits that had to be sent again.
async fn warm_up<L: Log>(
    name: &str,
    world: &mut World,
    shards: &mut [Shard],
    plan: WarmUp,
    log: &L,
    settings: &Settings,
) -> Result<u64> {
    let WarmUp {
        ticks,
        speed,
        cursor,
    } = plan;
    info!(city = name, ticks, "warming up");
    let began = Instant::now();
    let period_us = 1_000_000 / u64::from(speed);
    let go_live = unix_micros();
    let retry = Retry::of(settings);
    let mut senders = Vec::new();
    let mut committers = JoinSet::new();
    for (district, shard) in shards.iter().enumerate() {
        let (send, mut inbox) = mpsc::channel::<(Vec<u8>, bool)>(WARMUP_AHEAD);
        senders.push(send);
        let (log, mut next) = (log.clone(), shard.next);
        committers.spawn(async move {
            let mut retries = 0u64;
            while let Some((bytes, keyframe)) = inbox.recv().await {
                let attempts = commit_until_written(
                    &log,
                    district as u16,
                    next,
                    bytes,
                    (keyframe, None),
                    retry,
                )
                .await?;
                retries += u64::from(attempts - 1);
                next += 1;
            }
            Ok::<_, anyhow::Error>(retries)
        });
    }
    let mut stopped = false;
    'ticks: for _ in 0..ticks {
        let tick = world.next_tick();
        let wall_us = go_live.saturating_sub(u64::from(ticks - tick) * period_us);
        for (district, step) in world.step().into_iter().enumerate() {
            let shard = &mut shards[district];
            let keyframe = step.keyframe.is_some();
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
                events: step
                    .events
                    .into_iter()
                    .chain(
                        cursor
                            .filter(|_| keyframe)
                            .map(|next| Event::CommandCursor { next }),
                    )
                    .collect(),
            };
            let bytes = record
                .encode()
                .with_context(|| format!("encode district {district} tick {tick}"))?;
            if keyframe {
                shard.keyframe = shard.next;
            }
            shard.next += 1;
            if senders[district].send((bytes, keyframe)).await.is_err() {
                // The committer ended; its error is below.
                stopped = true;
                break 'ticks;
            }
        }
    }
    drop(senders);
    let mut retries = 0u64;
    while let Some(done) = committers.join_next().await {
        retries += done.context("a warm-up commit task stopped")??;
    }
    anyhow::ensure!(!stopped, "a warm-up committer stopped early");
    info!(
        city = name,
        ticks,
        took_ms = began.elapsed().as_millis() as u64,
        retries,
        "warm-up done, going live"
    );
    Ok(retries)
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
    (keyframe, marked): (bool, Option<&Marked>),
    retry: Retry,
) -> Result<u32> {
    let mut wait = retry.backoff;
    let mut failures = 0u32;
    let mut permanent = 0u32;
    for attempt in 1.. {
        let answer = tokio::time::timeout(
            retry.timeout,
            log.commit(district, expected, bytes.clone(), keyframe, marked),
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
                "district {district}: the log is at {tail}, not {expected}; another sim is writing it"
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
