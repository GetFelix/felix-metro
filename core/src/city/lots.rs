//! Lots: what stands on each non-road tile, which way it faces and which
//! blocks are parks.

use super::{
    noise::{self, below, mix, sub},
    roads::{ARTERIAL, EAST, Layout, NORTH, Rect, SOUTH, WEST, is_road, neighbours},
    zoning::{CLEAR_OF_SHORE, PARK_CLEARANCES, Site, octagon},
};
use crate::{city::Zone, kinds::BuildingKind, names::business_name, rng::Rng};

/// A lot as laid out on dry land.
pub(super) struct PlannedLot {
    pub x: i32,
    pub z: i32,
    pub zone: Zone,
    pub kind: BuildingKind,
    pub facing: u8,
    pub name: Option<String>,
    /// The road tile the lot opens onto; `None` for filler.
    pub door: Option<(i32, i32)>,
}

// Commercial buildings by height, from the models' bounding boxes.
const COMMERCIAL_LOW: [u8; 2] = [2, 4];
const COMMERCIAL_MID: [u8; 4] = [0, 1, 3, 7];
const COMMERCIAL_HIGH: [u8; 5] = [5, 6, 8, 9, 10];
const COMMERCIAL_TALL: [u8; 3] = [11, 12, 13];
const HOUSES_SMALL: [u8; 6] = [0, 6, 7, 8, 2, 9];
const HOUSES_LARGE: [u8; 4] = [3, 1, 4, 5];
const FACTORIES_SMALL: [u8; 4] = [2, 3, 0, 1];
const FACTORIES_LARGE: [u8; 2] = [4, 5];

/// Park blocks: the largest area tried first, the area they favour, and the
/// percent of block tiles the parks may reach before districts start to skip.
const PARK_AREA: i32 = 16;
const PARK_IDEAL: i32 = 8;

const DIRECTIONS: [(u8, u8, i32, i32); 4] = [
    // facing, neighbour bit, dx, dz: south, east, north, west.
    (0, SOUTH, 0, 1),
    (1, EAST, 1, 0),
    (2, NORTH, 0, -1),
    (3, WEST, -1, 0),
];

fn pick(list: &[u8], h: u64) -> u8 {
    list[below(h, list.len() as i32) as usize]
}

/// The lot nearest the main centre that has a road beside it and is clear
/// of the shoreline.
pub(super) fn tower_tile(site: &Site, mask: &[u8]) -> (i32, i32) {
    let n = site.n;
    let (cx, cz, _) = site.centres[0];
    let mut best: Option<(i32, i32, i32)> = None;
    for margin in [CLEAR_OF_SHORE, 0] {
        for z in 0..n {
            for x in 0..n {
                if is_road(mask, n, x, z)
                    || neighbours(mask, n, x, z) == 0
                    || !site.clear_of_shore(x, z, margin)
                {
                    continue;
                }
                let d = octagon(x - cx, z - cz);
                if best.is_none_or(|(bd, _, _)| d < bd) {
                    best = Some((d, x, z));
                }
            }
        }
        if best.is_some() {
            break;
        }
    }
    let (_, x, z) = best.expect("a city has a lot beside a road");
    (x, z)
}

/// The park block of each district: a mid-sized block that the water cannot
/// take, not the tower's. Strictly, also not downtown or industrial. A
/// district may go without when the city's parks already pass `PARK_SHARE`
/// percent of its block tiles. Returns the chosen block per district.
pub(super) fn pick_parks(
    site: &Site,
    blocks: &[Rect],
    zones: &[Zone],
    tower: (i32, i32),
    districts: i32,
) -> Vec<Option<usize>> {
    let mut out = Vec::new();
    for dz in 0..districts {
        for dx in 0..districts {
            let in_district = |b: &Rect| {
                let (cx, cz) = b.centre();
                (cx / 12).min(districts - 1) == dx && (cz / 12).min(districts - 1) == dz
            };
            let usable = |i: usize, b: &Rect, strict: bool, clear: i32, cap: i32| {
                let corners = [
                    (b.x0, b.z0),
                    (b.x1 - 1, b.z0),
                    (b.x0, b.z1 - 1),
                    (b.x1 - 1, b.z1 - 1),
                ];
                let has_tower = (b.x0..b.x1).contains(&tower.0) && (b.z0..b.z1).contains(&tower.1);
                in_district(b)
                    && (6..=cap).contains(&b.area())
                    && !has_tower
                    && corners
                        .iter()
                        .all(|&(x, z)| site.clear_of_shore(x, z, clear))
                    && (!strict || !matches!(zones[i], Zone::Downtown | Zone::Industrial))
            };
            let mut found = Vec::new();
            'tiers: for cap in [PARK_AREA, i32::MAX] {
                for clear in PARK_CLEARANCES {
                    for strict in [true, false] {
                        found = blocks
                            .iter()
                            .enumerate()
                            .filter(|&(i, b)| usable(i, b, strict, clear, cap))
                            .map(|(i, b)| ((b.area() - PARK_IDEAL).abs(), i))
                            .collect();
                        if !found.is_empty() {
                            break 'tiers;
                        }
                    }
                }
            }
            found.sort_unstable();
            found.truncate(found.len().div_ceil(2));
            let h = mix(site.seed, noise::PARK, &[dx, dz]);
            let pick = (!found.is_empty()).then(|| found[below(h, found.len() as i32) as usize].1);
            out.push(pick);
        }
    }
    out
}

