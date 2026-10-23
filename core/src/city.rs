//! A city grown from a seed: arterials, blocks, zones, lots, the road graph
//! and names.
//!
//! Arterials cross the whole city at irregular spacing and local streets
//! split the blocks between them; land value then sets the zones and heights.
//! A district is 12 by 12 tiles and only shards the city, roads ignore it.
//! The road along each far edge makes a city of `d` districts a side
//! `12 * d + 1` tiles across. Coordinates are tiles, `x` east and `z` south,
//! from the north-west corner. See `docs/design.md`, "City layout".

use std::fmt::Write;

use crate::{
    kinds::BuildingKind,
    names::street_names,
    rng::{FNV_OFFSET, Rng, fnv1a},
};
use lots::{pick_parks, plan_lots, tower_tile};
use noise::{below, mix};
use roads::{
    EAST, NORTH, SOUTH, WEST, build_graph, idx, is_road, keep_largest, lay_out, neighbours,
};
use zoning::Site;

mod lots;
mod noise;
mod roads;
mod zoning;

/// Tiles along a district's side.
pub const DISTRICT_TILES: u16 = 12;
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
    /// Tiles from the segment's first node, 0 up to its length.
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
    /// An arterial, a road that crosses the whole city.
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
    /// The north-west tile of the district's park block, if it has one.
    pub park: Option<(u16, u16)>,
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
    /// Where the lot meets the road, or `None` for filler: a tile inside a
    /// block with no road beside it, left as trees or a plaza prop.
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
    /// Water tiles; no lot or road is built on them.
    pub water: Vec<(u16, u16)>,
    /// Every road tile, row by row, with the piece it needs.
    pub roads: Vec<RoadTile>,
    /// The main centre, then the secondary ones.
    pub centres: Vec<(u16, u16)>,
}

/// The kind of road piece a tile needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoadPiece {
    Straight,
    Corner,
    /// Three ways.
    T,
    Cross,
    /// A dead end.
    End,
}

/// A road tile and the piece to draw on it.
///
/// `mask` has one bit per road neighbour: 1 north, 2 east, 4 south, 8 west.
/// `rot` is the quarter turns clockwise from the piece's base orientation to
/// `mask`; the bases are straight east and west, corner east and south, T
/// east, south and west, end south, cross all four.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoadTile {
    pub x: u16,
    pub z: u16,
    pub piece: RoadPiece,
    pub rot: u8,
    pub mask: u8,
    /// On an interior arterial.
    pub avenue: bool,
}

