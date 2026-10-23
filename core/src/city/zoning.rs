//! Where the money is: centres, land value, zones and the shoreline.
//!
//! Everything here is a function of the seed and the arterial lines, never of
//! whether the shoreline is switched on, so the same seed lays out the same
//! city with or without water. The edge that water would use is always
//! reserved: centres, the tower and parks keep clear of it.

use super::{
    noise::{self, below, mix, sub, value_noise},
    roads::{Rect, arterial_lines},
};
use crate::city::Zone;

/// Tiles from the edge that a centre, the tower or a park must clear. The
/// water is at most 6 deep and a lot facing it can flood one tile further.
pub(super) const CLEAR_OF_SHORE: i32 = 8;
/// How far from the edge a park block may start, tried in turn.
pub(super) const PARK_CLEARANCES: [i32; 4] = [7, 5, 3, 0];

pub(super) struct Site {
    pub n: i32,
    pub seed: u64,
    /// The edge water would use: 0 north, 1 east, 2 south, 3 west.
    pub edge: u8,
    /// Whether this seed has water of its own, which also pulls up the value
    /// of land beside it.
    pub has_water: bool,
    /// Arterial columns and rows, the map edges included.
    pub xs: Vec<i32>,
    pub zs: Vec<i32>,
    /// Centre x, z and peak value. The first is the main centre.
    pub centres: Vec<(i32, i32, i32)>,
    industry_edge: u8,
    industry_depth: i32,
    industry_span: (i32, i32),
}

pub(super) fn octagon(dx: i32, dz: i32) -> i32 {
    let (a, b) = (dx.abs(), dz.abs());
    a.max(b) + a.min(b) / 2
}

pub(super) fn edge_distance(edge: u8, n: i32, x: i32, z: i32) -> i32 {
    match edge {
        0 => z,
        1 => n - 1 - x,
        2 => n - 1 - z,
        _ => x,
    }
}

impl Site {
    pub(super) fn new(seed: u64, n: i32, has_water: bool, edge: u8) -> Site {
        let xs = arterial_lines(seed, 0, n);
        let zs = arterial_lines(seed, 1, n);
        let mut site = Site {
            n,
            seed,
            edge,
            has_water,
            xs,
            zs,
            centres: Vec::new(),
            industry_edge: 0,
            industry_depth: (n / 5).max(5),
            industry_span: (0, n),
        };
        site.pick_centres();
        site.pick_industry();
        site
    }

    fn pick_centres(&mut self) {
        let n = self.n;
        let crossings: Vec<(i32, i32)> = self
            .xs
            .iter()
            .flat_map(|&x| self.zs.iter().map(move |&z| (x, z)))
            .filter(|&(x, z)| edge_distance(self.edge, n, x, z) > CLEAR_OF_SHORE)
            .collect();
        let spread = (n / 3).max(1);
        let target = (
            n / 2 + below(mix(self.seed, noise::CENTRE, &[0]), spread) - spread / 2,
            n / 2 + below(mix(self.seed, noise::CENTRE, &[1]), spread) - spread / 2,
        );
        let main = crossings
            .iter()
            .copied()
            .min_by_key(|&(x, z)| (octagon(x - target.0, z - target.1), x, z))
            .unwrap_or(target);
        self.centres.push((main.0, main.1, 255));
        let want = 1 + below(mix(self.seed, noise::CENTRE, &[2]), 2);
        for s in 0..want {
            let apart: Vec<_> = crossings
                .iter()
                .copied()
                .filter(|&(x, z)| {
                    self.centres
                        .iter()
                        .all(|&(cx, cz, _)| octagon(x - cx, z - cz) >= n / 4)
                })
                .collect();
            if apart.is_empty() {
                break;
            }
            let h = mix(self.seed, noise::CENTRE, &[10 + s]);
            let (x, z) = apart[below(h, apart.len() as i32) as usize];
            self.centres.push((x, z, 215));
        }
    }

