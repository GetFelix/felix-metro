//! The city registry: the `metro.cities` stream every page follows for the list of cities.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use felix_client::{AckMode, ClusterClient};
use felix_metro_core::record::RegistryRecord;
use tracing::{info, warn};

use crate::felix::Connection;

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

/// Writes `name` to the registry. A record that was sent twice because the first answer was lost is
/// harmless: readers list a name once.
pub async fn announce(
    client: &ClusterClient,
    connection: &Connection,
    name: &str,
    districts_per_side: u16,
) -> Result<()> {
    let wall_us = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64);
    let record = created(name, districts_per_side, wall_us)?;
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

#[cfg(test)]
mod tests {
    use felix_metro_core::record::RegistryRecord;

    use super::created;

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
