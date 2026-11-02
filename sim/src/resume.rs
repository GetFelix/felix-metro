//! Starting a city over a log that already holds its history: what is read
//! back, and how it becomes the world and the clock a restart carries on from.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::ops::RangeInclusive;

use anyhow::{Context, Result, bail, ensure};
use felix_metro_core::City;
use felix_metro_core::TICKS_PER_HOUR;
use felix_metro_core::record::{Doing, Event, TickRecord};
use tracing::warn;

use crate::runner::{Log, Retry};
use crate::world::{Departure, World, opening_share};

/// Records before the keyframe a restart first reads, so that a trip that
/// left before it is found. A trip takes minutes of city time; a longer one
/// makes [`read_history`] read further back.
pub(crate) const LOOKBACK: u64 = 4 * TICKS_PER_HOUR as u64;

/// How much further back each read after the first goes.
const LOOKBACK_GROWTH: u64 = 4;

/// Records asked for at a time.
const PAGE: u32 = 1000;

/// Where a district's log ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Tail {
    /// The offset the next record lands at.
    pub(crate) next: u64,
    /// The offset of the newest keyframe, 0 before there is one.
    pub(crate) keyframe: u64,
}

/// What a restart reads back from the log.
///
/// Districts commit a tick one by one, so a sim killed in the middle of one
/// leaves some districts a tick ahead. A warm-up that was killed leaves them
/// further apart. The `level` is the newest tick every district has; the
/// ticks above it are finished by [`History::unfinished`].
pub struct History {
    epoch: u32,
    speed: u8,
    tails: Vec<Tail>,
    /// The tick of the keyframes the world is rebuilt from, or `None` when a
    /// district has no keyframe yet and the world starts from tick 0.
    base: Option<u32>,
    /// The newest tick every district holds, or `None` while one holds none.
    level: Option<u32>,
    top: u32,
    /// Each district's record of a tick; `None` where it has not got that far.
    ticks: BTreeMap<u32, Vec<Option<TickRecord>>>,
    /// The latest `trip` event of each resident up to `base`.
    departures: HashMap<u32, Departure>,
    /// The command stream offset the sim read up to, by the tick that said so.
    cursors: BTreeMap<u32, u64>,
}

/// Reads a city's history, or `None` when no district has committed anything.
pub(crate) async fn read_history<L: Log>(
    log: &L,
    districts: usize,
    retry: Retry,
    lookback: u64,
) -> Result<Option<History>> {
    let mut newest = Vec::with_capacity(districts);
    for district in 0..districts {
        let offset = retrying(retry, "look for the newest keyframe", || {
            log.keyframe(district as u16)
        })
        .await
        .with_context(|| format!("district {district}"))?;
        if offset.is_none() {
            // A district's first record is a keyframe, committed with the state that points at it, so a record
            // with no keyframe is not one this sim wrote.
            let first = retrying(retry, "look for records", || log.read(district as u16, 0))
                .await
                .with_context(|| format!("district {district}"))?;
            ensure!(
                first.is_none(),
                "district {district} holds records but no keyframe; another sim is writing it, or this is not a city this sim started"
            );
        }
        newest.push(offset);
    }
    if newest.iter().all(Option::is_none) {
        return Ok(None);
    }
    // The tick of each district's newest keyframe. Every district keyframes on the same ticks, so the oldest of
    // them is one all of them hold.
    let mut at = vec![None; districts];
    for (district, offset) in newest.iter().enumerate() {
        let Some(offset) = *offset else { continue };
        let bytes = retrying(retry, "read the newest keyframe", || {
            log.read(district as u16, offset)
        })
        .await
        .with_context(|| format!("district {district}"))?
        .with_context(|| {
            format!("district {district}: the newest keyframe, offset {offset}, is not in the log")
        })?;
        let record = decode(district, &bytes)?;
        ensure!(
            record.keyframe.is_some(),
            "district {district}: offset {offset} is the newest keyframe but holds none"
        );
        at[district] = Some(record.header.tick);
    }
    let base = if newest.iter().all(Option::is_some) {
        at.iter().flatten().min().copied()
    } else {
        None
    };

    // A resident on the road at the keyframe is rebuilt from the `trip` event of their departure. If it lies before
    // the lookback, read further back rather than refuse: the city has to come back whatever its trips were.
    let mut lookback = lookback;
    loop {
        let (history, from_start) =
            collect(log, districts, retry, &newest, &at, base, lookback).await?;
        if from_start || history.travellers_without_departure() == 0 {
            return Ok(Some(history));
        }
        warn!(
            lookback,
            "a trip began before the records read, reading further back"
        );
        lookback = lookback.saturating_mul(LOOKBACK_GROWTH).max(LOOKBACK);
    }
}

