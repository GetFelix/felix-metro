use std::collections::HashSet;

use super::*;

fn is_road(v: u16, size: u16) -> bool {
    v.is_multiple_of(ROAD_SPACING) && v < size
}

#[test]
fn harbor_hash_is_pinned() {
    assert_eq!(
        City::generate("harbor", 2).hash(),
        9_440_593_595_394_363_990
    );
}

#[test]
fn generation_is_deterministic() {
    let a = City::generate("harbor", 2);
    let b = City::generate("harbor", 2);
    assert_eq!(a.hash(), b.hash());
    assert_eq!(a.to_json(), b.to_json());
    assert_ne!(a.hash(), City::generate("meadow", 2).hash());
}

#[test]
fn districts_are_twelve_tiles_square() {
    for d in [1, 2, 4] {
        let city = City::generate("size", d);
        assert_eq!(city.districts.len(), usize::from(d * d));
        assert_eq!(city.tiles(), 12 * d + 1);
        for lot in &city.lots {
            let (dx, dz) = (lot.x / DISTRICT_TILES, lot.z / DISTRICT_TILES);
            assert_eq!(lot.district, dz * d + dx);
        }
    }
}

#[test]
fn every_lot_sits_in_a_block_ringed_by_roads_and_faces_one() {
    for seed in ["harbor", "a", "b", "c", "d"] {
        let city = City::generate(seed, 2);
        let size = city.tiles();
        for lot in &city.lots {
            let (ix, iz) = ((lot.x - 1) % ROAD_SPACING, (lot.z - 1) % ROAD_SPACING);
            assert!(ix < 3 && iz < 3, "lot {} is on a road", lot.id);
            let (west, east) = (is_road(lot.x - 1, size), is_road(lot.x + 1, size));
            let (north, south) = (is_road(lot.z - 1, size), is_road(lot.z + 1, size));
            assert!(
                west || east || north || south || (ix == 1 && iz == 1),
                "lot {} touches no road",
                lot.id
            );
            if !(ix == 1 && iz == 1) {
                let faced = match lot.facing {
                    0 => south,
                    1 => east,
                    2 => north,
                    _ => west,
                };
                assert!(faced, "lot {} faces away from the road", lot.id);
            }
        }
    }
}

#[test]
fn road_graph_is_connected_across_districts() {
    let city = City::generate("harbor", 3);
    let mut seen = HashSet::from([0u32]);
    let mut todo = vec![0u32];
    while let Some(n) = todo.pop() {
        for &(next, seg) in &city.adjacency[n as usize] {
            let s = &city.segments[seg as usize];
            assert!(s.a == n || s.b == n);
            if seen.insert(next) {
                todo.push(next);
            }
        }
    }
    assert_eq!(seen.len(), city.nodes.len());
    assert!(
        city.segments
            .iter()
            .any(|s| s.class == SegmentClass::Avenue)
    );
    assert!(
        city.segments
            .iter()
            .any(|s| s.class == SegmentClass::Street)
    );
    assert!(city.segments.iter().all(|s| s.length == 4 && s.speed > 0));
}

#[test]
fn each_district_has_one_park_block() {
    let city = City::generate("harbor", 2);
    for dist in &city.districts {
        let parks: HashSet<(u16, u16)> = city
            .lots
            .iter()
            .filter(|l| l.district == dist.id && l.zone == Zone::Park)
            .map(|l| ((l.x - 1) / ROAD_SPACING, (l.z - 1) / ROAD_SPACING))
            .collect();
        assert_eq!(parks.len(), 1, "district {}", dist.id);
        let lots = city
            .lots
            .iter()
            .filter(|l| l.district == dist.id && l.zone == Zone::Park)
            .count();
        assert_eq!(lots, 9);
    }
}

#[test]
fn one_tower_downtown() {
    for seed in ["harbor", "x", "y", "z"] {
        for d in [1, 2, 3] {
            let city = City::generate(seed, d);
            let towers: Vec<_> = city
                .lots
                .iter()
                .filter(|l| l.kind == BuildingKind::FELIX_TOWER)
                .collect();
            assert_eq!(towers.len(), 1);
            assert_eq!(towers[0].zone, Zone::Downtown);
            assert_eq!(towers[0].name.as_deref(), Some("Felix Tower"));
        }
    }
}

#[test]
fn harbor_has_water_and_no_lot_on_it() {
    let city = City::generate("harbor", 2);
    assert!(city.shore.is_some());
    assert!(!city.water.is_empty());
    let water: HashSet<_> = city.water.iter().copied().collect();
    assert!(city.lots.iter().all(|l| !water.contains(&(l.x, l.z))));
    // 4 blocks of 9 tiles along one edge of a 6-block side, plus nothing else.
    assert_eq!(water.len(), 6 * 9);
    assert_eq!(city.lots.len() + water.len(), 36 * 9);
}

#[test]
fn some_seeds_are_dry() {
    let wet = (0..40)
        .filter(|i| City::generate(&format!("seed-{i}"), 2).shore.is_some())
        .count();
    assert!((1..40).contains(&wet));
}

#[test]
fn kinds_match_their_zone_and_names() {
    let city = City::generate("harbor", 2);
    for lot in &city.lots {
        let info = lot.kind.info();
        match lot.zone {
            Zone::Suburban => assert_eq!(info.pack, "suburban"),
            Zone::Industrial => assert_eq!(info.pack, "industrial"),
            Zone::Downtown | Zone::Commercial => assert_eq!(info.pack, "commercial"),
            Zone::Park => assert!(info.model.starts_with("tree")),
        }
        let trades = matches!(
            lot.zone,
            Zone::Downtown | Zone::Commercial | Zone::Industrial
        );
        assert_eq!(lot.name.is_some(), trades);
    }
    let unique: HashSet<_> = city.streets.iter().collect();
    assert_eq!(unique.len(), city.streets.len());
}

#[test]
fn resident_names_are_stable_and_varied() {
    assert_eq!(resident_name("harbor", 7), resident_name("harbor", 7));
    let names: HashSet<_> = (0..200).map(|i| resident_name("harbor", i)).collect();
    assert!(names.len() > 100);
    assert!(resident_name("harbor", 0).is_ascii());
}

use crate::names::resident_name;
