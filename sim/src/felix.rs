//! The connection to Felix and the city's event stream on it.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use felix_client::{ClientConfig, ClusterClient, CommitOp, ConditionalWrite};
use tracing::warn;

use crate::commands::{Incoming, commands_stream};
use crate::runner::{Log, Write};

/// How to reach Felix and which tenant to act as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connection {
    /// `host:port` addresses of brokers.
    pub brokers: Vec<String>,
    /// The name the broker's certificate is checked against.
    pub server_name: String,
    /// PEM certificates to trust for the broker; `None` is the platform's store.
    pub ca_file: Option<PathBuf>,
    /// A file holding the sim's Felix token.
    pub token_file: PathBuf,
    pub tenant: String,
    pub namespace: String,
}

/// Connects, retrying until a broker answers: in a fresh deployment the sim
/// can start before the brokers do, or before the broker has written the
/// certificate it is checked against.
pub async fn connect(connection: &Connection) -> Result<ClusterClient> {
    let mut attempt = 0u32;
    loop {
        match try_connect(connection).await {
            Ok(client) => return Ok(client),
            Err(err) => {
                attempt += 1;
                warn!(error = %format!("{err:#}"), attempt, "Felix is not reachable yet");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn try_connect(connection: &Connection) -> Result<ClusterClient> {
    let token = std::fs::read_to_string(&connection.token_file)
        .with_context(|| format!("read {}", connection.token_file.display()))?;
    let roots = connection
        .ca_file
        .as_ref()
        .map(felix_client::root_store_from_pem_file)
        .transpose()?
        .map(Arc::new);
    let mut config =
        ClientConfig::optimized_defaults(felix_client::quic_client_config(roots, true)?);
    config.auth_tenant_id = Some(connection.tenant.clone());
    config.auth_token = Some(token.trim().to_owned());
    let seeds = resolve(&connection.brokers).await?;
    ClusterClient::connect(&seeds, &connection.server_name, config).await
}

async fn resolve(brokers: &[String]) -> Result<Vec<SocketAddr>> {
    let mut addrs = Vec::new();
    for broker in brokers {
        addrs.extend(
            tokio::net::lookup_host(broker)
                .await
                .with_context(|| format!("resolve {broker}"))?,
        );
    }
    Ok(addrs)
}

/// The name of a city's event stream.
pub fn events_stream(city: &str) -> String {
    format!("metro.events.{city}")
}

/// The entity key a district's commits carry. With an explicit shard it only
/// labels the commit; the shard is the district's number.
fn entity_key(district: u16) -> String {
    format!("d{district:02}")
}

/// Whether a stream with `shards` shards has a shard of its own for each of
/// `districts`.
fn ensure_shards(shards: u32, districts: usize) -> Result<()> {
    anyhow::ensure!(
        shards as usize >= districts,
        "the stream has {shards} shards for {districts} districts; a district needs a shard of its own"
    );
    Ok(())
}

/// A city's event stream on a cluster.
#[derive(Clone)]
pub struct FelixLog {
    client: Arc<ClusterClient>,
    tenant: Arc<str>,
    namespace: Arc<str>,
    stream: Arc<str>,
    commands: Arc<str>,
}

impl FelixLog {
    /// The event stream of `city`, which must exist with a shard for each of
    /// its `districts`.
    pub async fn open(
        client: Arc<ClusterClient>,
        connection: &Connection,
        city: &str,
        districts: usize,
    ) -> Result<Self> {
        let stream = events_stream(city);
        let (shards, _) = client
            .client()
            .await
            .stream_routing(&connection.tenant, &connection.namespace, &stream)
            .await
            .with_context(|| format!("ask how {stream} is sharded"))?;
        ensure_shards(shards, districts)?;
        Ok(FelixLog {
            client,
            tenant: connection.tenant.as_str().into(),
            namespace: connection.namespace.as_str().into(),
            stream: stream.into(),
            commands: commands_stream(city).into(),
        })
    }
}

impl Log for FelixLog {
    async fn commit(
        &self,
        district: u16,
        expected: u64,
        record: Vec<u8>,
        keyframe: bool,
    ) -> Result<Write> {
        let mut ops = vec![CommitOp::publish(&*self.stream, record)];
        if keyframe {
            ops.push(CommitOp::put(
                &*self.stream,
                "keyframe",
                expected.to_le_bytes().to_vec(),
            ));
        }
        let written = self
            .client
            .commit_if_on_shard(
                &self.tenant,
                &self.namespace,
                u32::from(district),
                entity_key(district).as_bytes(),
                ops,
                expected,
            )
            .await?;
        Ok(match written {
            ConditionalWrite::Written { .. } => Write::Written,
            ConditionalWrite::Refused { tail } => Write::Refused { tail },
        })
    }

    async fn read(&self, district: u16, offset: u64) -> Result<Option<Vec<u8>>> {
        let page = self
            .client
            .read(
                &self.tenant,
                &self.namespace,
                &self.stream,
                u32::from(district),
                offset,
                None,
                1,
            )
            .await?;
        Ok(page
            .records
            .into_iter()
            .find(|record| record.offset == offset)
            .map(|record| record.payload.to_vec()))
    }

    async fn keyframe(&self, district: u16) -> Result<Option<u64>> {
        let state = self
            .client
            .state_get_on_shard(
                &self.tenant,
                &self.namespace,
                &self.stream,
                u32::from(district),
                "keyframe",
            )
            .await?;
        state
            .value
            .map(|bytes| {
                let bytes: [u8; 8] = bytes[..].try_into().map_err(|_| {
                    anyhow::anyhow!("district {district}'s keyframe state is not an offset")
                })?;
                Ok(u64::from_le_bytes(bytes))
            })
            .transpose()
    }

    async fn read_from(&self, district: u16, offset: u64, max: u32) -> Result<Vec<(u64, Vec<u8>)>> {
        let page = self
            .client
            .read(
                &self.tenant,
                &self.namespace,
                &self.stream,
                u32::from(district),
                offset,
                None,
                max,
            )
            .await?;
        Ok(page
            .records
            .into_iter()
            .map(|record| (record.offset, record.payload.to_vec()))
            .collect())
    }

    async fn commands(&self, from: u64, until: u64) -> Result<Vec<Incoming>> {
        let mut found = Vec::new();
        let mut next = from;
        while next < until {
            let page = self
                .client
                .read(
                    &self.tenant,
                    &self.namespace,
                    &self.commands,
                    0,
                    next,
                    Some(until),
                    0,
                )
                .await?;
            if page.records.is_empty() {
                break;
            }
            for record in &page.records {
                found.extend(Incoming::from_payload(&record.payload, Some(record.offset)));
            }
            next = page.next_offset;
        }
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_district_needs_a_shard_of_its_own() {
        assert!(ensure_shards(4, 4).is_ok());
        assert!(ensure_shards(64, 16).is_ok());
        assert!(ensure_shards(3, 4).is_err());
    }

    #[test]
    fn a_commit_names_its_district() {
        assert_eq!(entity_key(0), "d00");
        assert_eq!(entity_key(13), "d13");
    }
}