    fn pick_industry(&mut self) {
        let h = mix(self.seed, noise::SECTOR, &[0]);
        self.industry_edge = if below(sub(h, 1), 2) == 0 {
            self.edge
        } else {
            ((i32::from(self.edge) + 1 + below(sub(h, 2), 3)) % 4) as u8
        };
        let lo = below(sub(h, 3), (self.n / 3).max(1));
        self.industry_span = (lo, lo + self.n / 2 + 2);
    }

    /// How many tiles deep the water is at `t` along its edge, 3 to 6.
    pub(super) fn water_depth(&self, t: i32) -> i32 {
        let at = |i: i32| below(mix(self.seed, noise::SHORE_DEPTH, &[i]), 4);
        let (i, r) = (t.div_euclid(5), t.rem_euclid(5));
        3 + (at(i) * (5 - r) + at(i + 1) * r) / 5
    }

    /// Whether the shoreline puts this tile under water.
    pub(super) fn is_shore_water(&self, x: i32, z: i32) -> bool {
        let t = if self.edge.is_multiple_of(2) { x } else { z };
        edge_distance(self.edge, self.n, x, z) < self.water_depth(t)
    }

    pub(super) fn clear_of_shore(&self, x: i32, z: i32, margin: i32) -> bool {
        edge_distance(self.edge, self.n, x, z) >= margin
    }

    /// Distance in tiles to the nearest interior arterial, or a large number.
    fn arterial_distance(&self, x: i32, z: i32) -> i32 {
        let interior = |lines: &[i32], v: i32| {
            lines[1..lines.len() - 1]
                .iter()
                .map(|&l| (l - v).abs())
                .min()
                .unwrap_or(99)
        };
        interior(&self.xs, x).min(interior(&self.zs, z))
    }

    /// Land value, 0 to 255.
    pub(super) fn value(&self, x: i32, z: i32) -> i32 {
        let n = self.n;
        let mut v = 0;
        for (i, &(cx, cz, peak)) in self.centres.iter().enumerate() {
            let fall = if i == 0 { 425 } else { 600 };
            v = v.max(peak - octagon(x - cx, z - cz) * fall / n);
        }
        v += match self.arterial_distance(x, z) {
            0..=1 => 30,
            2 => 10,
            _ => 0,
        };
        if self.has_water {
            v += (13 - edge_distance(self.edge, n, x, z)).max(0) * 2;
        }
        v += (value_noise(self.seed, noise::VALUE_NOISE, x, z, 8) - 128) * 30 / 128;
        v.clamp(0, 255)
    }

    fn in_industry(&self, x: i32, z: i32) -> bool {
        let e = self.industry_edge;
        let q = edge_distance(e, self.n, x, z);
        let t = if e.is_multiple_of(2) { x } else { z };
        let (lo, hi) = self.industry_span;
        let (from, to) = if e == self.edge {
            (6, 6 + self.industry_depth)
        } else {
            (0, self.industry_depth)
        };
        (from..to).contains(&q) && (lo..hi).contains(&t)
    }

    /// The zone of a block: that of its centre, except that a block whose
    /// corners are worth more than industry allows is not industrial, so a
    /// big block never reaches into the centre.
    pub(super) fn block_zone(&self, r: Rect) -> Zone {
        let (cx, cz) = r.centre();
        let zone = self.zone(cx, cz);
        if zone != Zone::Industrial {
            return zone;
        }
        [
            (r.x0, r.z0),
            (r.x1 - 1, r.z0),
            (r.x0, r.z1 - 1),
            (r.x1 - 1, r.z1 - 1),
        ]
        .into_iter()
        .max_by_key(|&(x, z)| (self.value(x, z), -x, -z))
        .map_or(zone, |(x, z)| self.zone(x, z))
    }

    /// The zone of the land at a tile, never a park (parks are whole blocks).
    pub(super) fn zone(&self, x: i32, z: i32) -> Zone {
        let v = self.value(x, z);
        if v >= 185 {
            Zone::Downtown
        } else if v < 140 && self.in_industry(x, z) {
            Zone::Industrial
        } else if v >= 115 {
            Zone::Commercial
        } else {
            Zone::Suburban
        }
    }
}
