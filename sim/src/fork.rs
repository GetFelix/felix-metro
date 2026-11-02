//! Forking a city: the rules a `fork` command is checked by, and the copy of
//! the parent's history that becomes the new city's log. The steps around it
//! (making the streams, listing the fork, starting it) are in `fork/make.rs`.
//! See "Branching" in docs/design.md.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result, ensure};
use felix_metro_core::record::{
    Event, REFUSED_FORK_EXISTS, REFUSED_FORK_NAME, REFUSED_FORK_TICK, REFUSED_FORK_TOO_DEEP,
    TickRecord,
};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::resume::retrying;
use crate::runner::{Log, Retry, commit_until_written};

pub mod make;
mod provision;

/// The longest part of a lineage name, a fork's own name.
const NAME_MAX: usize = 32;

/// The longest lineage name: what a registry record, a gateway scope value and
/// a Felix stream name can all carry.
const LINEAGE_MAX: usize = 64;

/// Records read from the parent at a time.
const PAGE: u32 = 500;

/// The name a city has in Felix stream names and at the gateway, which keeps
/// scope values to letters, digits, `-` and `_`. No city name has an `_`, so
/// no two cities share one.
pub fn felix_name(city: &str) -> String {
    city.replace('~', "_")
}

/// The city a lineage name starts from: `harbor` for `harbor~a~b`.
pub fn root_of(city: &str) -> &str {
    city.split('~').next().unwrap_or(city)
}

/// The lineage name of `parent`'s fork called `name`, or the result code that
/// refuses the command.
pub(crate) fn lineage(parent: &str, name: &str) -> Result<String, u8> {
    let valid = (1..=NAME_MAX).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid {
        return Err(REFUSED_FORK_NAME);
    }
    let child = format!("{parent}~{name}");
    if child.len() > LINEAGE_MAX {
        return Err(REFUSED_FORK_TOO_DEEP);
    }
    Ok(child)
}

/// A fork that has been committed to a parent's log and has to be made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub parent: String,
    /// The fork's lineage name.
    pub child: String,
    /// The last tick of the parent the fork keeps.
    pub tick: u32,
    pub principal: u64,
    /// Districts on a side, as the parent has.
    pub side: u16,
}

impl Request {
    /// Districts in the city, one shard each.
    pub(crate) fn districts(&self) -> usize {
        usize::from(self.side) * usize::from(self.side)
    }
}

/// What the cities of one sim share to fork: the names taken, and the way to
/// hand the supervisor a fork to make.
#[derive(Clone, Debug)]
pub struct Forks {
    taken: Arc<Mutex<HashSet<String>>>,
    requests: mpsc::UnboundedSender<Request>,
}

impl Forks {
    /// `taken` is every fork the registry lists. The receiver goes to
    /// [`make::supervise`].
    pub fn new(
        taken: impl IntoIterator<Item = String>,
    ) -> (Forks, mpsc::UnboundedReceiver<Request>) {
        let (requests, receive) = mpsc::unbounded_channel();
        let forks = Forks {
            taken: Arc::new(Mutex::new(taken.into_iter().collect())),
            requests,
        };
        (forks, receive)
    }

    fn taken(&self) -> MutexGuard<'_, HashSet<String>> {
        self.taken
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Decides a `fork` command that `parent`, about to step tick `next`,
    /// read: the fork's lineage name, which is now taken, or the refusal.
    pub(crate) fn decide(
        &self,
        parent: &str,
        next: u32,
        tick: u32,
        name: &str,
    ) -> Result<String, u8> {
        let child = lineage(parent, name)?;
        if tick >= next {
            return Err(REFUSED_FORK_TICK);
        }
        if !self.taken().insert(child.clone()) {
            return Err(REFUSED_FORK_EXISTS);
        }
        Ok(child)
    }

    /// Takes the forks `parent` (with `side` districts a side) logged, as
    /// `(tick, name, principal)`, and hands the supervisor each to make, which
    /// it does once however often it is asked.
    pub(crate) fn resume(&self, parent: &str, side: u16, forked: Vec<(u32, String, u64)>) {
        for (tick, child, principal) in forked {
            self.taken().insert(child.clone());
            let request = Request {
                parent: parent.to_owned(),
                child,
                tick,
                principal,
                side,
            };
            // The receiver only closes when the sim is shutting down.
            let _ = self.requests.send(request);
        }
    }
}

