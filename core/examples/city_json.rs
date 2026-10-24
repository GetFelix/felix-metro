//! Prints a city as the JSON the browser draws, plus the lots residents go to,
//! for scripts that need to know what a builder may change.
//!
//! `cargo run -q -p felix-metro-core --example city_json -- pinecrest 4` prints
//! `pinecrest` at 4 by 4 districts. The layout is `City::to_json`'s with an
//! `inUse` array of lot ids added, worked out the way the sim's `World::new`
//! does: the lots in any resident's schedule, which a build or demolish refuses.

use std::collections::BTreeSet;

use felix_metro_core::{City, Places, Resident};

fn main() {
    let mut args = std::env::args().skip(1);
    let seed = args.next().unwrap_or_else(|| "harbor".into());
    let d: u16 = args.next().and_then(|a| a.parse().ok()).unwrap_or(2);
    let city = City::generate(&seed, d).expect("a valid seed and district count");
    let places = Places::new(&city);
    let in_use: BTreeSet<u32> = (0..places.population())
        .filter_map(|index| Resident::new(&city, &places, index))
        .flat_map(|r| r.schedule.blocks.iter().map(|b| b.lot).collect::<Vec<_>>())
        .collect();
    let json = city.to_json();
    let ids: Vec<String> = in_use.iter().map(u32::to_string).collect();
    println!(
        "{},\"inUse\":[{}]}}",
        json.strip_suffix('}').expect("a JSON object"),
        ids.join(",")
    );
}
