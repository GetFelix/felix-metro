//! The `sim` binary: runs the cities named by `SIM_CITIES`.

mod config;

use std::sync::Arc;

use anyhow::{Context, Result};
use felix_metro_core::City;
use felix_metro_sim::{FelixLog, Settings, connect, run_city};
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
    for spec in &config.cities {
        let city = City::generate(&spec.name, spec.districts_per_side)
            .with_context(|| format!("generate {}", spec.name))?;
        let log = FelixLog::open(
            Arc::clone(&client),
            &config.connection,
            &spec.name,
            city.districts.len(),
        )
        .await?;
        let settings = Settings {
            ticks_per_second: config.ticks_per_second,
            ..Settings::default()
        };
        let name = spec.name.clone();
        cities.spawn(async move { run_city(&name, city, settings, log).await.map(|_| name) });
    }
    // A city's clock only stops on an error, which ends the process: a sim that
    // lost one city would keep committing the others out of step with it.
    if let Some(done) = cities.join_next().await {
        let name = done.context("a city's task panicked")??;
        anyhow::bail!("{name} stopped");
    }
    Ok(())
}
