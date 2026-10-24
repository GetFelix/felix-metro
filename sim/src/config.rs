use anyhow::{Context, Result, bail};

use felix_metro_sim::{Connection, check_speed};

/// A city to run: `name` or `name:districts`, where `districts` is how many
/// districts a side has. The name is also the seed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CitySpec {
    pub(crate) name: String,
    pub(crate) districts_per_side: u16,
}

/// Districts on a side when `SIM_CITIES` does not say: the first milestone's 2 by 2.
const DEFAULT_SIDE: u16 = 2;

/// The sim's settings, from `SIM_*` variables.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Config {
    /// `SIM_FELIX_BROKERS` (default `127.0.0.1:5000`), `SIM_FELIX_SERVER_NAME`
    /// (`localhost`), `SIM_FELIX_CA_FILE` (the platform's trust store),
    /// `SIM_FELIX_TOKEN_FILE` (required), `SIM_TENANT` (`metro`) and
    /// `SIM_NAMESPACE` (`default`).
    pub(crate) connection: Connection,
    /// `SIM_CITIES`: comma or space separated `name[:districts]`.
    pub(crate) cities: Vec<CitySpec>,
    /// `SIM_ON_DEMAND`: cities whose streams exist but that stay idle, and
    /// unlisted, until `POST /cities/<name>/start` on the speed endpoint. Same
    /// format as `SIM_CITIES`; none by default.
    pub(crate) on_demand: Vec<CitySpec>,
    /// `SIM_TICKS_PER_SECOND`: the city's speed at start, 0 (paused), 4, 8 or
    /// 16. Default 4.
    pub(crate) ticks_per_second: u8,
    /// `SIM_CONTROL_ADDR`: where the speed endpoint listens. Default
    /// `127.0.0.1:8090`; it has no authentication, so only loopback is accepted.
    pub(crate) control_addr: std::net::SocketAddr,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
    }

    fn from_lookup(var: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let list = |value: String| -> Vec<String> {
            value
                .split([',', ' '])
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        };
        let brokers = list(var("SIM_FELIX_BROKERS").unwrap_or_else(|| "127.0.0.1:5000".into()));
        let cities = parse_cities(
            "SIM_CITIES",
            list(var("SIM_CITIES").context("SIM_CITIES is required")?),
        )?;
        if cities.is_empty() {
            bail!("SIM_CITIES names no city");
        }
        let on_demand = parse_cities(
            "SIM_ON_DEMAND",
            var("SIM_ON_DEMAND").map(list).unwrap_or_default(),
        )?;
        if let Some(twice) = on_demand
            .iter()
            .find(|c| cities.iter().any(|d| d.name == c.name))
        {
            bail!("SIM_ON_DEMAND: {} is also in SIM_CITIES", twice.name);
        }
        let ticks_per_second = match var("SIM_TICKS_PER_SECOND") {
            Some(value) => value
                .trim()
                .parse()
                .ok()
                .and_then(|n| check_speed(n).ok())
                .with_context(|| format!("SIM_TICKS_PER_SECOND: {value:?} is not 0, 4, 8 or 16"))?,
            None => 4,
        };
        let control_addr = match var("SIM_CONTROL_ADDR") {
            Some(value) => value
                .trim()
                .parse::<std::net::SocketAddr>()
                .ok()
                .filter(|a| a.ip().is_loopback())
                .with_context(|| {
                    format!("SIM_CONTROL_ADDR: {value:?} is not a loopback host:port")
                })?,
            None => std::net::SocketAddr::from(([127, 0, 0, 1], 8090)),
        };
        Ok(Self {
            connection: Connection {
                brokers,
                server_name: var("SIM_FELIX_SERVER_NAME").unwrap_or_else(|| "localhost".into()),
                ca_file: var("SIM_FELIX_CA_FILE").map(Into::into),
                token_file: var("SIM_FELIX_TOKEN_FILE")
                    .context("SIM_FELIX_TOKEN_FILE is required")?
                    .into(),
                tenant: var("SIM_TENANT").unwrap_or_else(|| "metro".into()),
                namespace: var("SIM_NAMESPACE").unwrap_or_else(|| "default".into()),
            },
            cities,
            on_demand,
            ticks_per_second,
            control_addr,
        })
    }
}

