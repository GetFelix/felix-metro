//! Street, business and resident names, drawn from plain ASCII lists.

use crate::{city::Zone, rng::Rng};

const STREETS: [&str; 48] = [
    "Alder",
    "Baker",
    "Cedar",
    "Dock",
    "Elm",
    "Ferry",
    "Grove",
    "Harbor",
    "Ivy",
    "Juniper",
    "Kiln",
    "Linden",
    "Mill",
    "Newport",
    "Orchard",
    "Pine",
    "Quay",
    "Rowan",
    "Saltmarsh",
    "Tanner",
    "Union",
    "Vine",
    "Willow",
    "Yard",
    "Ash",
    "Birch",
    "Canal",
    "Drover",
    "Eastgate",
    "Foundry",
    "Granite",
    "Hawthorn",
    "Iron",
    "Jetty",
    "Kestrel",
    "Lantern",
    "Maple",
    "Nettle",
    "Oak",
    "Pepper",
    "Quarry",
    "Rope",
    "Spruce",
    "Tide",
    "Upper",
    "Vesper",
    "Wharf",
    "Yew",
];

const BUSINESS_PREFIX: [&str; 24] = [
    "Harbor",
    "Northgate",
    "Bluebird",
    "Copper",
    "Lantern",
    "Summit",
    "Marlow",
    "Kestrel",
    "Ironside",
    "Juniper",
    "Redwood",
    "Tidewater",
    "Foxglove",
    "Anchor",
    "Granite",
    "Mercer",
    "Halcyon",
    "Thistle",
    "Cobalt",
    "Driftwood",
    "Evergreen",
    "Fairway",
    "Larkspur",
    "Quill",
];

const SHOPS: [&str; 12] = [
    "Bakery", "Books", "Cafe", "Pharmacy", "Hardware", "Bistro", "Tailors", "Records", "Florist",
    "Grocer", "Studio", "Deli",
];

const OFFICES: [&str; 8] = [
    "Insurance",
    "Partners",
    "Capital",
    "Legal",
    "Software",
    "Consulting",
    "Media",
    "Realty",
];

const WORKS: [&str; 10] = [
    "Textiles",
    "Foundry",
    "Cannery",
    "Freight",
    "Brewing",
    "Metalworks",
    "Timber",
    "Chemicals",
    "Machining",
    "Cold Storage",
];

const FIRST: [&str; 40] = [
    "Mara", "Tomas", "Ines", "Kofi", "Lena", "Ravi", "Noor", "Elias", "Chloe", "Mateo", "Sana",
    "Jonas", "Amara", "Felix", "Priya", "Oscar", "Yuki", "Hana", "Diego", "Freya", "Idris",
    "Leila", "Sven", "Talia", "Bruno", "Camila", "Dmitri", "Esme", "Farid", "Greta", "Hugo",
    "Isla", "Jamal", "Katya", "Liam", "Mina", "Nico", "Olga", "Pablo", "Rosa",
];

const LAST: [&str; 40] = [
    "Okafor",
    "Lindqvist",
    "Moreau",
    "Tanaka",
    "Haddad",
    "Novak",
    "Silva",
    "Brennan",
    "Kowalski",
    "Mbeki",
    "Larsen",
    "Castillo",
    "Fischer",
    "Nakamura",
    "Rossi",
    "Adeyemi",
    "Petrov",
    "Duarte",
    "Hughes",
    "Ivanova",
    "Joshi",
    "Keller",
    "Lopez",
    "Mendez",
    "Nguyen",
    "Ortega",
    "Park",
    "Quinn",
    "Reyes",
    "Sato",
    "Torres",
    "Underwood",
    "Varga",
    "Walsh",
    "Xu",
    "Yilmaz",
    "Zielinski",
    "Abbas",
    "Berg",
    "Cohen",
];

/// A street name for each of `count` road lines, in line order. Names past
/// the end of the list get a number so two roads never share one.
pub(crate) fn street_names(rng: &mut Rng, count: usize) -> Vec<String> {
    let mut pool = STREETS.to_vec();
    rng.shuffle(&mut pool);
    (0..count)
        .map(|i| match i / pool.len() {
            0 => pool[i].to_string(),
            round => format!("{} {}", pool[i % pool.len()], round + 1),
        })
        .collect()
}

/// A business name for a lot, or `None` where nothing trades.
pub(crate) fn business_name(rng: &mut Rng, zone: Zone) -> Option<String> {
    let trade: &[&str] = match zone {
        Zone::Downtown => &OFFICES,
        Zone::Commercial => &SHOPS,
        Zone::Industrial => &WORKS,
        Zone::Suburban | Zone::Park => return None,
    };
    let prefix = BUSINESS_PREFIX[rng.below(BUSINESS_PREFIX.len())];
    Some(format!("{prefix} {}", trade[rng.below(trade.len())]))
}

/// The name of resident `index` in the city grown from `seed`. The same pair
/// always gives the same name.
pub fn resident_name(seed: &str, index: u32) -> String {
    let mut rng = Rng::for_index(seed, index);
    format!(
        "{} {}",
        FIRST[rng.below(FIRST.len())],
        LAST[rng.below(LAST.len())]
    )
}
