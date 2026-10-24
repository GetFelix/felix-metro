//! The connection to Felix and the city's event stream on it.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use felix_client::{ClientConfig, ClusterClient, CommitOp, ConditionalWrite};
use felix_metro_core::{Routing, district_key};
use felix_wire::routing::ShardRouting;
use tracing::warn;

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

/// Entity keys that put district `i` on shard `i` of a stream with `shards`
/// shards mapped by `routing`. See [`felix_metro_core::keys`].
pub fn district_keys(shards: u32, routing: ShardRouting, districts: usize) -> Result<Vec<String>> {
    anyhow::ensure!(
        shards as usize >= districts,
        "the stream has {shards} shards for {districts} districts; a district needs a shard of its own"
    );
    let routing = match routing {
        ShardRouting::Modulo => Routing::Modulo,
        ShardRouting::JumpHash => Routing::JumpHash,
    };
    (0..districts)
        .map(|district| {
            district_key(district as u32, shards, routing)
                .with_context(|| format!("no entity key routes district {district} to its shard"))
        })
        .collect()
}

/// A city's event stream on a cluster.
#[derive(Clone)]
pub struct FelixLog {
    client: Arc<ClusterClient>,
    tenant: Arc<str>,
    namespace: Arc<str>,
    stream: Arc<str>,
    keys: Arc<[String]>,
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
        let (shards, routing) = client
            .client()
            .await
            .stream_routing(&connection.tenant, &connection.namespace, &stream)
            .await
            .with_context(|| format!("ask how {stream} is sharded"))?;
        let keys = district_keys(shards, routing, districts)?;
        Ok(FelixLog {
            client,
            tenant: connection.tenant.as_str().into(),
            namespace: connection.namespace.as_str().into(),
            stream: stream.into(),
            keys: keys.into(),
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
        let key = &self.keys[usize::from(district)];
        let written = self
            .client
            .commit_if(&self.tenant, &self.namespace, key.as_bytes(), ops, expected)
            .await?;
        Ok(match written {
            ConditionalWrite::Written { .. } => Write::Written,
            ConditionalWrite::Refused { tail } => Write::Refused { tail },
        })
    }

    async fn read(&self, district: u16, offset: u64) -> Result<Option<Vec<u8>>> {
        // The district's keys put it on the shard of its own number.
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
}

#[cfg(test)]
mod tests {
    use felix_wire::routing::shard_for_routing;

    use super::*;

    const MODES: [ShardRouting; 2] = [ShardRouting::Modulo, ShardRouting::JumpHash];

    #[test]
    fn each_district_gets_the_shard_of_its_number_under_felixs_own_hash() {
        for routing in MODES {
            for (shards, districts) in [(4, 4), (16, 16), (64, 16), (5, 3)] {
                let keys = district_keys(shards, routing, districts).unwrap();
                for (district, key) in keys.iter().enumerate() {
                    assert!(key.starts_with(&format!("d{district:02}")));
                    let shard = shard_for_routing(routing, shards, Some(key.as_bytes()));
                    assert_eq!(shard as usize, district, "{routing:?} {key}");
                }
            }
        }
    }

    #[test]
    fn core_hashes_like_felix() {
        for (mode, routing) in [
            (ShardRouting::Modulo, Routing::Modulo),
            (ShardRouting::JumpHash, Routing::JumpHash),
        ] {
            for shards in [1, 2, 3, 7, 16, 64] {
                for n in 0..500 {
                    let key = format!("d{n:02}.{n}");
                    assert_eq!(
                        felix_metro_core::keys::shard_for(routing, shards, key.as_bytes()),
                        shard_for_routing(mode, shards, Some(key.as_bytes())),
                    );
                }
            }
        }
    }

    #[test]
    fn plain_keys_collide_and_are_salted() {
        // Hashing d00 to d03 over four shards puts two districts on one.
        for routing in MODES {
            let keys = district_keys(4, routing, 4).unwrap();
            assert!(keys.iter().any(|k| k.contains('.')), "{routing:?}");
        }
    }

    #[test]
    fn refuses_fewer_shards_than_districts() {
        assert!(district_keys(3, ShardRouting::Modulo, 4).is_err());
    }
}
