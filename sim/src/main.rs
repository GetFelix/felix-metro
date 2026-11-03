//! The `sim` binary: runs the cities named by `SIM_CITIES`.

mod config;

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use felix_client::ClusterClient;
use felix_metro_core::City;
use felix_metro_sim::{
    Connection, Directory, FelixLog, ForkRequest, Forks, Settings, StartRequest, announce_later,
    connect, follow_commands, load_history, run_with_history, serve_directory, start_forks,
};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::config::{CitySpec, Config};

/// What every city task of the sim shares.
#[derive(Clone)]
struct Shared {
    client: Arc<ClusterClient>,
    connection: Connection,
    ticks_per_second: u8,
    warmup_ticks: u32,
    /// Set when the sim can carry out `fork` commands.
    forks: Option<Forks>,
    directory: Arc<Directory>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
        .init();

    let config = Config::from_env()?;
    let client = Arc::new(connect(&config.connection).await?);
    info!(
        tenant = %config.connection.tenant,
        cities = %config.cities.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(","),
        "connected to Felix"
    );

    let warmup_ticks = config.warmup_hours * felix_metro_core::TICKS_PER_HOUR;
    let mut starts: HashMap<String, mpsc::Sender<StartRequest>> = HashMap::new();
    let mut held: HashMap<String, mpsc::Receiver<StartRequest>> = HashMap::new();
    for spec in &config.on_demand {
        let (requests, receive) = mpsc::channel(4);
        starts.insert(spec.name.clone(), requests);
        held.insert(spec.name.clone(), receive);
    }
    let directory = Directory::new(HashMap::new(), starts, HashMap::new());

    // Forks the registry lists run again, and the cities can make new ones.
    let mut forking = None;
    if let Some(provisioner) = config.fork_provision_url.clone() {
        let sides = config
            .cities
            .iter()
            .chain(&config.on_demand)
            .map(|spec| (spec.name.clone(), spec.districts_per_side))
            .collect();
        forking = Some(
            start_forks(
                Arc::clone(&client),
                config.connection.clone(),
                provisioner,
                &sides,
                config.max_forks,
            )
            .await?,
        );
    }
    let shared = Shared {
        client: Arc::clone(&client),
        connection: config.connection.clone(),
        ticks_per_second: config.ticks_per_second,
        warmup_ticks,
        forks: forking.as_ref().map(|started| started.forks.clone()),
        directory: Arc::clone(&directory),
    };

    let mut cities = JoinSet::new();
    for spec in &config.cities {
        spawn_city(
            &mut cities,
            &shared,
            spec.clone(),
            None,
            warmup_ticks > 0
                && felix_metro_core::chapter_for(&spec.name).is_none()
                && felix_metro_core::investigation_for(&spec.name).is_none(),
            true,
        );
    }
    for spec in &config.on_demand {
        let requests = held.remove(&spec.name);
        spawn_city(&mut cities, &shared, spec.clone(), requests, false, true);
    }
    let mut made = None;
    if let Some(started) = forking {
        for (name, districts_per_side) in started.existing {
            let spec = CitySpec {
                name,
                districts_per_side,
            };
            spawn_city(&mut cities, &shared, spec, None, false, false);
        }
        made = Some(started.ready);
    }
    let listener = tokio::net::TcpListener::bind(config.control_addr)
        .await
        .with_context(|| format!("bind the speed endpoint {}", config.control_addr))?;
    info!(addr = %config.control_addr, "speed endpoint");
    cities.spawn(async move {
        serve_directory(listener, directory).await?;
        Ok("the speed endpoint".to_owned())
    });
    // A city's clock only stops on an error, which ends the process: a sim that
    // lost one city would keep committing the others out of step with it.
    loop {
        tokio::select! {
            done = cities.join_next() => {
                let Some(done) = done else { return Ok(()) };
                let name = done.context("a city's task panicked")??;
                anyhow::bail!("{name} stopped");
            }
            fork = next_made(&mut made) => {
                let Some(ForkRequest { child, side, .. }) = fork else {
                    made = None;
                    continue;
                };
                let spec = CitySpec { name: child, districts_per_side: side };
                spawn_city(&mut cities, &shared, spec, None, false, false);
            }
        }
    }
}