pub(super) fn plan_lots(
    site: &Site,
    layout: &Layout,
    block_zones: &[Zone],
    parks: &[bool],
    tower: (i32, i32),
) -> Vec<PlannedLot> {
    let n = site.n;
    let mask = &layout.mask;
    let mut block_of = vec![usize::MAX; (n * n) as usize];
    for (i, b) in layout.blocks.iter().enumerate() {
        for z in b.z0..b.z1 {
            for x in b.x0..b.x1 {
                block_of[(z * n + x) as usize] = i;
            }
        }
    }
    let mut lots = Vec::new();
    for z in 0..n {
        for x in 0..n {
            if is_road(mask, n, x, z) {
                continue;
            }
            let b = block_of[(z * n + x) as usize];
            let is_tower = (x, z) == tower;
            let zone = if b == usize::MAX {
                site.zone(x, z)
            } else if parks[b] {
                Zone::Park
            } else {
                block_zones[b]
            };
            let zone = if is_tower { Zone::Downtown } else { zone };
            let m = neighbours(mask, n, x, z);
            let h = mix(site.seed, noise::LOT, &[x, z]);
            if m == 0 {
                let count = if zone == Zone::Park {
                    BuildingKind::TREE_COUNT
                } else {
                    BuildingKind::FILLER_COUNT
                };
                lots.push(PlannedLot {
                    x,
                    z,
                    zone,
                    kind: BuildingKind(BuildingKind::TREE_FIRST + below(h, count as i32) as u8),
                    facing: 0,
                    name: None,
                    door: None,
                });
                continue;
            }

            let sides: Vec<_> = DIRECTIONS
                .iter()
                .filter(|d| m & d.1 != 0)
                .copied()
                .collect();
            let corner = sides.len() >= 2 && m != NORTH | SOUTH && m != EAST | WEST;
            // Shops face the arterial when they have one beside them.
            let on_arterial =
                |d: &(u8, u8, i32, i32)| mask[((z + d.3) * n + x + d.2) as usize] & ARTERIAL != 0;
            let mut options: Vec<_> = sides.clone();
            if matches!(zone, Zone::Downtown | Zone::Commercial) && sides.iter().any(on_arterial) {
                options.retain(on_arterial);
            }
            let (facing, _, dx, dz) = options[below(sub(h, 1), options.len() as i32) as usize];

            let v = site.value(x, z);
            let jitter = below(sub(h, 2), 41) - 20;
            let score = v + jitter + if corner { 25 } else { 0 };
            let kind = if is_tower {
                BuildingKind::FELIX_TOWER
            } else {
                let pick_h = sub(h, 3);
                match zone {
                    Zone::Park => BuildingKind(
                        BuildingKind::TREE_FIRST
                            + below(pick_h, BuildingKind::TREE_COUNT as i32) as u8,
                    ),
                    Zone::Downtown if score >= 205 => BuildingKind(
                        BuildingKind::SKYSCRAPER_FIRST
                            + below(pick_h, BuildingKind::SKYSCRAPER_COUNT as i32) as u8,
                    ),
                    Zone::Downtown | Zone::Commercial => {
                        let tier: &[u8] = match score {
                            175.. => &COMMERCIAL_TALL,
                            150..=174 => &COMMERCIAL_HIGH,
                            110..=149 => &COMMERCIAL_MID,
                            _ => &COMMERCIAL_LOW,
                        };
                        BuildingKind(BuildingKind::COMMERCIAL_FIRST + pick(tier, pick_h))
                    }
                    Zone::Suburban => {
                        let list: &[u8] = if corner { &HOUSES_LARGE } else { &HOUSES_SMALL };
                        BuildingKind(BuildingKind::HOUSE_FIRST + pick(list, pick_h))
                    }
                    Zone::Industrial => {
                        let first = BuildingKind::FACTORY_FIRST;
                        if corner {
                            BuildingKind(first + pick(&FACTORIES_LARGE, pick_h))
                        } else if below(sub(h, 4), 6) == 0 {
                            BuildingKind(first + 6 + below(pick_h, 3) as u8)
                        } else {
                            BuildingKind(first + pick(&FACTORIES_SMALL, pick_h))
                        }
                    }
                }
            };
            let name = if is_tower {
                Some("Felix Tower".to_string())
            } else {
                business_name(
                    &mut Rng::from_state(mix(site.seed, noise::NAME, &[x, z])),
                    zone,
                )
            };
            lots.push(PlannedLot {
                x,
                z,
                zone,
                kind,
                facing,
                name,
                door: Some((x + dx, z + dz)),
            });
        }
    }
    lots
}
