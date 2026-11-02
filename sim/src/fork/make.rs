//! Turns a `forked` event that a parent committed into a city: the streams, the
//! copy of the history, the registry record. Every step can be repeated, and
//! the registry record comes last, so a fork exists once it is listed.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use felix_client::ClusterClient;
use felix_metro_core::record::RegistryRecord;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use super::{Forks, Request, copy_history, is_final, provision, root_of};
use crate::felix::{Connection, FelixLog};
use crate::registry;
use crate::runner::{Retry, Settings};

/// The longest wait between tries of a step that failed.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// What it takes to make a fork.
#[derive(Clone)]
pub(crate) struct Maker {
    pub(crate) client: Arc<ClusterClient>,
    pub(crate) connection: Connection,
    /// Where the provisioner listens, `http://host:port`.
    pub(crate) provisioner: String,
}

/// What [`start`] sets up.
pub struct Started {
    /// For the cities, to decide `fork` commands and hand forks over.
    pub forks: Forks,
    /// Every fork the registry lists, as its name and the districts on a side,
    /// oldest first, which the sim runs from the start.
    pub existing: Vec<(String, u16)>,
    /// Forks as they are made and listed, and then are for the sim to run.
    pub ready: mpsc::UnboundedReceiver<Request>,
}

/// Reads the registry and starts making the forks that cities hand over, using
/// the provisioner at `provisioner`. `sides` is the districts on a side of each
/// city the sim runs, by name; a fork has its root's. A root city may have
/// `limit` forks, forks of forks included.
pub async fn start(
    client: Arc<ClusterClient>,
    connection: Connection,
    provisioner: String,
    sides: &HashMap<String, u16>,
    limit: usize,
) -> Result<Started> {
    let listed = registry::list(&client, &connection).await?;
    let existing = existing_forks(&listed, sides);
    let names: HashSet<String> = existing.iter().map(|(name, _)| name.clone()).collect();
    let (forks, requests) = Forks::new(names.iter().cloned(), limit);
    let (ready_send, ready) = mpsc::unbounded_channel();
    let maker = Maker {
        client,
        connection,
        provisioner,
    };
    tokio::spawn(supervise(maker, requests, names, ready_send));
    Ok(Started {
        forks,
        existing,
        ready,
    })
}

/// The forks `listed` holds, once each however many records name them, with
/// the districts on a side of their root. A name listed twice must start one
/// city: two would share a log, and the second would be refused its commits.
pub(super) fn existing_forks(
    listed: &[RegistryRecord],
    sides: &HashMap<String, u16>,
) -> Vec<(String, u16)> {
    let mut created: HashMap<&str, u16> = HashMap::new();
    for record in listed {
        if let RegistryRecord::Created {
            name, districts, ..
        } = record
        {
            created.insert(name, *districts);
        }
    }
    let mut existing: Vec<(String, u16)> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for record in listed {
        let RegistryRecord::Forked { name, .. } = record else {
            continue;
        };
        if !seen.insert(name) {
            continue;
        }
        let root = root_of(name);
        match sides.get(root).or_else(|| created.get(root)) {
            Some(side) => existing.push((name.clone(), *side)),
            None => warn!(fork = %name, "a fork of a city this sim does not know is not run"),
        }
    }
    existing
}

/// Makes each fork that arrives on `requests`, one task apiece, and sends it on
/// `ready` once it is listed. `seen` holds the forks the registry already has,
/// which need nothing. A name that arrives twice is made once.
pub(crate) async fn supervise(
    maker: Maker,
    mut requests: mpsc::UnboundedReceiver<Request>,
    mut seen: HashSet<String>,
    ready: mpsc::UnboundedSender<Request>,
) {
    while let Some(request) = requests.recv().await {
        if !seen.insert(request.child.clone()) {
            continue;
        }
        let (maker, ready) = (maker.clone(), ready.clone());
        tokio::spawn(async move { maker.make(request, ready).await });
    }
}

impl Maker {
    async fn make(&self, request: Request, ready: mpsc::UnboundedSender<Request>) {
        let mut wait = Duration::from_secs(1);
        loop {
            match self.attempt(&request).await {
                Ok(()) => {
                    info!(parent = %request.parent, fork = %request.child, tick = request.tick, "fork made");
                    let _ = ready.send(request);
                    return;
                }
                Err(err) if is_final(&err) => {
                    error!(fork = %request.child, error = %format!("{err:#}"), "this fork cannot be made");
                    return;
                }
                Err(err) => {
                    warn!(fork = %request.child, error = %format!("{err:#}"), "fork not made yet, trying again");
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(MAX_WAIT);
                }
            }
        }
    }

    async fn attempt(&self, request: &Request) -> Result<()> {
        provision::create_streams(&self.provisioner, request).await?;
        let districts = request.districts();
        let (client, connection) = (&self.client, &self.connection);
        let parent = FelixLog::open(Arc::clone(client), connection, &request.parent, districts);
        let parent = parent.await?;
        let child = FelixLog::open(Arc::clone(client), connection, &request.child, districts);
        let child = child.await?;
        let retry = Retry::of(&Settings::default());
        copy_history(&parent, &child, districts, request.tick, retry).await?;
        registry::announce_fork(&self.client, &self.connection, request).await
    }
}