fn road_tile(mask: &[u8], n: i32, x: i32, z: i32) -> RoadTile {
    let m = neighbours(mask, n, x, z);
    let (piece, base) = match m.count_ones() {
        4 => (RoadPiece::Cross, m),
        3 => (RoadPiece::T, EAST | SOUTH | WEST),
        2 if m == NORTH | SOUTH || m == EAST | WEST => (RoadPiece::Straight, EAST | WEST),
        2 => (RoadPiece::Corner, EAST | SOUTH),
        _ => (RoadPiece::End, SOUTH),
    };
    let turn = |m: u8| ((m << 1) | (m >> 3)) & 15;
    let (mut rot, mut b) = (0u8, base);
    while b != m && rot < 3 {
        b = turn(b);
        rot += 1;
    }
    RoadTile {
        x: x as u16,
        z: z as u16,
        piece,
        rot,
        mask: m,
        avenue: mask[idx(n, x, z)] & roads::ARTERIAL != 0,
    }
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
            h.num(u64::from(dist.id));
            h.num(
                dist.park
                    .map_or(u64::MAX, |(x, z)| u64::from(x) << 16 | u64::from(z)),
            );
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
        for r in &self.roads {
            h.num(
                u64::from(r.x) << 32
                    | u64::from(r.z) << 16
                    | u64::from(r.mask) << 8
                    | u64::from(r.rot),
            );
            h.num(u64::from(r.piece as u8) << 1 | u64::from(r.avenue));
        }
        for &(x, z) in &self.centres {
            h.num(u64::from(x) << 16 | u64::from(z));
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
        s.push_str(
            "],\"roadColumns\":[\"x\",\"z\",\"piece\",\"rot\",\"mask\",\"avenue\"],\"roads\":[",
        );
        for (n, r) in self.roads.iter().enumerate() {
            let _ = write!(
                s,
                "{}[{},{},{},{},{},{}]",
                if n > 0 { "," } else { "" },
                r.x,
                r.z,
                r.piece as u8,
                r.rot,
                r.mask,
                u8::from(r.avenue)
            );
        }
        s.push_str("],\"centres\":[");
        for (n, (x, z)) in self.centres.iter().enumerate() {
            let _ = write!(s, "{}[{x},{z}]", if n > 0 { "," } else { "" });
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
/// edge it would use is reserved either way.
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
    let d = i32::from(districts_per_side);
    let n = DISTRICT_TILES as i32 * d + 1;
    let seed_hash = fnv1a(FNV_OFFSET, seed.as_bytes());

    let has_water = seed == "harbor" || below(mix(seed_hash, noise::SHORE, &[0]), 3) == 0;
    let edge = below(mix(seed_hash, noise::SHORE, &[1]), 4) as u8;
    let shore = wet.unwrap_or(has_water).then_some(edge);

    let site = Site::new(seed_hash, n, has_water, edge);
    let layout = lay_out(&site);
    let block_zones: Vec<Zone> = layout.blocks.iter().map(|&b| site.block_zone(b)).collect();
    let tower = tower_tile(&site, &layout.mask);
    let park_blocks = pick_parks(&site, &layout.blocks, &block_zones, tower, d);
    let mut is_park = vec![false; layout.blocks.len()];
    for &b in park_blocks.iter().flatten() {
        is_park[b] = true;
    }
    let planned = plan_lots(&site, &layout, &block_zones, &is_park, tower);

    // The layout above ignores the shoreline. Water is a mask over it: the
    // shore tiles go under, roads left cut off go with them, and so does any
    // lot whose road did.
    let tiles = (n * n) as usize;
    let mut flooded = vec![false; tiles];
    let mut mask = layout.mask.clone();
    if shore.is_some() {
        for z in 0..n {
            for x in 0..n {
                if site.is_shore_water(x, z) {
                    flooded[idx(n, x, z)] = true;
                    mask[idx(n, x, z)] = 0;
                }
            }
        }
        for i in keep_largest(&mut mask, n) {
            flooded[i] = true;
        }
    }
    let graph = build_graph(&mask, &site);

    let mut lots = Vec::new();
    for p in planned {
        let door = match p.door {
            Some((rx, rz)) => match graph.door_at(n, rx, rz) {
                Some((segment, offset)) if is_road(&mask, n, rx, rz) => {
                    Some(Door { segment, offset })
                }
                _ => {
                    flooded[idx(n, p.x, p.z)] = true;
                    continue;
                }
            },
            None => None,
        };
        if flooded[idx(n, p.x, p.z)] {
            continue;
        }
        lots.push(Lot {
            id: lots.len() as u32,
            x: p.x as u16,
            z: p.z as u16,
            district: ((p.z / 12).min(d - 1) * d + (p.x / 12).min(d - 1)) as u16,
            zone: p.zone,
            kind: p.kind,
            facing: p.facing,
            name: p.name,
            door,
        });
    }

    let districts = (0..d)
        .flat_map(|dz| (0..d).map(move |dx| (dx, dz)))
        .zip(&park_blocks)
        .map(|((dx, dz), park)| District {
            id: (dz * d + dx) as u16,
            x: dx as u16,
            z: dz as u16,
            park: park.map(|b| {
                let r = layout.blocks[b];
                (r.x0 as u16, r.z0 as u16)
            }),
        })
        .collect();

    let mut water = Vec::new();
    for z in 0..n {
        for x in 0..n {
            if flooded[idx(n, x, z)] {
                water.push((x as u16, z as u16));
            }
        }
    }
    let mut roads = Vec::new();
    for z in 0..n {
        for x in 0..n {
            if is_road(&mask, n, x, z) {
                roads.push(road_tile(&mask, n, x, z));
            }
        }
    }
    let streets = street_names(
        &mut Rng::from_state(mix(seed_hash, noise::STREETS, &[])),
        graph.street_count,
    );

    Ok(City {
        seed: seed.to_string(),
        districts_per_side,
        districts,
        lots,
        nodes: graph.nodes,
        segments: graph.segments,
        adjacency: graph.adjacency,
        streets,
        shore,
        water,
        roads,
        centres: site
            .centres
            .iter()
            .map(|&(x, z, _)| (x as u16, z as u16))
            .collect(),
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

#[cfg(test)]
mod tests;
