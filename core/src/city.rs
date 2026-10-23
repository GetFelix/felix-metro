//! A city grown from a seed: districts, lots, the road graph and names.
//!
//! The layout follows the style frame. A district is 12 by 12 tiles with a
//! road on every fourth tile, which leaves 3 by 3 blocks of 3 by 3 lots, and
//! one block in each district is a park. Roads also close the far edge of the
//! city, so a city of `d` districts a side is `12 * d + 1` tiles across.
//! Coordinates are tiles, `x` east and `z` south, from the north-west corner.

use std::fmt::Write;

use crate::{
    kinds::BuildingKind,
    names::{business_name, street_names},
    rng::{FNV_OFFSET, Rng, fnv1a},
};

/// Tiles along a district's side.
pub const DISTRICT_TILES: u16 = 12;
/// Tiles between two roads, the road included.
pub const ROAD_SPACING: u16 = 4;
const BLOCKS_PER_SIDE: u16 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    Downtown,
    Commercial,
    Suburban,
    Industrial,
    Park,
}

impl Zone {
    pub fn name(self) -> &'static str {
        match self {
            Zone::Downtown => "downtown",
            Zone::Commercial => "commercial",
            Zone::Suburban => "suburban",
            Zone::Industrial => "industrial",
            Zone::Park => "park",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentClass {
    /// A road on a district boundary.
    Avenue,
    Street,
}

impl SegmentClass {
    /// Speed in thousandths of a tile a second.
    pub fn speed(self) -> u16 {
        match self {
            SegmentClass::Avenue => 1500,
            SegmentClass::Street => 1000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct District {
    pub id: u16,
    /// Grid position in districts.
    pub x: u16,
    pub z: u16,
    /// The park block, as 0 to 2 within the district.
    pub park: (u8, u8),
}

#[derive(Clone, Debug)]
pub struct Lot {
    pub id: u32,
    pub x: u16,
    pub z: u16,
    pub district: u16,
    pub zone: Zone,
    pub kind: BuildingKind,
    /// Quarter turns clockwise from facing south (+z): 0 south, 1 east, 2 north, 3 west.
    pub facing: u8,
    pub name: Option<String>,
}

/// A stretch of road between two neighbouring intersections.
#[derive(Clone, Debug)]
pub struct Segment {
    pub id: u32,
    /// Intersection indexes into [`City::nodes`].
    pub a: u32,
    pub b: u32,
    pub class: SegmentClass,
    /// Tiles.
    pub length: u16,
    /// Thousandths of a tile a second.
    pub speed: u16,
    /// Index into [`City::streets`].
    pub street: u16,
}

#[derive(Clone, Debug)]
pub struct City {
    pub seed: String,
    pub districts_per_side: u16,
    pub districts: Vec<District>,
    pub lots: Vec<Lot>,
    /// Intersections as tile coordinates, row by row.
    pub nodes: Vec<(u16, u16)>,
    pub segments: Vec<Segment>,
    /// For each node, the `(neighbour node, segment id)` pairs.
    pub adjacency: Vec<Vec<(u32, u32)>>,
    /// Vertical roads by column, then horizontal roads by row.
    pub streets: Vec<String>,
    /// The edge with water along it: 0 north, 1 east, 2 south, 3 west.
    pub shore: Option<u8>,
    /// Water tiles; no lot is built on them.
    pub water: Vec<(u16, u16)>,
}

impl City {
    pub fn generate(seed: &str, districts_per_side: u16) -> City {
        assert!(districts_per_side > 0, "a city needs a district");
        let d = districts_per_side;
        let blocks = d * BLOCKS_PER_SIDE;
        let lines = blocks + 1;
        let mut rng = Rng::new(seed);

        let wet = rng.below(3) == 0;
        let edge = rng.below(4) as u8;
        let shore = (seed == "harbor" || wet).then_some(edge);
        let is_water_block = |bx: u16, bz: u16| match shore {
            Some(0) => bz == 0,
            Some(1) => bx == blocks - 1,
            Some(2) => bz == blocks - 1,
            Some(3) => bx == 0,
            _ => false,
        };

        // Distances are measured from the city centre in half tiles so lot
        // centres stay whole numbers.
        let centre = i32::from(DISTRICT_TILES * d);
        let dist2 = |tx: u16, tz: u16, size: u16| {
            let dx = i32::from(tx * 2 + size) - centre;
            let dz = i32::from(tz * 2 + size) - centre;
            dx * dx + dz * dz
        };

        // The tower stands on the dry lot nearest the centre.
        let mut tower = (i32::MAX, 0, 0, 0, 0);
        for bz in 0..blocks {
            for bx in 0..blocks {
                if is_water_block(bx, bz) {
                    continue;
                }
                for iz in 0..BLOCKS_PER_SIDE {
                    for ix in 0..BLOCKS_PER_SIDE {
                        let (x, z) = (bx * ROAD_SPACING + 1 + ix, bz * ROAD_SPACING + 1 + iz);
                        let d2 = dist2(x, z, 1);
                        if d2 < tower.0 {
                            tower = (d2, bx, bz, x, z);
                        }
                    }
                }
            }
        }
        let (_, tower_bx, tower_bz, tower_x, tower_z) = tower;

        let mut districts = Vec::new();
        for dz in 0..d {
            for dx in 0..d {
                let mut candidates = Vec::new();
                for lz in 0..BLOCKS_PER_SIDE {
                    for lx in 0..BLOCKS_PER_SIDE {
                        let (bx, bz) = (dx * BLOCKS_PER_SIDE + lx, dz * BLOCKS_PER_SIDE + lz);
                        if !is_water_block(bx, bz) && (bx, bz) != (tower_bx, tower_bz) {
                            candidates.push((lx as u8, lz as u8));
                        }
                    }
                }
                let park = candidates[rng.below(candidates.len())];
                districts.push(District {
                    id: dz * d + dx,
                    x: dx,
                    z: dz,
                    park,
                });
            }
        }

        let mut lots = Vec::new();
        let mut water = Vec::new();
        for bz in 0..blocks {
            for bx in 0..blocks {
                let district =
                    &districts[usize::from((bz / BLOCKS_PER_SIDE) * d + bx / BLOCKS_PER_SIDE)];
                let is_park =
                    district.park == ((bx % BLOCKS_PER_SIDE) as u8, (bz % BLOCKS_PER_SIDE) as u8);
                // Every block draws its zone roll, wet or not, so a shoreline
                // does not shift the rest of the city.
                let roll = rng.below(3);
                let permille = dist2(bx * ROAD_SPACING + 1, bz * ROAD_SPACING + 1, 3) * 1000
                    / (centre * centre);
                let zone = if is_park {
                    Zone::Park
                } else if permille < 100 {
                    Zone::Downtown
                } else if permille < 350 {
                    Zone::Commercial
                } else if roll == 0 {
                    Zone::Industrial
                } else {
                    Zone::Suburban
                };
                for iz in 0..BLOCKS_PER_SIDE {
                    for ix in 0..BLOCKS_PER_SIDE {
                        let (x, z) = (bx * ROAD_SPACING + 1 + ix, bz * ROAD_SPACING + 1 + iz);
                        if is_water_block(bx, bz) {
                            water.push((x, z));
                            continue;
                        }
                        let is_tower = (x, z) == (tower_x, tower_z);
                        let middle = ix == 1 && iz == 1;
                        let kind = if is_tower {
                            BuildingKind::FELIX_TOWER
                        } else {
                            pick_kind(&mut rng, zone, middle)
                        };
                        let facing = facing_of(&mut rng, ix, iz);
                        let name = if is_tower {
                            Some("Felix Tower".to_string())
                        } else {
                            business_name(&mut rng, zone)
                        };
                        lots.push(Lot {
                            id: lots.len() as u32,
                            x,
                            z,
                            district: district.id,
                            zone,
                            kind,
                            facing,
                            name,
                        });
                    }
                }
            }
        }

        let streets = street_names(&mut rng, usize::from(lines) * 2);
        let mut nodes = Vec::new();
        for j in 0..lines {
            for i in 0..lines {
                nodes.push((i * ROAD_SPACING, j * ROAD_SPACING));
            }
        }
        let node = |i: u16, j: u16| u32::from(j * lines + i);
        let mut segments = Vec::new();
        let mut adjacency = vec![Vec::new(); nodes.len()];
        let mut link = |a: u32, b: u32, line: u16, street: u16| {
            let class = if line.is_multiple_of(BLOCKS_PER_SIDE) {
                SegmentClass::Avenue
            } else {
                SegmentClass::Street
            };
            let id = segments.len() as u32;
            segments.push(Segment {
                id,
                a,
                b,
                class,
                length: ROAD_SPACING,
                speed: class.speed(),
                street,
            });
            adjacency[a as usize].push((b, id));
            adjacency[b as usize].push((a, id));
        };
        for j in 0..lines {
            for i in 0..lines - 1 {
                link(node(i, j), node(i + 1, j), j, lines + j);
            }
        }
        for i in 0..lines {
            for j in 0..lines - 1 {
                link(node(i, j), node(i, j + 1), i, i);
            }
        }

        City {
            seed: seed.to_string(),
            districts_per_side,
            districts,
            lots,
            nodes,
            segments,
            adjacency,
            streets,
            shore,
            water,
        }
    }

    /// Tiles along one side, the closing road included.
    pub fn tiles(&self) -> u16 {
        DISTRICT_TILES * self.districts_per_side + 1
    }

    /// The Felix tower's lot.
    pub fn tower(&self) -> &Lot {
        self.lots
            .iter()
            .find(|l| l.kind == BuildingKind::FELIX_TOWER)
            .expect("every city has a tower")
    }

    /// A 64-bit FNV-1a hash of the whole city. It reads integers and ASCII
    /// only, so native and WebAssembly builds agree.
    pub fn hash(&self) -> u64 {
        let mut h = Hasher(FNV_OFFSET);
        h.num(u64::from(self.districts_per_side));
        h.num(self.shore.map_or(u64::MAX, u64::from));
        for &(x, z) in &self.water {
            h.num(u64::from(x) << 16 | u64::from(z));
        }
        for dist in &self.districts {
            h.num(u64::from(dist.id) << 16 | u64::from(dist.park.0) << 8 | u64::from(dist.park.1));
        }
        for lot in &self.lots {
            h.num(u64::from(lot.id) << 32 | u64::from(lot.x) << 16 | u64::from(lot.z));
            h.num(
                u64::from(lot.district) << 24
                    | (lot.zone as u64) << 16
                    | u64::from(lot.kind.0) << 8
                    | u64::from(lot.facing),
            );
            h.text(lot.name.as_deref().unwrap_or(""));
        }
        for seg in &self.segments {
            h.num(u64::from(seg.id) << 32 | u64::from(seg.a));
            h.num(u64::from(seg.b) << 32 | u64::from(seg.street));
            h.num(u64::from(seg.length) << 16 | u64::from(seg.speed) << 1 | seg.class as u64);
        }
        for street in &self.streets {
            h.text(street);
        }
        h.0
    }

    /// The city as JSON for the browser to draw. Arrays hold rows in a fixed
    /// column order named by the `*Columns` entries; every string is ASCII
    /// without quotes, so nothing needs escaping.
    pub fn to_json(&self) -> String {
        let mut s = String::new();
        let _ = write!(
            s,
            "{{\"seed\":\"{}\",\"districtsPerSide\":{},\"tiles\":{},\"shore\":{},\"hash\":\"{:016x}\",\"tower\":{},",
            self.seed,
            self.districts_per_side,
            self.tiles(),
            self.shore.map_or("null".to_string(), |e| e.to_string()),
            self.hash(),
            self.tower().id
        );
        s.push_str("\"lotColumns\":[\"id\",\"x\",\"z\",\"district\",\"zone\",\"kind\",\"facing\",\"name\"],\"lots\":[");
        for (n, l) in self.lots.iter().enumerate() {
            let _ = write!(
                s,
                "{}[{},{},{},{},\"{}\",{},{},{}]",
                if n > 0 { "," } else { "" },
                l.id,
                l.x,
                l.z,
                l.district,
                l.zone.name(),
                l.kind.0,
                l.facing,
                l.name
                    .as_ref()
                    .map_or("null".to_string(), |n| format!("\"{n}\""))
            );
        }
        s.push_str("],\"water\":[");
        for (n, (x, z)) in self.water.iter().enumerate() {
            let _ = write!(s, "{}[{x},{z}]", if n > 0 { "," } else { "" });
        }
        s.push_str("],\"nodes\":[");
        for (n, (x, z)) in self.nodes.iter().enumerate() {
            let _ = write!(s, "{}[{x},{z}]", if n > 0 { "," } else { "" });
        }
        s.push_str("],\"segmentColumns\":[\"id\",\"a\",\"b\",\"avenue\",\"length\",\"speed\",\"street\"],\"segments\":[");
        for (n, g) in self.segments.iter().enumerate() {
            let _ = write!(
                s,
                "{}[{},{},{},{},{},{},{}]",
                if n > 0 { "," } else { "" },
                g.id,
                g.a,
                g.b,
                u8::from(g.class == SegmentClass::Avenue),
                g.length,
                g.speed,
                g.street
            );
        }
        s.push_str("],\"streets\":[");
        for (n, name) in self.streets.iter().enumerate() {
            let _ = write!(s, "{}\"{name}\"", if n > 0 { "," } else { "" });
        }
        s.push_str("]}");
        s
    }
}

struct Hasher(u64);

impl Hasher {
    fn num(&mut self, v: u64) {
        self.0 = fnv1a(self.0, &v.to_le_bytes());
    }

    /// Text is followed by a zero byte so neighbouring strings cannot run together.
    fn text(&mut self, v: &str) {
        self.0 = fnv1a(fnv1a(self.0, v.as_bytes()), &[0]);
    }
}

fn pick_kind(rng: &mut Rng, zone: Zone, middle: bool) -> BuildingKind {
    let (first, count) = match zone {
        Zone::Downtown if rng.below(2) == 0 => (
            BuildingKind::SKYSCRAPER_FIRST,
            BuildingKind::SKYSCRAPER_COUNT,
        ),
        Zone::Downtown | Zone::Commercial => (
            BuildingKind::COMMERCIAL_FIRST,
            BuildingKind::COMMERCIAL_COUNT,
        ),
        Zone::Suburban => (BuildingKind::HOUSE_FIRST, BuildingKind::HOUSE_COUNT),
        Zone::Industrial if middle => (BuildingKind::LANDMARK_FIRST, BuildingKind::LANDMARK_COUNT),
        Zone::Industrial => (BuildingKind::FACTORY_FIRST, BuildingKind::FACTORY_COUNT),
        Zone::Park => (BuildingKind::TREE_FIRST, BuildingKind::TREE_COUNT),
    };
    BuildingKind(first + rng.below(count) as u8)
}

/// The quarter turn that points a lot's front at a neighbouring road. A
/// corner lot has two to pick from; the middle lot of a block has none.
fn facing_of(rng: &mut Rng, ix: u16, iz: u16) -> u8 {
    let mut options = Vec::with_capacity(4);
    if iz == 2 {
        options.push(0);
    }
    if ix == 2 {
        options.push(1);
    }
    if iz == 0 {
        options.push(2);
    }
    if ix == 0 {
        options.push(3);
    }
    if options.is_empty() {
        return rng.below(4) as u8;
    }
    options[rng.below(options.len())]
}

#[cfg(test)]
mod tests;
