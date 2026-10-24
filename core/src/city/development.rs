//! The development area: one cluster of lots per city that starts empty and that residents never use, so a
//! builder has bare ground to raise buildings on. The sim refuses changes to lots residents go to.

use super::{
    Lot, Zone,
    noise::{self, below, mix},
};
use crate::kinds::BuildingKind;

/// Lots in the area: a window holding fewer than `MIN` is not used unless nothing else fits, and one holding
/// more than `MAX` keeps the lots nearest its middle.
const MIN: usize = 14;
const MAX: usize = 16;
/// Window sizes tried, in tiles. They are wide enough to span a street or two, since blocks are small.
const WINDOWS: [(i32, i32); 8] = [
    (5, 5),
    (6, 5),
    (5, 6),
    (6, 6),
    (7, 5),
    (5, 7),
    (7, 6),
    (6, 7),
];

/// Picks the area and returns its lot ids in ascending order. Only lots with a door count (a building needs a
/// street to face), never the tower or park land, and the whole window lies in one district. Windows with more
/// suburban lots win, then a hash of the seed and place breaks ties, so the choice depends on the seed alone.
pub(super) fn pick(seed: u64, n: i32, d: i32, lots: &[Lot]) -> Vec<u32> {
    let mut at = vec![u32::MAX; (n * n) as usize];
    for l in lots {
        let ok = l.door().is_some() && l.zone != Zone::Park && l.kind != BuildingKind::FELIX_TOWER;
        if ok {
            at[(i32::from(l.z) * n + i32::from(l.x)) as usize] = l.id;
        }
    }
    let district = |x: i32, z: i32| ((z / 12).min(d - 1), (x / 12).min(d - 1));
    let mut best: Option<((usize, usize, u64), [i32; 4])> = None;
    let target = lots.len() / 12;
    let (min, max) = (MIN.min(target.max(1)), MAX);
    for &(w, h) in &WINDOWS {
        for z in 0..=n - h {
            for x in 0..=n - w {
                if district(x, z) != district(x + w - 1, z + h - 1) {
                    continue;
                }
                let (mut count, mut suburban) = (0, 0);
                for zz in z..z + h {
                    for xx in x..x + w {
                        let id = at[(zz * n + xx) as usize];
                        if id != u32::MAX {
                            count += 1;
                            suburban += usize::from(lots[id as usize].zone == Zone::Suburban);
                        }
                    }
                }
                if count < min {
                    continue;
                }
                let over = count.saturating_sub(max);
                let key = (
                    over,
                    count - suburban,
                    mix(seed, noise::DEVELOPMENT, &[x, z, w, h]),
                );
                if best.is_none_or(|(k, ..)| key < k) {
                    best = Some((key, [x, z, w, h]));
                }
            }
        }
    }
    let Some((_, [x, z, w, h])) = best else {
        return Vec::new();
    };
    let mut found: Vec<u32> = (z..z + h)
        .flat_map(|zz| (x..x + w).map(move |xx| (xx, zz)))
        .filter_map(|(xx, zz)| Some(at[(zz * n + xx) as usize]).filter(|&id| id != u32::MAX))
        .collect();
    if found.len() > max {
        // Twice the window's middle, to keep to integers.
        let (mx, mz) = (2 * x + w - 1, 2 * z + h - 1);
        let far = |id: &u32| {
            let l = &lots[*id as usize];
            let (dx, dz) = (2 * i32::from(l.x) - mx, 2 * i32::from(l.z) - mz);
            (dx * dx + dz * dz, *id)
        };
        found.sort_by_key(far);
        found.truncate(max);
    }
    found.sort_unstable();
    found
}

/// Empties the area's lots: a tree kind, the generator's filler. The browser draws these as bare ground.
pub(super) fn clear(seed: u64, lots: &mut [Lot], area: &[u32]) {
    for &id in area {
        let l = &mut lots[id as usize];
        let h = mix(seed, noise::DEVELOPMENT, &[i32::from(l.x), i32::from(l.z)]);
        l.kind = BuildingKind(
            BuildingKind::TREE_FIRST + below(h, BuildingKind::TREE_COUNT as i32) as u8,
        );
        l.name = None;
    }
}
