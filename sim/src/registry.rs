//! The city registry: the `metro.cities` stream every page follows for the list of cities.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use felix_client::{AckMode, Client};
use felix_metro_core::record::RegistryRecord;
use tracing::{info, warn};

use crate::felix::Connection;
use crate::fork::Request;

/// The registry's stream: one shard, kept for good.
pub const REGISTRY_STREAM: &str = "metro.cities";

/// Sends of a record to try before giving up.
const ATTEMPTS: u32 = 30;

/// The `created` record of a city: its name is its seed, and `districts_per_side` is the size
/// `City::generate` takes.
fn created(name: &str, districts_per_side: u16, wall_us: u64) -> Result<Vec<u8>> {
    RegistryRecord::Created {
        name: name.to_owned(),
        seed: name.to_owned(),
        districts: districts_per_side,
        wall_us,
    }
    .encode()
    .with_context(|| format!("encode the registry record of {name}"))
}

fn wall_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

/// Writes `name` to the registry. A record that was sent twice because the first answer was lost is
/// harmless: readers list a name once.
pub async fn announce(
    client: &Client,
    connection: &Connection,
    name: &str,
    districts_per_side: u16,
) -> Result<()> {
    let record = created(name, districts_per_side, wall_us())?;
    send(client, connection, name, record).await
}

/// Lists a fork, once its streams hold the history it was made from.
pub(crate) async fn announce_fork(
    client: &Client,
    connection: &Connection,
    fork: &Request,
) -> Result<()> {
    let record = RegistryRecord::Forked {
        name: fork.child.clone(),
        parent: fork.parent.clone(),
        tick: fork.tick,
        wall_us: wall_us(),
        principal: fork.principal,
    }
    .encode()
    .with_context(|| format!("encode the registry record of {}", fork.child))?;
    send(client, connection, &fork.child, record).await
}

async fn send(client: &Client, connection: &Connection, name: &str, record: Vec<u8>) -> Result<()> {
    for attempt in 1..=ATTEMPTS {
        // A plain publish: the registry needs no atomic commit, which the fleet may not have enabled yet.
        match client
            .publish(
                &connection.tenant,
                &connection.namespace,
                REGISTRY_STREAM,
                record.clone(),
                AckMode::PerMessage,
            )
            .await
        {
            Ok(_) => {
                info!(city = name, "listed in the registry");
                return Ok(());
            }
            Err(err) if attempt < ATTEMPTS => {
                warn!(city = name, error = %format!("{err:#}"), attempt, "registry write failed");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(err) => return Err(err).context("write to the registry"),
        }
    }
    unreachable!("the last attempt returns")
}

/// Every record of the registry, oldest first.
pub async fn list(client: &Client, connection: &Connection) -> Result<Vec<RegistryRecord>> {
    let mut found = Vec::new();
    let mut next = 0;
    loop {
        let page = client
            .read(
                &connection.tenant,
                &connection.namespace,
                REGISTRY_STREAM,
                0,
                next,
                None,
                1000,
            )
            .await
            .context("read the registry")?;
        if page.records.is_empty() {
            return Ok(found);
        }
        for record in &page.records {
            match RegistryRecord::decode(&record.payload) {
                Ok(record) => found.push(record),
                Err(err) => warn!(error = %err, "skipped a registry record that does not decode"),
            }
            next = record.offset + 1;
        }
    }
}

/// How long to wait before announcing again once a round of attempts has failed.
const RETRY_AFTER: Duration = Duration::from_secs(30);

/// Announces `name` in the background until it is listed. A city that runs without a registry entry is only missing
/// from the picker, which is no reason to stop it.
pub fn announce_later(
    client: Arc<Client>,
    connection: Connection,
    name: String,
    districts_per_side: u16,
) {
    tokio::spawn(async move {
        until_listed(&name, RETRY_AFTER, || {
            announce(&client, &connection, &name, districts_per_side)
        })
        .await;
    });
}

async fn until_listed<F, Fut>(name: &str, pause: Duration, mut announce: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    while let Err(err) = announce().await {
        warn!(city = name, error = %format!("{err:#}"), "not listed in the registry, trying again");
        tokio::time::sleep(pause).await;
    }
}

#[cfg(test)]
mod tests {
    use felix_metro_core::record::RegistryRecord;

    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    use super::{created, until_listed};

    #[tokio::test(start_paused = true)]
    async fn a_failed_announce_is_tried_again_until_it_works() {
        let tries = AtomicU32::new(0);
        until_listed("lakeside", Duration::from_secs(30), || async {
            if tries.fetch_add(1, Ordering::SeqCst) < 2 {
                anyhow::bail!("broker not ready");
            }
            Ok(())
        })
        .await;
        assert_eq!(tries.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn the_record_names_the_city_its_seed_and_its_size() {
        let bytes = created("lakeside", 3, 42).unwrap();
        assert_eq!(
            RegistryRecord::decode(&bytes).unwrap(),
            RegistryRecord::Created {
                name: "lakeside".into(),
                seed: "lakeside".into(),
                districts: 3,
                wall_us: 42,
            }
        );
    }
}
