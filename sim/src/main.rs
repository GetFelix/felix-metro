//! The `sim` binary: runs the cities named by `SIM_CITIES`.

mod config;

use std::sync::Arc;

use anyhow::{Context, Result};
use felix_metro_core::City;
use felix_metro_sim::{FelixLog, Settings, announce, connect, run_city, serve_speed_control};
use tokio::sync::{Notify, watch};
use tokio::task::JoinSet;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::config::Config;

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
    let mut starts = std::collections::HashMap::new();
    let all = config.cities.iter().map(|spec| (spec, None)).chain(
        config
            .on_demand
            .iter()
            .map(|spec| (spec, Some(Arc::new(Notify::new())))),
    );
    for (spec, later) in all {
        let (control, speed) = watch::channel(config.ticks_per_second);
        controls.insert(spec.name.clone(), control);
        if let Some(start) = &later {
            starts.insert(spec.name.clone(), Arc::clone(start));
        }
        let (client, connection, spec) =
            (Arc::clone(&client), config.connection.clone(), spec.clone());
        let ticks_per_second = config.ticks_per_second;
        cities.spawn(async move {
            // A city held back starts when something asks for it, at its first tick like any other.
            if let Some(start) = later {
                start.notified().await;
                info!(city = %spec.name, "city started on request");
            }
            let city = City::generate(&spec.name, spec.districts_per_side)
                .with_context(|| format!("generate {}", spec.name))?;
            let log = FelixLog::open(
                Arc::clone(&client),
                &connection,
                &spec.name,
                city.districts.len(),
            )
            .await?;
            announce(&client, &connection, &spec.name, spec.districts_per_side).await?;
            let settings = Settings {
                ticks_per_second,
                speed: Some(speed),
                ..Settings::default()
            };
            run_city(&spec.name, city, settings, log)
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
