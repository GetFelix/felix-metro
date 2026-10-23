//! The road network: arterials at irregular spacing, local streets by
//! splitting the blocks between them, then the graph read off the tiles.

use super::{
    noise::{self, below, mix, sub},
    zoning::Site,
};
use crate::city::{Segment, SegmentClass, Zone};

pub(super) const ROAD: u8 = 1;
pub(super) const ARTERIAL: u8 = 2;

/// Neighbour bits of a road tile.
pub(super) const NORTH: u8 = 1;
pub(super) const EAST: u8 = 2;
pub(super) const SOUTH: u8 = 4;
pub(super) const WEST: u8 = 8;

/// A block: the non-road tiles `x0..x1` by `z0..z1`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Rect {
    pub x0: i32,
    pub z0: i32,
    pub x1: i32,
    pub z1: i32,
}

impl Rect {
    pub(super) fn centre(self) -> (i32, i32) {
        ((self.x0 + self.x1 - 1) / 2, (self.z0 + self.z1 - 1) / 2)
    }

    pub(super) fn area(self) -> i32 {
        (self.x1 - self.x0) * (self.z1 - self.z0)
    }
}

pub(super) struct Layout {
    /// Per tile: [`ROAD`], plus [`ARTERIAL`] on an interior arterial.
    pub mask: Vec<u8>,
    pub blocks: Vec<Rect>,
}

/// Road lines across one axis, 7 to 12 tiles apart, from one map edge to the
/// other. The last gap is at least 7 and can run wider.
pub(super) fn arterial_lines(seed: u64, axis: i32, n: i32) -> Vec<i32> {
    let mut lines = vec![0];
    let mut at = 0;
    for i in 0.. {
        let step = 7 + below(mix(seed, noise::ARTERIAL, &[axis + 10, i]), 6);
        if at + step > n - 1 - 7 {
            break;
        }
        at += step;
        lines.push(at);
    }
    lines.push(n - 1);
    lines
}

pub(super) fn idx(n: i32, x: i32, z: i32) -> usize {
    (z * n + x) as usize
}

pub(super) fn is_road(mask: &[u8], n: i32, x: i32, z: i32) -> bool {
    x >= 0 && z >= 0 && x < n && z < n && mask[idx(n, x, z)] & ROAD != 0
}

/// Which of the four neighbours of a tile are road.
pub(super) fn neighbours(mask: &[u8], n: i32, x: i32, z: i32) -> u8 {
    let mut m = 0;
    for (bit, dx, dz) in [(NORTH, 0, -1), (EAST, 1, 0), (SOUTH, 0, 1), (WEST, -1, 0)] {
        if is_road(mask, n, x + dx, z + dz) {
            m |= bit;
        }
    }
    m
}

struct Splitter<'a> {
    site: &'a Site,
    mask: Vec<u8>,
    blocks: Vec<Rect>,
}

/// Block shape limits by zone: block length range, and the percent of blocks
/// that may keep a small unbuilt core, and the percent of splits that
/// become dead-end stubs.
fn limits(zone: Zone) -> (i32, i32, i32, i32) {
    match zone {
        Zone::Downtown => (3, 5, 8, 0),
        Zone::Commercial => (4, 6, 12, 0),
        Zone::Industrial => (8, 12, 15, 0),
        Zone::Suburban | Zone::Park => (6, 9, 25, 25),
    }
}

/// Which sides of a block have a road along them.
const BOUND_W: u8 = 1;
const BOUND_E: u8 = 2;
const BOUND_N: u8 = 4;
const BOUND_S: u8 = 8;

