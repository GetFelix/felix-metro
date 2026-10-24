//! The entity key that puts a district on its own shard.
//!
//! Felix picks a shard by hashing the key, so `d00` to `d03` alone can leave
//! two districts on one shard and another with none. A district's key is
//! `d<NN>`, or `d<NN>.<n>` for the first `n` that routes to shard `NN`. The
//! hash is Felix's (`felix_wire::routing`), copied here so the browser can
//! derive the same keys; the sim tests that the two agree.

/// How a stream maps a key to a shard, as Felix reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Routing {
    Modulo,
    JumpHash,
}

impl Routing {
    /// Felix's wire names: `modulo` and `jump_hash`.
    pub fn from_name(name: &str) -> Option<Routing> {
        match name {
            "modulo" => Some(Routing::Modulo),
            "jump_hash" => Some(Routing::JumpHash),
            _ => None,
        }
    }
}

/// Salts tried before giving up on a district.
const MAX_SALT: u32 = 100_000;

/// The shard `key` routes to on a stream with `shards` shards.
pub fn shard_for(routing: Routing, shards: u32, key: &[u8]) -> u32 {
    if shards <= 1 {
        return 0;
    }
    let hash = finalize(fnv1a(key));
    match routing {
        Routing::Modulo => (hash % u64::from(shards)) as u32,
        Routing::JumpHash => jump_hash(hash, shards),
    }
}

/// The key that routes `district` to shard `district`, or `None` when the
/// stream has no such shard or no key is found.
pub fn district_key(district: u32, shards: u32, routing: Routing) -> Option<String> {
    if district >= shards {
        return None;
    }
    let plain = format!("d{district:02}");
    std::iter::once(plain.clone())
        .chain((0..MAX_SALT).map(|n| format!("{plain}.{n}")))
        .find(|key| shard_for(routing, shards, key.as_bytes()) == district)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn finalize(mut hash: u64) -> u64 {
    hash ^= hash >> 30;
    hash = hash.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    hash ^= hash >> 27;
    hash = hash.wrapping_mul(0x94d0_49bb_1331_11eb);
    hash ^ (hash >> 31)
}

/// Jump consistent hash (Lamping and Veach).
fn jump_hash(mut key: u64, buckets: u32) -> u32 {
    let mut bucket: i64 = -1;
    let mut next: i64 = 0;
    while next < i64::from(buckets) {
        bucket = next;
        key = key.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(1);
        next = ((bucket + 1) as f64 * ((1u64 << 31) as f64 / ((key >> 33) + 1) as f64)) as i64;
    }
    bucket as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_district_lands_on_its_own_shard() {
        for routing in [Routing::Modulo, Routing::JumpHash] {
            for (shards, districts) in [(4, 4), (16, 16), (64, 16), (5, 3)] {
                for district in 0..districts {
                    let key = district_key(district, shards, routing).unwrap();
                    assert!(key.starts_with(&format!("d{district:02}")));
                    assert_eq!(shard_for(routing, shards, key.as_bytes()), district);
                }
            }
        }
    }

    #[test]
    fn a_district_needs_a_shard() {
        assert_eq!(district_key(4, 4, Routing::Modulo), None);
    }

    #[test]
    fn the_two_mappings_need_different_keys() {
        let differs = (0..16).any(|d| {
            district_key(d, 16, Routing::Modulo) != district_key(d, 16, Routing::JumpHash)
        });
        assert!(differs);
    }

    #[test]
    fn names_are_felixs() {
        assert_eq!(Routing::from_name("modulo"), Some(Routing::Modulo));
        assert_eq!(Routing::from_name("jump_hash"), Some(Routing::JumpHash));
        assert_eq!(Routing::from_name("Modulo"), None);
    }
}