/// Reads every district from `lookback` records before the keyframe at `base`
/// to its end. The flag is true when that reached the start of every log.
async fn collect<L: Log>(
    log: &L,
    districts: usize,
    retry: Retry,
    newest: &[Option<u64>],
    at: &[Option<u32>],
    base: Option<u32>,
    lookback: u64,
) -> Result<(History, bool)> {
    let mut from_start = true;
    let mut ticks: BTreeMap<u32, Vec<Option<TickRecord>>> = BTreeMap::new();
    let mut tails = Vec::with_capacity(districts);
    for district in 0..districts {
        let Some(keyframe) = newest[district] else {
            tails.push(Tail {
                next: 0,
                keyframe: 0,
            });
            continue;
        };
        let start = match base {
            Some(base) => {
                let behind = u64::from(at[district].unwrap_or(base) - base);
                keyframe
                    .checked_sub(behind)
                    .with_context(|| format!("district {district}: fewer records than ticks since the keyframe at {base}"))?
                    .saturating_sub(lookback)
            }
            None => 0,
        };
        from_start &= start == 0;
        let mut next = start;
        let mut last: Option<u32> = None;
        loop {
            let page = retrying(retry, "read the log", || {
                log.read_from(district as u16, next, PAGE)
            })
            .await
            .with_context(|| format!("district {district} from offset {next}"))?;
            if page.is_empty() {
                break;
            }
            for (offset, bytes) in page {
                ensure!(
                    offset == next,
                    "district {district}: offset {next} is missing from the log"
                );
                let record = decode(district, &bytes)?;
                let tick = record.header.tick;
                match last {
                    Some(last) => ensure!(
                        tick == last + 1,
                        "district {district}: tick {tick} follows tick {last}"
                    ),
                    None if base.is_none() => ensure!(
                        tick == 0,
                        "district {district}: the log starts at tick {tick} and has no keyframe to start from"
                    ),
                    None => {}
                }
                last = Some(tick);
                next += 1;
                ticks.entry(tick).or_insert_with(|| vec![None; districts])[district] = Some(record);
            }
        }
        ensure!(
            last.is_some() && next > keyframe,
            "district {district}: the keyframe at offset {keyframe} is past the end of its log"
        );
        tails.push(Tail { next, keyframe });
    }

    let lasts: Vec<Option<u32>> = (0..districts)
        .map(|d| {
            ticks
                .iter()
                .rev()
                .find(|(_, records)| records[d].is_some())
                .map(|(tick, _)| *tick)
        })
        .collect();
    let top = lasts
        .iter()
        .flatten()
        .max()
        .copied()
        .context("the log holds no record")?;
    let level = if lasts.iter().all(Option::is_some) {
        lasts.iter().flatten().min().copied()
    } else {
        None
    };
    let newest_record = ticks[&top]
        .iter()
        .flatten()
        .next()
        .context("the newest tick has no record")?;
    let (epoch, speed) = (newest_record.header.epoch, newest_record.header.speed);

    let mut departures: HashMap<u32, Departure> = HashMap::new();
    let mut cursors: BTreeMap<u32, u64> = BTreeMap::new();
    for (&tick, records) in &ticks {
        for event in records.iter().flatten().flat_map(|r| &r.events) {
            match event {
                Event::Trip {
                    resident,
                    vehicle,
                    depart,
                    route,
                } if base.is_some_and(|base| tick <= base) => {
                    let newer = departures.get(resident).is_none_or(|d| d.depart < *depart);
                    if newer {
                        departures.insert(
                            *resident,
                            Departure {
                                depart: *depart,
                                vehicle: *vehicle,
                                route: route.clone(),
                                node: None,
                            },
                        );
                    }
                }
                // A replanned trip is the one the vehicle is on from the tick of the event.
                Event::Replan {
                    resident,
                    vehicle,
                    node,
                    route,
                } if base.is_some_and(|base| tick <= base) => {
                    let newer = departures.get(resident).is_none_or(|d| d.depart <= tick);
                    if newer {
                        departures.insert(
                            *resident,
                            Departure {
                                depart: tick,
                                vehicle: *vehicle,
                                route: route.clone(),
                                node: Some(*node),
                            },
                        );
                    }
                }
                Event::CommandCursor { next } => {
                    let said = cursors.insert(tick, *next);
                    ensure!(
                        said.is_none_or(|said| said == *next),
                        "districts disagree about the command stream at tick {tick}"
                    );
                }
                _ => {}
            }
        }
    }
    let history = History {
        epoch,
        speed,
        tails,
        base,
        level,
        top,
        ticks,
        departures,
        cursors,
    };
    Ok((history, from_start))
}

fn decode(district: usize, bytes: &[u8]) -> Result<TickRecord> {
    let record = TickRecord::decode(bytes)
        .with_context(|| format!("district {district}: a record in the log does not decode"))?;
    ensure!(
        usize::from(record.header.district) == district,
        "district {district}'s shard holds a record of district {}",
        record.header.district
    );
    Ok(record)
}