/// The next fork that was made, or never when the sim does not fork.
async fn next_made(made: &mut Option<mpsc::UnboundedReceiver<ForkRequest>>) -> Option<ForkRequest> {
    match made {
        Some(made) => made.recv().await,
        None => std::future::pending().await,
    }
}

/// Starts the task that runs `spec`. `requests` holds a city back until
/// something asks for it. `warming` is whether a new city's warm-up is to be
/// reported, and `list` whether the city is written to the registry once live;
/// a fork is listed before it runs.
fn spawn_city(
    cities: &mut JoinSet<Result<String>>,
    shared: &Shared,
    spec: CitySpec,
    requests: Option<mpsc::Receiver<StartRequest>>,
    warming: bool,
    list: bool,
) {
    let (control, speed) = watch::channel(shared.ticks_per_second);
    let (warming, warming_seen) = watch::channel(warming);
    shared
        .directory
        .add(&spec.name, control.clone(), warming_seen);
    cities.spawn(run_city(
        shared.clone(),
        spec,
        requests,
        (control, speed, warming),
        list,
    ));
}

async fn run_city(
    shared: Shared,
    spec: CitySpec,
    held: Option<mpsc::Receiver<StartRequest>>,
    (control, speed, warming): (watch::Sender<u8>, watch::Receiver<u8>, watch::Sender<bool>),
    list: bool,
) -> Result<String> {
    let Shared {
        client,
        connection,
        ticks_per_second,
        warmup_ticks,
        forks,
        ..
    } = shared;
    // A chapter's clock starts when the city does, so it has no day and a half of history behind it. A case
    // file's day is the one the player watches, so it starts at tick 0 too.
    let warmup_ticks = if felix_metro_core::chapter_for(&spec.name).is_some()
        || felix_metro_core::investigation_for(&spec.name).is_some()
    {
        0
    } else {
        warmup_ticks
    };
    // A city held back starts when something asks for it, at its first tick like any other. One whose
    // streams will not open fails that request and waits to be asked again.
    let (city, log) = match held {
        None => open_city(&client, &connection, &spec).await?,
        Some(mut requests) => loop {
            let Some(reply) = requests.recv().await else {
                return Ok(spec.name);
            };
            match open_city(&client, &connection, &spec).await {
                Ok(opened) => {
                    info!(city = %spec.name, "city started on request");
                    let _ = reply.send(Ok(()));
                    break opened;
                }
                Err(err) => {
                    let why = format!("{err:#}");
                    error!(city = %spec.name, error = %why, "city could not start");
                    let _ = reply.send(Err(why));
                }
            }
        },
    };
    let settings = Settings {
        warmup_ticks,
        warming: Some(warming.clone()),
        ticks_per_second,
        speed: Some(speed),
        speed_out: Some(control),
        forks,
        ..Settings::default()
    };
    // A city with history carries on from it, and its commands from where the sim last read them. A new
    // one reads its command stream from the start.
    let history = load_history(&log, city.districts.len(), &settings).await?;
    let from = match &history {
        Some(history) => history.commands_from(),
        None => Some(0),
    };
    let commands = follow_commands(
        Arc::clone(&client),
        connection.clone(),
        spec.name.clone(),
        from,
    );
    if warmup_ticks > 0 && history.is_none() {
        warming.send_replace(true);
    }
    if list {
        // Listed once the districts are level in the log, not while warm-up has them apart.
        let mut warmed = warming.subscribe();
        let (listed, name, side) = (
            Arc::clone(&client),
            spec.name.clone(),
            spec.districts_per_side,
        );
        tokio::spawn(async move {
            if warmed.wait_for(|warming| !*warming).await.is_ok() {
                announce_later(listed, connection, name, side);
            }
        });
    }
    run_with_history(&spec.name, city, settings, log, Some(commands), history)
        .await
        .map(|_| spec.name)
}

/// The city and its streams, ready to run.
async fn open_city(
    client: &Arc<ClusterClient>,
    connection: &Connection,
    spec: &CitySpec,
) -> Result<(City, FelixLog)> {
    let city = City::generate(&spec.name, spec.districts_per_side)
        .with_context(|| format!("generate {}", spec.name))?;
    let log = FelixLog::open(
        Arc::clone(client),
        connection,
        &spec.name,
        city.districts.len(),
    )
    .await?;
    Ok((city, log))
}
