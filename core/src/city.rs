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
const MAX_DISTRICTS: u16 = 16;

/// Why a city could not be generated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GenerateError {
    /// The seed is empty, too long or has characters outside `a-z0-9-~`.
    Seed,
    /// Districts per side must be 1 to 16.
    Districts,
}

impl std::fmt::Display for GenerateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            GenerateError::Seed => "seed must be parts of 1 to 32 of a-z, 0-9 and -, joined by ~",
            GenerateError::Districts => "districts per side must be 1 to 16",
        })
    }
}

impl std::error::Error for GenerateError {}

/// The point on a road segment a lot opens onto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Door {
    pub segment: u32,
    /// Tiles from the segment's first intersection, 1 to 3.
    pub offset: u16,
}

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
    door: Option<Door>,
}

impl Lot {
    /// Where the lot meets the road, or `None` for the middle lot of a
    /// block, which is filler and has no road beside it.
    pub fn door(&self) -> Option<Door> {
        self.door
    }
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
    /// Grows the city for `seed`. A seed is one or more parts joined by `~`
    /// (a fork's lineage), each 1 to 32 characters of `a-z`, `0-9` and `-`.
    pub fn generate(seed: &str, districts_per_side: u16) -> Result<City, GenerateError> {
        build(seed, districts_per_side, None)
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
            h.num(lot.door.map_or(u64::MAX, |d| {
                u64::from(d.segment) << 16 | u64::from(d.offset)
            }));
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
            self.seed.replace('\\', "\\\\").replace('"', "\\\""),
            self.districts_per_side,
            self.tiles(),
            self.shore.map_or("null".to_string(), |e| e.to_string()),
            self.hash(),
            self.tower().id
        );
        s.push_str("\"lotColumns\":[\"id\",\"x\",\"z\",\"district\",\"zone\",\"kind\",\"facing\",\"name\",\"doorSegment\",\"doorOffset\"],\"lots\":[");
        for (n, l) in self.lots.iter().enumerate() {
            let _ = write!(
                s,
                "{}[{},{},{},{},\"{}\",{},{},{},{},{}]",
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
                    .map_or("null".to_string(), |n| format!("\"{n}\"")),
                l.door.map_or("null".to_string(), |d| d.segment.to_string()),
                l.door.map_or("null".to_string(), |d| d.offset.to_string())
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

/// `wet` overrides the seed's own choice of whether it has a shoreline; the
/// edge it would use is drawn either way.
pub(crate) fn build(
    seed: &str,
    districts_per_side: u16,
    wet: Option<bool>,
) -> Result<City, GenerateError> {
    if !valid_seed(seed) {
        return Err(GenerateError::Seed);
    }
    if districts_per_side == 0 || districts_per_side > MAX_DISTRICTS {
        return Err(GenerateError::Districts);
    }
    let d = districts_per_side;
    let blocks = d * BLOCKS_PER_SIDE;
    let lines = blocks + 1;
    let mut rng = Rng::new(seed);

    let seed_is_wet = rng.below(3) == 0;
    let edge = rng.below(4) as u8;
    let shore = wet
        .unwrap_or(seed == "harbor" || seed_is_wet)
        .then_some(edge);
    let on_edge_row = |bx: u16, bz: u16| match edge {
        0 => bz == 0,
        1 => bx == blocks - 1,
        2 => bz == blocks - 1,
        _ => bx == 0,
    };
    let is_water_block = |bx: u16, bz: u16| shore.is_some() && on_edge_row(bx, bz);

    // The road line along the water has the map edge on its other side and
    // serves no lot, so it is left out.
    let (i0, i1, j0, j1) = match shore {
        Some(0) => (0, lines, 1, lines),
        Some(1) => (0, lines - 1, 0, lines),
        Some(2) => (0, lines, 0, lines - 1),
        Some(3) => (1, lines, 0, lines),
        _ => (0, lines, 0, lines),
    };
    let (cols, rows) = (i1 - i0, j1 - j0);
    let node = |i: u16, j: u16| u32::from((j - j0) * cols + (i - i0));
    let h_count = u32::from(rows) * u32::from(cols - 1);
    let h_id = |i: u16, j: u16| u32::from((j - j0) * (cols - 1) + (i - i0));
    let v_id = |i: u16, j: u16| h_count + u32::from((i - i0) * (rows - 1) + (j - j0));

    // Distances are measured from the city centre in half tiles so lot
    // centres stay whole numbers.
    let centre = i32::from(DISTRICT_TILES * d);
    let dist2 = |tx: u16, tz: u16, size: u16| {
        let dx = i32::from(tx * 2 + size) - centre;
        let dz = i32::from(tz * 2 + size) - centre;
        dx * dx + dz * dz
    };

    // The tower stands on the lot nearest the centre that is not a block's
    // middle. That lot is never wet, so the shoreline cannot move it.
    let mut tower = (i32::MAX, 0, 0, 0, 0);
    for bz in 0..blocks {
        for bx in 0..blocks {
            for iz in 0..BLOCKS_PER_SIDE {
                for ix in 0..BLOCKS_PER_SIDE {
                    if ix == 1 && iz == 1 {
                        continue;
                    }
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

    // Parks avoid the row along the shoreline edge whether or not the seed
    // is wet, so a dry city and its wet twin keep the same parks.
    let mut districts = Vec::new();
    for dz in 0..d {
        for dx in 0..d {
            let mut candidates = Vec::new();
            for lz in 0..BLOCKS_PER_SIDE {
                for lx in 0..BLOCKS_PER_SIDE {
                    let (bx, bz) = (dx * BLOCKS_PER_SIDE + lx, dz * BLOCKS_PER_SIDE + lz);
                    if !on_edge_row(bx, bz) && (bx, bz) != (tower_bx, tower_bz) {
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

    // Water lots draw the same values as dry ones and throw them away.
    let mut lots = Vec::new();
    let mut water = Vec::new();
    for bz in 0..blocks {
        for bx in 0..blocks {
            let district =
                &districts[usize::from((bz / BLOCKS_PER_SIDE) * d + bx / BLOCKS_PER_SIDE)];
            let is_park =
                district.park == ((bx % BLOCKS_PER_SIDE) as u8, (bz % BLOCKS_PER_SIDE) as u8);
            let roll = rng.below(3);
            let permille =
                dist2(bx * ROAD_SPACING + 1, bz * ROAD_SPACING + 1, 3) * 1000 / (centre * centre);
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
                    let middle = ix == 1 && iz == 1;
                    let is_tower = (x, z) == (tower_x, tower_z);
                    let kind = if is_tower {
                        BuildingKind::FELIX_TOWER
                    } else if middle {
                        filler_kind(&mut rng, zone)
                    } else {
                        pick_kind(&mut rng, zone)
                    };
                    let facing = if middle {
                        0
                    } else {
                        facing_of(&mut rng, ix, iz)
                    };
                    let name = if is_tower {
                        Some("Felix Tower".to_string())
                    } else if middle {
                        None
                    } else {
                        business_name(&mut rng, zone)
                    };
                    if is_water_block(bx, bz) {
                        water.push((x, z));
                        continue;
                    }
                    let door = (!middle).then(|| match facing {
                        0 => Door {
                            segment: h_id(bx, bz + 1),
                            offset: ix + 1,
                        },
                        1 => Door {
                            segment: v_id(bx + 1, bz),
                            offset: iz + 1,
                        },
                        2 => Door {
                            segment: h_id(bx, bz),
                            offset: ix + 1,
                        },
                        _ => Door {
                            segment: v_id(bx, bz),
                            offset: iz + 1,
                        },
                    });
                    lots.push(Lot {
                        id: lots.len() as u32,
                        x,
                        z,
                        district: district.id,
                        zone,
                        kind,
                        facing,
                        name,
                        door,
                    });
                }
            }
        }
    }
    // The skipped road line is water too.
    let size = DISTRICT_TILES * d + 1;
    match shore {
        Some(0) => water.extend((0..size).map(|x| (x, 0))),
        Some(1) => water.extend((0..size).map(|z| (size - 1, z))),
        Some(2) => water.extend((0..size).map(|x| (x, size - 1))),
        Some(3) => water.extend((0..size).map(|z| (0, z))),
        _ => {}
    }

    let streets = street_names(&mut rng, usize::from(lines) * 2);
    let mut nodes = Vec::new();
    for j in j0..j1 {
        for i in i0..i1 {
            nodes.push((i * ROAD_SPACING, j * ROAD_SPACING));
        }
    }
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
    for j in j0..j1 {
        for i in i0..i1 - 1 {
            link(node(i, j), node(i + 1, j), j, lines + j);
        }
    }
    for i in i0..i1 {
        for j in j0..j1 - 1 {
            link(node(i, j), node(i, j + 1), i, i);
        }
    }

    Ok(City {
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
    })
}

fn valid_seed(seed: &str) -> bool {
    !seed.is_empty()
        && seed.split('~').all(|part| {
            (1..=32).contains(&part.len())
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
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

fn pick_kind(rng: &mut Rng, zone: Zone) -> BuildingKind {
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
        Zone::Industrial => (BuildingKind::FACTORY_FIRST, BuildingKind::FACTORY_COUNT),
        Zone::Park => (BuildingKind::TREE_FIRST, BuildingKind::TREE_COUNT),
    };
    BuildingKind(first + rng.below(count) as u8)
}

/// What fills the middle of a block: trees in a park, otherwise trees or a
/// small plaza prop. Nobody lives or works there.
fn filler_kind(rng: &mut Rng, zone: Zone) -> BuildingKind {
    let count = if zone == Zone::Park {
        BuildingKind::TREE_COUNT
    } else {
        BuildingKind::FILLER_COUNT
    };
    BuildingKind(BuildingKind::TREE_FIRST + rng.below(count) as u8)
}

/// The quarter turn that points a lot's front at a neighbouring road. A
/// corner lot has two to pick from. Only called for lots on a block's rim.
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
    options[rng.below(options.len())]
}

#[cfg(test)]
mod tests;
