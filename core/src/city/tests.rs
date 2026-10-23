use std::collections::HashSet;

use super::*;
use crate::names::resident_name;

fn city_of(seed: &str, d: u16) -> City {
    City::generate(seed, d).unwrap()
}

fn seeds() -> Vec<String> {
    (0..50).map(|i| format!("seed-{i}")).collect()
}

fn is_middle(lot: &Lot) -> bool {
    (lot.x - 1) % ROAD_SPACING == 1 && (lot.z - 1) % ROAD_SPACING == 1
}

#[test]
fn harbor_hash_is_pinned() {
    assert_eq!(city_of("harbor", 2).hash(), 7_315_211_005_218_244_252);
}

#[test]
fn generation_is_deterministic() {
    let a = city_of("harbor", 2);
    let b = city_of("harbor", 2);
    assert_eq!(a.hash(), b.hash());
    assert_eq!(a.to_json(), b.to_json());
    assert_ne!(a.hash(), city_of("meadow", 2).hash());
}

#[test]
fn seeds_are_restricted() {
    for ok in [
        "harbor",
        "a",
        "x-1",
        "harbor~bridge-closed",
        &"a".repeat(32),
    ] {
        assert!(City::generate(ok, 1).is_ok(), "{ok}");
    }
    for bad in [
        "",
        "Harbor",
        "a b",
        "a_b",
        "~",
        "a~",
        "~a",
        "a~~b",
        "q\"",
        &"a".repeat(33),
    ] {
        assert_eq!(
            City::generate(bad, 1).err(),
            Some(GenerateError::Seed),
            "{bad}"
        );
    }
    assert_eq!(City::generate("a", 0).err(), Some(GenerateError::Districts));
    assert_eq!(
        City::generate("a", 17).err(),
        Some(GenerateError::Districts)
    );
}

#[test]
fn districts_are_twelve_tiles_square() {
    for d in [1, 2, 4] {
        let city = city_of("size", d);
        assert_eq!(city.districts.len(), usize::from(d * d));
        assert_eq!(city.tiles(), 12 * d + 1);
        for lot in &city.lots {
            let (dx, dz) = (lot.x / DISTRICT_TILES, lot.z / DISTRICT_TILES);
            assert_eq!(lot.district, dz * d + dx);
        }
    }
}

#[test]
fn doors_open_onto_the_road_the_lot_faces() {
    for d in [2, 4] {
        for seed in seeds().iter().map(String::as_str).chain(["harbor"]) {
            let city = city_of(seed, d);
            for lot in &city.lots {
                if is_middle(lot) {
                    assert_eq!(lot.door(), None);
                    assert_eq!(lot.facing, 0);
                    assert_eq!(lot.name, None);
                    assert!((38..42).contains(&lot.kind.0), "lot {}", lot.id);
                    continue;
                }
                let door = lot.door().expect("a rim lot has a door");
                let seg = &city.segments[door.segment as usize];
                let (a, b) = (city.nodes[seg.a as usize], city.nodes[seg.b as usize]);
                let (lo, hi) = (a.min(b), a.max(b));
                let (x, z) = (lot.x, lot.z);
                // The segment runs along the road beside the lot, on the side it faces.
                let (along, at, from, line) = match lot.facing {
                    0 => (lo.1 == hi.1, lo.1 == z + 1, lo.0, x),
                    2 => (lo.1 == hi.1, lo.1 + 1 == z, lo.0, x),
                    1 => (lo.0 == hi.0, lo.0 == x + 1, lo.1, z),
                    _ => (lo.0 == hi.0, lo.0 + 1 == x, lo.1, z),
                };
                assert!(along && at, "lot {} door is on the wrong road", lot.id);
                assert!(line > from && line < from + seg.length);
                assert_eq!(door.offset, line - from);
            }
        }
    }
}