impl Splitter<'_> {
    /// Splits the rectangle with a street until every tile has a road beside
    /// it, bar a core of at most two tiles in some blocks. Each choice is
    /// keyed on the rectangle, so changing one block leaves its neighbours
    /// alone. A side on the map edge with no ring road has none.
    fn split(&mut self, r: Rect, bound: u8) {
        let (w, h) = (r.x1 - r.x0, r.z1 - r.z0);
        if w <= 0 || h <= 0 {
            return;
        }
        let hash = mix(self.site.seed, noise::BLOCK, &[r.x0, r.z0, w, h]);
        let (lmin, lmax, cores, stub) = limits(self.site.block_zone(r));
        let length_cap = lmin + below(sub(hash, 2), lmax - lmin + 1);
        let allowed = if below(sub(hash, 3), 100) < cores {
            2
        } else {
            0
        };

        let bounds = |lo: u8, hi: u8| i32::from(bound & lo != 0) + i32::from(bound & hi != 0);
        let (ix, iz) = (
            (w - bounds(BOUND_W, BOUND_E)).max(0),
            (h - bounds(BOUND_N, BOUND_S)).max(0),
        );
        let too_long = w.max(h) > length_cap + 1;
        let across_x = if ix * iz > allowed {
            // Cut the deeper way, so the pieces get thin.
            if ix != iz { ix > iz } else { w >= h }
        } else if too_long {
            w >= h
        } else {
            self.blocks.push(r);
            return;
        };
        let size = if across_x { w } else { h };
        if size < 3 {
            self.blocks.push(r);
            return;
        }
        let cap = if ix * iz > allowed { 2 } else { length_cap };

        // One side gets about the capped size, so blocks come out near it
        // and the odd one is smaller or larger.
        let low = if size >= 5 { 2 } else { 1 };
        let first = (cap - below(sub(hash, 4), 2)).clamp(low, size - 1 - low);
        let at = if below(sub(hash, 7), 2) == 1 {
            size - 1 - first
        } else {
            first
        };
        let length = if across_x { h } else { w };
        let ends = if across_x {
            BOUND_N | BOUND_S
        } else {
            BOUND_W | BOUND_E
        };
        let is_stub =
            stub > 0 && length >= 8 && bound & ends == ends && below(sub(hash, 5), 100) < stub;
        // A stub starts at one side and stops short of the other, ending
        // in a dead end with a two tile gap before the far road.
        let from_far = below(sub(hash, 6), 2) == 1;
        let (a, b) = match (is_stub, from_far) {
            (false, _) => (0, length),
            (true, false) => (0, length - 2),
            (true, true) => (2, length),
        };
        for k in a..b {
            let (x, z) = if across_x {
                (r.x0 + at, r.z0 + k)
            } else {
                (r.x0 + k, r.z0 + at)
            };
            self.mask[idx(self.site.n, x, z)] |= ROAD;
        }
        let (first, second, lo_bit, hi_bit) = if across_x {
            (
                Rect { x1: r.x0 + at, ..r },
                Rect {
                    x0: r.x0 + at + 1,
                    ..r
                },
                BOUND_W,
                BOUND_E,
            )
        } else {
            (
                Rect { z1: r.z0 + at, ..r },
                Rect {
                    z0: r.z0 + at + 1,
                    ..r
                },
                BOUND_N,
                BOUND_S,
            )
        };
        self.split(first, bound | hi_bit);
        self.split(second, bound | lo_bit);
    }
}

/// Which map edges carry a ring road: west, east, north, south. Some edges
/// are left open so the outskirts end raggedly. At least one is always open.
pub(super) fn ring_edges(seed: u64) -> [bool; 4] {
    let mut ring = [0, 1, 2, 3].map(|e| below(mix(seed, noise::RING, &[e]), 100) >= 60);
    if ring.iter().all(|&r| r) {
        ring[below(mix(seed, noise::RING, &[4]), 4) as usize] = false;
    }
    ring
}