/// `name[:districts]` items, from the variable `var`.
fn parse_cities(var: &str, items: Vec<String>) -> Result<Vec<CitySpec>> {
    let mut cities = Vec::new();
    for item in items {
        let (name, side) = match item.split_once(':') {
            Some((name, side)) => (name, Some(side)),
            None => (item.as_str(), None),
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            bail!("{var}: {name:?} may use only letters, digits, '-' and '_'");
        }
        let districts_per_side = match side {
            Some(side) => side
                .parse()
                .ok()
                .filter(|n| *n > 0)
                .with_context(|| format!("{var}: {side:?} is not a district count"))?,
            None => DEFAULT_SIDE,
        };
        cities.push(CitySpec {
            name: name.to_owned(),
            districts_per_side,
        });
    }
    Ok(cities)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{CitySpec, Config};

    fn config(vars: &[(&str, &str)]) -> anyhow::Result<Config> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    fn city(name: &str, side: u16) -> CitySpec {
        CitySpec {
            name: name.into(),
            districts_per_side: side,
        }
    }

    #[test]
    fn defaults() {
        let config = config(&[
            ("SIM_CITIES", "harbor, pinecrest:4"),
            ("SIM_FELIX_TOKEN_FILE", "/t"),
        ])
        .unwrap();
        assert_eq!(config.cities, [city("harbor", 2), city("pinecrest", 4)]);
        assert_eq!(config.connection.brokers, ["127.0.0.1:5000"]);
        assert_eq!(config.connection.server_name, "localhost");
        assert_eq!(config.connection.tenant, "metro");
        assert_eq!(config.connection.namespace, "default");
        assert_eq!(config.connection.ca_file, None);
        assert_eq!(config.ticks_per_second, 4);
        assert_eq!(config.control_addr, "127.0.0.1:8090".parse().unwrap());
    }

    #[test]
    fn a_city_may_start_paused() {
        let config = config(&[
            ("SIM_CITIES", "a"),
            ("SIM_FELIX_TOKEN_FILE", "/t"),
            ("SIM_TICKS_PER_SECOND", "0"),
        ])
        .unwrap();
        assert_eq!(config.ticks_per_second, 0);
    }

    #[test]
    fn requires_cities_and_a_token() {
        assert!(config(&[("SIM_FELIX_TOKEN_FILE", "/t")]).is_err());
        assert!(config(&[("SIM_CITIES", ","), ("SIM_FELIX_TOKEN_FILE", "/t")]).is_err());
        assert!(config(&[("SIM_CITIES", "a")]).is_err());
    }

    #[test]
    fn cities_held_back_are_listed_apart_from_the_ones_that_run() {
        let config = config(&[
            ("SIM_CITIES", "harbor"),
            ("SIM_ON_DEMAND", "lakeside:3 dunes"),
            ("SIM_FELIX_TOKEN_FILE", "/t"),
        ])
        .unwrap();
        assert_eq!(config.cities, [city("harbor", 2)]);
        assert_eq!(config.on_demand, [city("lakeside", 3), city("dunes", 2)]);
    }

    #[test]
    fn refuses_what_would_change_a_stream_name_or_the_speed() {
        for (name, value) in [
            ("SIM_CITIES", "a.b"),
            ("SIM_CITIES", "a:0"),
            ("SIM_CITIES", "a:x"),
            ("SIM_ON_DEMAND", "a"),
            ("SIM_ON_DEMAND", "b:0"),
            ("SIM_TICKS_PER_SECOND", "1"),
            ("SIM_TICKS_PER_SECOND", "12"),
            ("SIM_TICKS_PER_SECOND", "256"),
            ("SIM_CONTROL_ADDR", "0.0.0.0:8090"),
            ("SIM_CONTROL_ADDR", "8090"),
        ] {
            let mut vars = vec![("SIM_CITIES", "a"), ("SIM_FELIX_TOKEN_FILE", "/t")];
            // A later entry replaces an earlier one with the same name.
            vars.push((name, value));
            assert!(config(&vars).is_err(), "{name}={value}");
        }
    }
}
