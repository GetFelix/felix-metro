//! Builders' commands: read from the city's command stream, applied to the
//! world between ticks, and recorded as `command` events.

use std::sync::Arc;

use anyhow::{Context, Result};
use felix_client::ClusterClient;
use felix_metro_core::record::{
    Command, CommandRecord, Event, REFUSED_BAD_SPEED, REFUSED_MALFORMED, REFUSED_UNSUPPORTED,
    RESULT_APPLIED, principal_hash, split_stamp,
};
use tokio::sync::mpsc;
use tracing::warn;

use crate::control::check_speed;
use crate::felix::Connection;
use crate::world::World;

/// Commands applied in one tick. The rest wait for the next, so a flood of
/// them cannot make a tick's record too big to commit.
pub(crate) const MAX_PER_TICK: usize = 256;

/// A command as it came off the stream, with who sent it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Incoming {
    /// [`principal_hash`] of the gateway's stamp.
    pub principal: u64,
    /// `None` when the bytes after the stamp are not a command record.
    pub command: Option<CommandRecord>,
}

impl Incoming {
    /// Reads a payload the gateway stamped. `None` when the stamp itself is
    /// missing: the stream only takes publishes through the gateway, so there
    /// is nobody to attribute it to.
    pub fn from_payload(payload: &[u8]) -> Option<Incoming> {
        let (principal, record) = split_stamp(payload)?;
        Some(Incoming {
            principal: principal_hash(principal),
            command: CommandRecord::decode(record).ok(),
        })
    }

    /// Whether this is a `speed` command that would start a paused city.
    pub(crate) fn resumes(&self) -> bool {
        matches!(
            &self.command,
            Some(CommandRecord { command: Command::Speed { ticks_per_second }, .. })
                if *ticks_per_second != 0 && check_speed(*ticks_per_second).is_ok()
        )
    }
}

/// The name of a city's command stream.
pub fn commands_stream(city: &str) -> String {
    format!("metro.commands.{city}")
}

/// Follows a city's command stream from its tail, so a restart does not run
/// what was asked while the sim was down. Commands arrive on the channel in
/// stream order.
pub async fn follow(
    client: Arc<ClusterClient>,
    connection: &Connection,
    city: &str,
) -> Result<mpsc::Receiver<Incoming>> {
    let stream = commands_stream(city);
    let mut subscription = client
        .subscribe_shard(&connection.tenant, &connection.namespace, &stream, 0, None)
        .await
        .with_context(|| format!("follow {stream}"))?;
    let (send, receive) = mpsc::channel(1024);
    let city = city.to_owned();
    tokio::spawn(async move {
        loop {
            match subscription.next_event().await {
                Ok(Some(event)) => {
                    let Some(incoming) = Incoming::from_payload(&event.payload) else {
                        warn!(city, "dropped a command with no sender stamp");
                        continue;
                    };
                    if send.send(incoming).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    warn!(city, "the command stream closed");
                    return;
                }
                Err(err) => {
                    warn!(city, error = %format!("{err:#}"), "the command stream is unreachable");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    });
    Ok(receive)
}

/// Applies `incoming` in order and returns, for each district, the `command`
/// events and the changes they made. A `speed` command moves `wanted`; the
/// runner turns that into the tick's speed change.
pub(crate) fn apply_all(
    world: &mut World,
    incoming: Vec<Incoming>,
    wanted: &mut u8,
) -> Vec<Vec<Event>> {
    let mut out: Vec<Vec<Event>> = (0..world.districts()).map(|_| Vec::new()).collect();
    for item in incoming {
        let (district, result, changes, name, id) = match item.command {
            None => (0, REFUSED_MALFORMED, Vec::new(), String::new(), 0),
            Some(CommandRecord { id, name, command }) => match command {
                Command::Speed { ticks_per_second } => match check_speed(ticks_per_second) {
                    Ok(_) => {
                        *wanted = ticks_per_second;
                        (0, RESULT_APPLIED, Vec::new(), name, id)
                    }
                    Err(_) => (0, REFUSED_BAD_SPEED, Vec::new(), name, id),
                },
                // Branching a city is not built yet.
                Command::Fork { .. } => (0, REFUSED_UNSUPPORTED, Vec::new(), name, id),
                other => {
                    let applied = world.apply(&other);
                    (applied.district, applied.result, applied.events, name, id)
                }
            },
        };
        let events = &mut out[usize::from(district)];
        events.push(Event::Command {
            principal: item.principal,
            name,
            id,
            result,
        });
        events.extend(changes);
    }
    out
}

#[cfg(test)]
pub(crate) mod tests;
