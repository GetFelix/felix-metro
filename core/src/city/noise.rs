//! Stateless hashing. Every random choice in the layout is `mix(seed, stage,
//! key)`, so a choice depends only on where it is made, never on what was
//! drawn before it.

pub(super) const SHORE: u64 = 1;
pub(super) const SHORE_DEPTH: u64 = 2;
pub(super) const ARTERIAL: u64 = 3;
pub(super) const CENTRE: u64 = 4;
pub(super) const VALUE_NOISE: u64 = 5;
pub(super) const SECTOR: u64 = 6;
pub(super) const BLOCK: u64 = 7;
pub(super) const PARK: u64 = 8;
pub(super) const LOT: u64 = 9;
pub(super) const NAME: u64 = 10;
pub(super) const STREETS: u64 = 11;

const GAMMA: u64 = 0x9e37_79b9_7f4a_7c15;

fn splitmix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A 64-bit hash of a seed, a stage and up to a few integers.
pub(super) fn mix(seed: u64, stage: u64, key: &[i32]) -> u64 {
    let mut z = splitmix(seed ^ stage.wrapping_mul(GAMMA));
    for &v in key {
        z = splitmix(z.wrapping_add(u64::from(v as u32)).wrapping_add(GAMMA));
    }
    z
}

/// A second, independent value drawn from the same hash.
pub(super) fn sub(h: u64, k: u64) -> u64 {
    splitmix(h.wrapping_add(k.wrapping_mul(GAMMA)))
}

/// A value in `0..n`; `n` must be positive.
pub(super) fn below(h: u64, n: i32) -> i32 {
    ((u128::from(h) * n as u128) >> 64) as i32
}

/// Smooth integer noise in `0..=255`, one lattice point every `spacing` tiles.
pub(super) fn value_noise(seed: u64, stage: u64, x: i32, z: i32, spacing: i32) -> i32 {
    let (i, fx) = (x.div_euclid(spacing), x.rem_euclid(spacing));
    let (j, fz) = (z.div_euclid(spacing), z.rem_euclid(spacing));
    let at = |i: i32, j: i32| below(mix(seed, stage, &[i, j]), 256);
    let top = at(i, j) * (spacing - fx) + at(i + 1, j) * fx;
    let bottom = at(i, j + 1) * (spacing - fx) + at(i + 1, j + 1) * fx;
    (top * (spacing - fz) + bottom * fz) / (spacing * spacing)
}