pub(super) fn lay_out(site: &Site) -> Layout {
    let n = site.n;
    let ring = ring_edges(site.seed);
    let mut mask = vec![0u8; (n * n) as usize];
    for (lines, vertical, first) in [(&site.xs, true, 0), (&site.zs, false, 2)] {
        for (i, &line) in lines.iter().enumerate() {
            let last = i + 1 == lines.len();
            let edge = i == 0 || last;
            if edge && !ring[first + usize::from(last)] {
                continue;
            }
            let flag = if edge { ROAD } else { ROAD | ARTERIAL };
            for k in 0..n {
                let (x, z) = if vertical { (line, k) } else { (k, line) };
                mask[idx(n, x, z)] |= flag;
            }
        }
    }
    let mut splitter = Splitter {
        site,
        mask,
        blocks: Vec::new(),
    };
    let (xl, zl) = (site.xs.len() - 1, site.zs.len() - 1);
    for (i, xw) in site.xs.windows(2).enumerate() {
        for (j, zw) in site.zs.windows(2).enumerate() {
            // Sides without a ring road run to the map edge.
            let open = |at: usize, end: usize, e: usize| at == end && !ring[e];
            let mut bound = 0;
            let mut r = Rect {
                x0: xw[0] + 1,
                z0: zw[0] + 1,
                x1: xw[1],
                z1: zw[1],
            };
            if open(i, 0, 0) {
                r.x0 = 0;
            } else {
                bound |= BOUND_W;
            }
            if open(i + 1, xl, 1) {
                r.x1 = n;
            } else {
                bound |= BOUND_E;
            }
            if open(j, 0, 2) {
                r.z0 = 0;
            } else {
                bound |= BOUND_N;
            }
            if open(j + 1, zl, 3) {
                r.z1 = n;
            } else {
                bound |= BOUND_S;
            }
            splitter.split(r, bound);
        }
    }
    let mut mask = splitter.mask;
    keep_largest(&mut mask, n);
    Layout {
        mask,
        blocks: splitter.blocks,
    }
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Clears every road tile outside the largest connected piece, so the graph
/// is one component. Returns the tiles it cleared.
pub(super) fn keep_largest(mask: &mut [u8], n: i32) -> Vec<usize> {
    let total = (n * n) as usize;
    let mut parent: Vec<usize> = (0..total).collect();
    for z in 0..n {
        for x in 0..n {
            if !is_road(mask, n, x, z) {
                continue;
            }
            for (dx, dz) in [(1, 0), (0, 1)] {
                if is_road(mask, n, x + dx, z + dz) {
                    let (a, b) = (
                        find(&mut parent, idx(n, x, z)),
                        find(&mut parent, idx(n, x + dx, z + dz)),
                    );
                    parent[a.max(b)] = a.min(b);
                }
            }
        }
    }
    let mut size = vec![0u32; total];
    for (i, &m) in mask.iter().enumerate() {
        if m & ROAD != 0 {
            let r = find(&mut parent, i);
            size[r] += 1;
        }
    }
    let Some(best) = (0..total).max_by_key(|&i| (size[i], std::cmp::Reverse(i))) else {
        return Vec::new();
    };
    let mut cleared = Vec::new();
    for (i, m) in mask.iter_mut().enumerate() {
        if *m & ROAD != 0 && find(&mut parent, i) != best {
            *m = 0;
            cleared.push(i);
        }
    }
    cleared
}

/// The road graph read off the tile mask: intersections, bends and dead ends
/// are nodes, and a segment runs straight between two of them.
pub(super) struct Graph {
    pub nodes: Vec<(u16, u16)>,
    pub segments: Vec<Segment>,
    pub adjacency: Vec<Vec<(u32, u32)>>,
    /// Streets are maximal straight runs of road tiles.
    pub street_count: usize,
    node_at: Vec<u32>,
    /// For a tile strictly inside a segment: the segment and the tiles from its start.
    seg_at: Vec<(u32, u16)>,
}

impl Graph {
    /// The segment and offset a lot opens onto when its door is the road tile `(x, z)`.
    pub(super) fn door_at(&self, n: i32, x: i32, z: i32) -> Option<(u32, u16)> {
        let i = idx(n, x, z);
        if self.seg_at[i].0 != u32::MAX {
            return Some(self.seg_at[i]);
        }
        let node = self.node_at[i];
        if node == u32::MAX {
            return None;
        }
        let &(_, seg) = self.adjacency[node as usize].first()?;
        let s = &self.segments[seg as usize];
        Some((seg, if s.a == node { 0 } else { s.length }))
    }
}

pub(super) fn build_graph(mask: &[u8], site: &Site) -> Graph {
    let n = site.n;
    let total = (n * n) as usize;
    let road = |x, z| is_road(mask, n, x, z);
    let mut node_at = vec![u32::MAX; total];
    let mut nodes = Vec::new();
    for z in 0..n {
        for x in 0..n {
            if !road(x, z) {
                continue;
            }
            let m = neighbours(mask, n, x, z);
            if m != NORTH | SOUTH && m != EAST | WEST {
                node_at[idx(n, x, z)] = nodes.len() as u32;
                nodes.push((x as u16, z as u16));
            }
        }
    }

    // Number the straight runs: horizontal first, then vertical.
    let mut hrun = vec![u32::MAX; total];
    let mut vrun = vec![u32::MAX; total];
    let mut runs = 0u32;
    for horizontal in [true, false] {
        let run = if horizontal { &mut hrun } else { &mut vrun };
        for a in 0..n {
            let mut b = 0;
            while b < n {
                let (x, z) = if horizontal { (b, a) } else { (a, b) };
                let (nx, nz) = if horizontal { (x + 1, z) } else { (x, z + 1) };
                if road(x, z) && road(nx, nz) {
                    while b < n
                        && road(
                            if horizontal { b } else { a },
                            if horizontal { a } else { b },
                        )
                    {
                        let (rx, rz) = if horizontal { (b, a) } else { (a, b) };
                        run[idx(n, rx, rz)] = runs;
                        b += 1;
                    }
                    runs += 1;
                } else {
                    b += 1;
                }
            }
        }
    }

    let mut segments = Vec::new();
    let mut adjacency = vec![Vec::new(); nodes.len()];
    let mut seg_at = vec![(u32::MAX, 0u16); total];
    let interior = |lines: &[i32], v: i32| lines[1..lines.len() - 1].contains(&v);
    for a in 0..nodes.len() {
        let (ax, az) = (i32::from(nodes[a].0), i32::from(nodes[a].1));
        for (dx, dz) in [(1, 0), (0, 1)] {
            if !road(ax + dx, az + dz) {
                continue;
            }
            let (mut x, mut z, mut length) = (ax + dx, az + dz, 1u16);
            while node_at[idx(n, x, z)] == u32::MAX {
                x += dx;
                z += dz;
                length += 1;
            }
            let b = node_at[idx(n, x, z)];
            let id = segments.len() as u32;
            for k in 1..length {
                let t = idx(n, ax + dx * i32::from(k), az + dz * i32::from(k));
                seg_at[t] = (id, k);
            }
            let horizontal = dz == 0;
            let avenue = if horizontal {
                interior(&site.zs, az)
            } else {
                interior(&site.xs, ax)
            };
            let class = if avenue {
                SegmentClass::Avenue
            } else {
                SegmentClass::Street
            };
            let start = idx(n, ax, az);
            let street = if horizontal { hrun[start] } else { vrun[start] };
            segments.push(Segment {
                id,
                a: a as u32,
                b,
                class,
                length,
                speed: class.speed(),
                street: street as u16,
            });
            adjacency[a].push((b, id));
            adjacency[b as usize].push((a as u32, id));
        }
    }
    Graph {
        nodes,
        segments,
        adjacency,
        street_count: runs as usize,
        node_at,
        seg_at,
    }
}
