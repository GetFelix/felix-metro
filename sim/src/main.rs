//! The `sim` binary: runs the cities named by `SIM_CITIES`.

mod config;

use std::sync::Arc;

use anyhow::{Context, Result};
use felix_metro_core::City;
use felix_metro_sim::{
    Connection, FelixLog, Settings, StartRequest, announce_later, connect, follow_commands,
    run_city_with, serve_speed_control,
};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::config::{CitySpec, Config};

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

    let mut cities = JoinSet::new();
    let mut controls = std::collections::HashMap::new();
    let mut starts: std::collections::HashMap<String, mpsc::Sender<StartRequest>> =
        std::collections::HashMap::new();
    let all = config
        .cities
        .iter()
        .map(|spec| (spec, None))
        .chain(config.on_demand.iter().map(|spec| {
            let (requests, held) = mpsc::channel(4);
            starts.insert(spec.name.clone(), requests);
            (spec, Some(held))
        }));
    for (spec, held) in all {
        let (control, speed) = watch::channel(config.ticks_per_second);
        controls.insert(spec.name.clone(), control.clone());
        let (client, connection, spec) =
            (Arc::clone(&client), config.connection.clone(), spec.clone());
        let ticks_per_second = config.ticks_per_second;
        cities.spawn(async move {
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
            // A city whose command stream is missing still runs, just without builders.
            let commands = match follow_commands(Arc::clone(&client), &connection, &spec.name).await
            {
                Ok(commands) => Some(commands),
                Err(err) => {
                    error!(city = %spec.name, error = %format!("{err:#}"), "builders cannot reach the city");
                    None
                }
            };
            announce_later(
                Arc::clone(&client),
                connection,
                spec.name.clone(),
                spec.districts_per_side,
            );
            let settings = Settings {
                ticks_per_second,
                speed: Some(speed),
                speed_out: Some(control),
                ..Settings::default()
            };
            run_city_with(&spec.name, city, settings, log, commands)
                .await
                .map(|_| spec.name)
        });
    }
    let listener = tokio::net::TcpListener::bind(config.control_addr)
        .await
        .with_context(|| format!("bind the speed endpoint {}", config.control_addr))?;
    info!(addr = %config.control_addr, "speed endpoint");
    cities.spawn(async move {
        serve_speed_control(listener, controls, starts).await?;
        Ok("the speed endpoint".to_owned())
    });
    // A city's clock only stops on an error, which ends the process: a sim that
    // lost one city would keep committing the others out of step with it.
    if let Some(done) = cities.join_next().await {
        let name = done.context("a city's task panicked")??;
        anyhow::bail!("{name} stopped");
    }
    Ok(())
}

/// The city and its streams, ready to run.
async fn open_city(
    client: &Arc<felix_client::ClusterClient>,
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