/// The forks a tick's district 0 events record: tick, lineage name, principal.
pub(crate) fn forked_in(events: &[Event]) -> Vec<(u32, String, u64)> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Forked {
                tick,
                name,
                principal,
            } => Some((*tick, name.clone(), *principal)),
            _ => None,
        })
        .collect()
}

/// Copies every district's records `0..=through` from `parent` to `child`.
/// Picks up where an earlier copy stopped, so a repeat finishes the job and a
/// finished copy writes nothing. A record keeps its offset, because every
/// district commits one per tick from tick 0, which keeps `keyframe_offset`
/// true; only the command stream position is rewritten, to the start of the
/// fork's own.
pub(crate) async fn copy_history<L: Log>(
    parent: &L,
    child: &L,
    districts: usize,
    through: u32,
    retry: Retry,
) -> Result<()> {
    let mut copies = JoinSet::new();
    for district in 0..districts {
        let (parent, child) = (parent.clone(), child.clone());
        copies.spawn(async move {
            copy_district(&parent, &child, district as u16, through, retry)
                .await
                .with_context(|| format!("copy district {district}"))
        });
    }
    while let Some(done) = copies.join_next().await {
        done.context("a copy task stopped")??;
    }
    Ok(())
}

async fn copy_district<L: Log>(
    parent: &L,
    child: &L,
    district: u16,
    through: u32,
    retry: Retry,
) -> Result<()> {
    let end = u64::from(through) + 1;
    let mut next = retrying(retry, "find the end of the fork's log", || {
        tail(child, district)
    })
    .await?;
    if next > end {
        return Err(Impossible(format!(
            "the fork's log already holds {next} records, past the fork tick {through}"
        ))
        .into());
    }
    while next < end {
        let want = u32::try_from(end - next).map_or(PAGE, |n| n.min(PAGE));
        let page = retrying(retry, "read the parent's log", || {
            parent.read_from(district, next, want)
        })
        .await?;
        if page.is_empty() {
            return Err(Impossible(format!(
                "the parent's log ends at {next}, before tick {through}"
            ))
            .into());
        }
        for (offset, bytes) in page.into_iter().take_while(|(offset, _)| *offset < end) {
            ensure!(
                offset == next,
                "offset {next} is missing from the parent's log"
            );
            let mut record = TickRecord::decode(&bytes)
                .with_context(|| format!("offset {offset} does not decode"))?;
            ensure!(
                u64::from(record.header.tick) == offset && record.header.district == district,
                "offset {offset} holds tick {} of district {}",
                record.header.tick,
                record.header.district
            );
            for event in &mut record.events {
                if let Event::CommandCursor { next } = event {
                    *next = 0;
                }
            }
            let keyframe = record.keyframe.is_some();
            let bytes = record.encode().context("encode a copied record")?;
            commit_until_written(child, district, next, bytes, keyframe, retry).await?;
            next += 1;
        }
    }
    Ok(())
}

/// The offset the next record of `district` lands at, found by probing, since
/// a log has no tail to ask for.
async fn tail<L: Log>(log: &L, district: u16) -> Result<u64> {
    if log.read(district, 0).await?.is_none() {
        return Ok(0);
    }
    let (mut held, mut gone) = (0u64, 1u64);
    while log.read(district, gone).await?.is_some() {
        held = gone;
        gone = gone.checked_mul(2).context("a log of that length")?;
    }
    while gone - held > 1 {
        let middle = held + (gone - held) / 2;
        if log.read(district, middle).await?.is_some() {
            held = middle;
        } else {
            gone = middle;
        }
    }
    Ok(gone)
}

/// A fork that can never be made, so trying again would only repeat the error.
#[derive(Debug)]
pub(crate) struct Impossible(String);

impl std::fmt::Display for Impossible {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Impossible {}

/// Whether `err` is [`Impossible`].
pub(crate) fn is_final(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<Impossible>())
}

#[cfg(test)]
mod tests;