#[test]
fn road_graph_is_connected_across_districts() {
    let mut cities = vec![city_of("harbor", 3), city_of("meadow", 3)];
    cities.extend(seeds().iter().map(|s| city_of(s, 2)));
    for city in cities {
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
}

#[test]
fn the_edge_road_beside_the_water_is_left_out() {
    let dry = City::generate("harbor", 2).unwrap();
    let wide = build("harbor", 2, Some(false)).unwrap();
    // One line of 7 intersections and 6 segments is gone.
    assert_eq!(wide.nodes.len() - dry.nodes.len(), 7);
    assert_eq!(wide.segments.len() - dry.segments.len(), 6 + 7);
}

#[test]
fn each_district_has_one_park_block() {
    for d in [2, 4] {
        for seed in seeds().iter().map(String::as_str).chain(["harbor"]) {
            let city = city_of(seed, d);
            for dist in &city.districts {
                let park: Vec<_> = city
                    .lots
                    .iter()
                    .filter(|l| l.district == dist.id && l.zone == Zone::Park)
                    .collect();
                let blocks: HashSet<_> = park
                    .iter()
                    .map(|l| ((l.x - 1) / ROAD_SPACING, (l.z - 1) / ROAD_SPACING))
                    .collect();
                assert_eq!(
                    (park.len(), blocks.len()),
                    (9, 1),
                    "{seed} district {}",
                    dist.id
                );
            }
        }
    }
}

#[test]
fn one_tower_downtown() {
    for d in [2, 4] {
        for seed in seeds().iter().map(String::as_str).chain(["harbor"]) {
            let city = city_of(seed, d);
            let towers: Vec<_> = city
                .lots
                .iter()
                .filter(|l| l.kind == BuildingKind::FELIX_TOWER)
                .collect();
            assert_eq!(towers.len(), 1, "{seed}");
            assert_eq!(towers[0].zone, Zone::Downtown);
            assert!(!is_middle(towers[0]));
            assert_eq!(towers[0].name.as_deref(), Some("Felix Tower"));
        }
    }
}

#[test]
fn shorelines_leave_no_lot_on_water() {
    for d in [2, 4] {
        let mut wet = 0;
        for seed in seeds().iter().map(String::as_str).chain(["harbor"]) {
            let city = city_of(seed, d);
            if city.shore.is_none() {
                assert!(city.water.is_empty());
                continue;
            }
            wet += 1;
            let water: HashSet<_> = city.water.iter().copied().collect();
            assert!(city.lots.iter().all(|l| !water.contains(&(l.x, l.z))));
            let blocks = usize::from(d * 3);
            assert_eq!(city.lots.len(), 9 * blocks * (blocks - 1));
            assert_eq!(water.len(), 9 * blocks + usize::from(city.tiles()));
        }
        assert!(wet > 3 && wet < 51, "{wet} wet seeds");
    }
    assert!(city_of("harbor", 2).shore.is_some());
}

#[test]
fn the_shoreline_changes_only_the_wet_lots() {
    let mut checked = 0;
    for d in [2, 4] {
        for seed in seeds() {
            let wet = city_of(&seed, d);
            if wet.shore.is_none() {
                continue;
            }
            checked += 1;
            let dry = build(&seed, d, Some(false)).unwrap();
            assert_eq!(dry.shore, None);
            let kept: std::collections::HashMap<_, _> =
                wet.lots.iter().map(|l| ((l.x, l.z), l)).collect();
            let water: HashSet<_> = wet.water.iter().copied().collect();
            for lot in &dry.lots {
                match kept.get(&(lot.x, lot.z)) {
                    Some(w) => {
                        assert_eq!(
                            (w.zone, w.kind, w.facing, &w.name, w.district),
                            (lot.zone, lot.kind, lot.facing, &lot.name, lot.district)
                        );
                        assert_eq!(w.door().map(|d| d.offset), lot.door().map(|d| d.offset));
                    }
                    None => assert!(water.contains(&(lot.x, lot.z))),
                }
            }
            for (a, b) in wet.districts.iter().zip(&dry.districts) {
                assert_eq!(a.park, b.park);
            }
            assert_eq!(wet.streets, dry.streets);
        }
    }
    assert!(checked > 3);
}

#[test]
fn kinds_match_their_zone_and_names() {
    let city = city_of("harbor", 2);
    for lot in &city.lots {
        let info = lot.kind.info();
        if is_middle(lot) {
            continue;
        }
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