/// Tries `op` until it answers, a few times over: a shard may still be
/// electing a leader when the sim starts.
pub(crate) async fn retrying<T, F, Fut>(retry: Retry, what: &str, mut op: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut wait = retry.backoff;
    let mut failures = 0u32;
    loop {
        match tokio::time::timeout(retry.timeout, op()).await {
            Ok(Ok(found)) => return Ok(found),
            Ok(Err(err)) => {
                failures += 1;
                if failures >= retry.max_failures {
                    return Err(err.context(what.to_owned()));
                }
                warn!(error = %format!("{err:#}"), "could not {what}, trying again");
            }
            Err(_) => {
                failures += 1;
                if failures >= retry.max_failures {
                    bail!("no answer trying to {what}");
                }
            }
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(retry.max_backoff);
    }
}

impl History {
    pub(crate) fn epoch(&self) -> u32 {
        self.epoch
    }

    /// The speed the newest record ran at.
    pub(crate) fn speed(&self) -> u8 {
        self.speed
    }

    /// Residents on the road in the base keyframes whose `trip` event was not read.
    fn travellers_without_departure(&self) -> usize {
        let Some(base) = self.base else { return 0 };
        self.ticks[&base]
            .iter()
            .flatten()
            .filter_map(|r| r.keyframe.as_ref())
            .flat_map(|k| &k.residents)
            .filter(|r| matches!(r.doing, Doing::Trip(_)) && !self.departures.contains_key(&r.id))
            .count()
    }

    pub(crate) fn tails(&self) -> &[Tail] {
        &self.tails
    }

    /// Where the command stream resumes: the offset the newest tick says the
    /// sim read up to. `None` when the log does not say, as one written before
    /// the sim kept the position, which follows the stream's tail.
    pub fn commands_from(&self) -> Option<u64> {
        self.cursor_at(self.top)
    }

    /// The command stream offset in force after `tick`.
    pub(crate) fn cursor_at(&self, tick: u32) -> Option<u64> {
        self.cursors
            .range(..=tick)
            .next_back()
            .map(|(_, next)| *next)
    }

    /// The city as the ticks every district holds left it.
    pub(crate) fn world(&self, city: City) -> Result<World> {
        let mut world = match self.base {
            Some(base) => {
                let frames = self.ticks[&base]
                    .iter()
                    .enumerate()
                    .map(|(district, record)| {
                        record
                            .as_ref()
                            .and_then(|r| r.keyframe.clone())
                            .with_context(|| {
                                format!("district {district} has no keyframe at tick {base}")
                            })
                    })
                    .collect::<Result<Vec<_>>>()?;
                World::restore(city, base, &frames, &self.balances(base), &self.departures)?
            }
            None => World::new(city),
        };
        let Some(level) = self.level else {
            return Ok(world);
        };
        for tick in self.base.map_or(0, |base| base + 1)..=level {
            for (district, record) in self.ticks[&tick].iter().enumerate() {
                for event in record.iter().flat_map(|r| &r.events) {
                    world.apply_logged(district, event);
                }
            }
            world.step();
        }
        Ok(world)
    }

    /// Each district's share of the account at the keyframe tick `base`. A log
    /// from before the account has none, and the city starts it with its
    /// opening funds. A keyframe tick finished by a different sim version can
    /// leave some districts without a balance; they restart at their opening
    /// share.
    fn balances(&self, base: u32) -> Vec<i64> {
        let districts = self.ticks[&base].len();
        self.ticks[&base]
            .iter()
            .enumerate()
            .map(|(district, record)| {
                record
                    .iter()
                    .flat_map(|r| &r.events)
                    .find_map(|e| match e {
                        Event::Balance { amount } => Some(*amount),
                        _ => None,
                    })
                    .unwrap_or_else(|| opening_share(districts, district))
            })
            .collect()
    }

    /// The ticks some district has not committed yet, oldest first.
    pub(crate) fn unfinished(&self) -> RangeInclusive<u32> {
        self.level.map_or(0, |level| level + 1)..=self.top
    }

    /// True if `district` has not committed `tick`.
    pub(crate) fn lacks(&self, district: usize, tick: u32) -> bool {
        self.ticks
            .get(&tick)
            .is_none_or(|records| records[district].is_none())
    }

    /// The speed in the header of `tick`, and whether that tick changed it.
    pub(crate) fn speed_at(&self, tick: u32) -> (u8, bool) {
        let records = self.ticks[&tick].iter().flatten();
        let speed = records
            .clone()
            .next()
            .map_or(self.speed, |r| r.header.speed);
        let changed = records
            .flat_map(|r| &r.events)
            .any(|e| matches!(e, Event::Speed { .. }));
        (speed, changed)
    }

    /// The command stream position `tick` recorded, if it recorded one.
    pub(crate) fn cursor_event(&self, tick: u32) -> Option<u64> {
        self.cursors.get(&tick).copied()
    }

    /// The command stream offsets `tick` applied commands from and to, when it
    /// applied any, which a district that had not committed it needs to
    /// record the same ones.
    pub(crate) fn commands_in(&self, tick: u32) -> Option<(u64, u64)> {
        let to = *self.cursors.get(&tick)?;
        let from = tick
            .checked_sub(1)
            .and_then(|before| self.cursor_at(before));
        if from.is_none() {
            warn!(
                tick,
                "the log does not say where the commands of this tick began"
            );
        }
        Some((from?, to))
    }
}
