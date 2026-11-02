//! Timeline markers: the builder changes of each city day, for the page's timeline.
//!
//! A day's list is one state key of the events stream, written in district 0's commit of the tick that
//! added to it. That makes the list as durable as the tick, a sim killed between the two cannot leave one
//! without the other, and a tick committed again writes the same list.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use felix_metro_core::TICKS_PER_DAY;
use felix_metro_core::record::{
    Event, MARK_BUILT, MARK_DEMOLISHED, MARK_ROAD, Marker, MarkersRecord, RESULT_APPLIED,
};

/// The most markers kept for one city day. A builder who passes it is not marked past it; the changes
/// still happen and are still in the tick records.
pub const MAX_PER_DAY: usize = 256;

/// A day's markers as they go into a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Marked {
    pub day: u32,
    /// An encoded [`MarkersRecord`].
    pub bytes: Vec<u8>,
}

/// The state key holding a day's markers.
pub fn key(day: u32) -> String {
    format!("markers.{day}")
}

/// The markers a tick's applied commands make, in district order and then the order the commands ran.
/// A change takes the name of the command that made it, which comes first in the same district.
pub(crate) fn from_commands(tick: u32, commanded: &[Vec<Event>]) -> Vec<Marker> {
    let mut out = Vec::new();
    for events in commanded {
        let mut by = String::new();
        let mut applied = false;
        for event in events {
            let (kind, subject, what) = match event {
                Event::Command { name, result, .. } => {
                    by.clone_from(name);
                    applied = *result == RESULT_APPLIED;
                    continue;
                }
                Event::Built { lot, kind, .. } => (MARK_BUILT, *lot, *kind),
                Event::Demolished { lot, kind, .. } => (MARK_DEMOLISHED, *lot, *kind),
                Event::Road { segment, change } => (MARK_ROAD, *segment, u16::from(*change)),
                _ => continue,
            };
            if applied {
                out.push(Marker {
                    tick,
                    kind,
                    subject,
                    what,
                    by: by.clone(),
                });
            }
        }
    }
    out
}

/// The days' markers the sim holds in memory: the days a run can still write to.
#[derive(Default)]
pub(crate) struct Today(BTreeMap<u32, Vec<Marker>>);

impl Today {
    /// Takes day `day`'s list as the log holds it, `None` for a day with nothing stored.
    pub(crate) fn load(&mut self, day: u32, stored: Option<&[u8]>) -> Result<()> {
        let markers = match stored {
            None => Vec::new(),
            Some(bytes) => {
                let record = MarkersRecord::decode(bytes)
                    .with_context(|| format!("decode the markers of day {day}"))?;
                anyhow::ensure!(
                    record.day == day,
                    "the markers stored for day {day} are for day {}",
                    record.day
                );
                record.markers
            }
        };
        self.0.insert(day, markers);
        Ok(())
    }

    /// Records `new`, the markers of `tick`, and returns the list to write. Anything already listed at
    /// `tick` or later is replaced, so a tick run again leaves the list as it was. `None` when there is
    /// nothing new to write: no markers, or a list that came out the same (a full day).
    ///
    /// A day that was not loaded has nothing stored: the run loads every day a restart can find a
    /// value in (see `load_markers` in the runner), and later days are new.
    pub(crate) fn add(&mut self, tick: u32, new: Vec<Marker>) -> Result<Option<Marked>> {
        if new.is_empty() {
            return Ok(None);
        }
        let day = tick / TICKS_PER_DAY;
        let markers = self.0.entry(day).or_default();
        let before = markers.clone();
        markers.retain(|m| m.tick < tick);
        let room = MAX_PER_DAY.saturating_sub(markers.len());
        markers.extend(new.into_iter().take(room));
        if *markers == before {
            return Ok(None);
        }
        let bytes = MarkersRecord {
            day,
            markers: markers.clone(),
        }
        .encode()
        .context("encode the day's markers")?;
        // Older days are never written again.
        self.0.retain(|d, _| *d + 1 >= day);
        Ok(Some(Marked { day, bytes }))
    }
}

#[cfg(test)]
mod tests;
