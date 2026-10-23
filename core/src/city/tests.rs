use std::collections::HashSet;

use super::*;
use crate::names::resident_name;

fn city_of(seed: &str, d: u16) -> City {
    City::generate(seed, d).unwrap()
}

fn seeds() -> Vec<String> {
    (0..50).map(|i| format!("seed-{i}")).collect()
}

/// The tile a lot's door stands on: the segment's first node plus the offset.
fn door_tile(city: &City, door: Door) -> (i32, i32) {
    let seg = &city.segments[door.segment as usize];
    let (a, b) = (city.nodes[seg.a as usize], city.nodes[seg.b as usize]);
    let step = |from: u16, to: u16| (i32::from(to) - i32::from(from)).signum();
    (
        i32::from(a.0) + step(a.0, b.0) * i32::from(door.offset),
        i32::from(a.1) + step(a.1, b.1) * i32::from(door.offset),
    )
}

fn road_set(city: &City) -> HashSet<(u16, u16)> {
    city.roads.iter().map(|r| (r.x, r.z)).collect()
}

fn all_cities() -> Vec<(String, City)> {
    let mut out = Vec::new();
    for d in [2, 4] {
        for seed in seeds()
            .into_iter()
            .chain(["harbor".into(), "pinecrest".into()])
        {
            let city = city_of(&seed, d);
            out.push((format!("{seed} d={d}"), city));
        }
    }
    out
}

#[test]
fn layouts_are_pinned() {
    assert_eq!(city_of("harbor", 2).hash(), 0xe873_9e78_8c6b_1f68);
    assert_eq!(city_of("harbor", 4).hash(), 0x2532_3a3b_faf5_e3f4);
    assert_eq!(city_of("pinecrest", 2).hash(), 0x7aaa_b4ca_618d_a5ba);
    assert_eq!(city_of("pinecrest", 4).hash(), 0xbdf0_3f17_dc8d_526d);
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
fn arterials_are_irregular_and_wide_apart() {
    let mut gaps = HashSet::new();
    for seed in seeds() {
        for axis in [0, 1] {
            let lines = roads::arterial_lines(fnv1a(FNV_OFFSET, seed.as_bytes()), axis, 49);
            assert_eq!((lines[0], lines[lines.len() - 1]), (0, 48));
            for w in lines.windows(2) {
                assert!((7..=18).contains(&(w[1] - w[0])), "{seed}: {lines:?}");
                gaps.insert(w[1] - w[0]);
            }
        }
    }
    assert!(gaps.len() >= 6, "gaps {gaps:?}");
}

#[test]
fn every_lot_beside_a_road_has_a_door_it_faces() {
    for (name, city) in all_cities() {
        let roads = road_set(&city);
        for lot in &city.lots {
            assert!(
                !roads.contains(&(lot.x, lot.z)),
                "{name}: lot {} on a road",
                lot.id
            );
            let (x, z) = (i32::from(lot.x), i32::from(lot.z));
            let beside = [(0, 1), (1, 0), (0, -1), (-1, 0)]
                .iter()
                .any(|&(dx, dz)| roads.contains(&((x + dx) as u16, (z + dz) as u16)));
            match lot.door() {
                None => {
                    assert!(!beside, "{name}: lot {} beside a road has no door", lot.id);
                    assert_eq!((lot.facing, &lot.name), (0, &None));
                    assert!((38..42).contains(&lot.kind.0), "{name}: lot {}", lot.id);
                }
                Some(door) => {
                    let seg = &city.segments[door.segment as usize];
                    assert!(door.offset <= seg.length, "{name}");
                    let (dx, dz) = [(0, 1), (1, 0), (0, -1), (-1, 0)][usize::from(lot.facing)];
                    let tile = door_tile(&city, door);
                    assert_eq!(tile, (x + dx, z + dz), "{name}: lot {} door", lot.id);
                    assert!(roads.contains(&(tile.0 as u16, tile.1 as u16)));
                }
            }
        }
    }
}

#[test]
fn road_graph_is_connected() {
    for (name, city) in all_cities() {
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
        assert_eq!(seen.len(), city.nodes.len(), "{name}");
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
        assert!(city.segments.iter().all(|s| s.length >= 1 && s.speed > 0));
        // Every road tile is on the graph: a node or inside a segment.
        let covered: usize = city.nodes.len()
            + city
                .segments
                .iter()
                .map(|s| usize::from(s.length) - 1)
                .sum::<usize>();
        assert_eq!(covered, city.roads.len(), "{name}");
    }
}

#[test]
fn roads_have_the_piece_their_neighbours_need() {
    let (mut corners, mut ends, mut tees, mut crosses) = (0, 0, 0, 0);
    for (name, city) in all_cities() {
        let roads = road_set(&city);
        for r in &city.roads {
            let (x, z) = (i32::from(r.x), i32::from(r.z));
            let has = |dx: i32, dz: i32| roads.contains(&((x + dx) as u16, (z + dz) as u16));
            let m = u8::from(has(0, -1))
                | u8::from(has(1, 0)) << 1
                | u8::from(has(0, 1)) << 2
                | u8::from(has(-1, 0)) << 3;
            assert_eq!(r.mask, m, "{name}");
            assert_eq!(
                r.piece,
                match m.count_ones() {
                    4 => RoadPiece::Cross,
                    3 => RoadPiece::T,
                    2 if m == 5 || m == 10 => RoadPiece::Straight,
                    2 => RoadPiece::Corner,
                    _ => RoadPiece::End,
                },
                "{name}"
            );
            assert!(r.rot < 4);
            match r.piece {
                RoadPiece::Corner => corners += 1,
                RoadPiece::End => ends += 1,
                RoadPiece::T => tees += 1,
                RoadPiece::Cross => crosses += 1,
                RoadPiece::Straight => {}
            }
        }
    }
    assert!(corners > 0 && ends > 0 && tees > 0 && crosses > 0);
}

#[test]
fn each_district_has_a_park_on_dry_land() {
    for (name, city) in all_cities() {
        for dist in &city.districts {
            let tiles = city
                .lots
                .iter()
                .filter(|l| l.district == dist.id && l.zone == Zone::Park)
                .count();
            assert!(
                tiles >= 1 && dist.park.is_some(),
                "{name} district {}",
                dist.id
            );
        }
    }
}

#[test]
fn one_tower_downtown() {
    for (name, city) in all_cities() {
        let towers: Vec<_> = city
            .lots
            .iter()
            .filter(|l| l.kind == BuildingKind::FELIX_TOWER)
            .collect();
        assert_eq!(towers.len(), 1, "{name}");
        assert_eq!(towers[0].zone, Zone::Downtown);
        assert!(towers[0].door().is_some());
        assert_eq!(towers[0].name.as_deref(), Some("Felix Tower"));
    }
}

#[test]
fn shorelines_leave_no_lot_or_road_on_water() {
    let mut wet = 0;
    for (name, city) in all_cities() {
        if city.shore.is_none() {
            assert!(city.water.is_empty(), "{name}");
            continue;
        }
        wet += 1;
        let water: HashSet<_> = city.water.iter().copied().collect();
        assert!(
            city.lots.iter().all(|l| !water.contains(&(l.x, l.z))),
            "{name}"
        );
        assert!(
            city.roads.iter().all(|r| !water.contains(&(r.x, r.z))),
            "{name}"
        );
        assert!(water.len() > usize::from(city.tiles()) * 3, "{name}");
    }
    assert!(wet > 6 && wet < 100, "{wet} wet cities");
    assert!(city_of("harbor", 2).shore.is_some());
}

#[test]
fn the_shoreline_changes_only_the_wet_area() {
    let mut checked = 0;
    for (name, wet) in all_cities() {
        if wet.shore.is_none() {
            continue;
        }
        checked += 1;
        let seed = &wet.seed;
        let d = wet.districts_per_side;
        let dry = build(seed, d, Some(false)).unwrap();
        assert_eq!(dry.shore, None);
        let kept: std::collections::HashMap<_, _> =
            wet.lots.iter().map(|l| ((l.x, l.z), l)).collect();
        let water: HashSet<_> = wet.water.iter().copied().collect();
        for lot in &dry.lots {
            match kept.get(&(lot.x, lot.z)) {
                Some(w) => {
                    assert_eq!(
                        (w.zone, w.kind, w.facing, &w.name, w.district),
                        (lot.zone, lot.kind, lot.facing, &lot.name, lot.district),
                        "{name}"
                    );
                    if let (Some(a), Some(b)) = (w.door(), lot.door()) {
                        assert_eq!(door_tile(&wet, a), door_tile(&dry, b), "{name}");
                    }
                    assert_eq!(w.door().is_some(), lot.door().is_some(), "{name}");
                }
                None => assert!(water.contains(&(lot.x, lot.z)), "{name}"),
            }
        }
        let dry_roads = road_set(&dry);
        let wet_roads = road_set(&wet);
        assert!(wet_roads.is_subset(&dry_roads), "{name}");
        for r in dry_roads.difference(&wet_roads) {
            assert!(water.contains(r), "{name}: dry road {r:?} gone but not wet");
        }
        for (a, b) in wet.districts.iter().zip(&dry.districts) {
            assert_eq!(a.park, b.park, "{name}");
        }
        assert_eq!(wet.centres, dry.centres, "{name}");
    }
    assert!(checked > 6);
}

#[test]
fn zones_follow_the_centre() {
    let mut downtown = (0i64, 0i64);
    let mut suburban = (0i64, 0i64);
    for (name, city) in all_cities() {
        let (cx, cz) = city.centres[0];
        let n = i32::from(city.tiles());
        for lot in &city.lots {
            let (dx, dz) = (
                i32::from(lot.x) - i32::from(cx),
                i32::from(lot.z) - i32::from(cz),
            );
            let dist = dx.abs().max(dz.abs()) + dx.abs().min(dz.abs()) / 2;
            match lot.zone {
                Zone::Downtown => {
                    downtown.0 += i64::from(dist);
                    downtown.1 += 1;
                }
                Zone::Suburban => {
                    suburban.0 += i64::from(dist);
                    suburban.1 += 1;
                }
                Zone::Industrial => {
                    assert!(
                        dist >= n / 8,
                        "{name}: industry {dist} from the centre of {n}"
                    )
                }
                _ => {}
            }
        }
    }
    assert!(downtown.1 > 0 && suburban.1 > 0);
    assert!(downtown.0 * suburban.1 < suburban.0 * downtown.1 * 2 / 3);
}

#[test]
fn every_zone_appears_and_kinds_match_them() {
    let mut seen = HashSet::new();
    for (name, city) in all_cities() {
        for lot in &city.lots {
            seen.insert(lot.zone as u8);
            if lot.door().is_none() {
                continue;
            }
            let info = lot.kind.info();
            match lot.zone {
                Zone::Suburban => assert_eq!(info.pack, "suburban", "{name}"),
                Zone::Industrial => assert_eq!(info.pack, "industrial", "{name}"),
                Zone::Downtown | Zone::Commercial => assert_eq!(info.pack, "commercial", "{name}"),
                Zone::Park => assert!(info.model.starts_with("tree"), "{name}"),
            }
            let trades = matches!(
                lot.zone,
                Zone::Downtown | Zone::Commercial | Zone::Industrial
            );
            assert_eq!(lot.name.is_some(), trades, "{name}");
        }
        let unique: HashSet<_> = city.streets.iter().collect();
        assert_eq!(unique.len(), city.streets.len(), "{name}");
    }
    assert_eq!(seen.len(), 5);
}

#[test]
fn resident_names_are_stable_and_varied() {
    assert_eq!(resident_name("harbor", 7), resident_name("harbor", 7));
    let names: HashSet<_> = (0..200).map(|i| resident_name("harbor", i)).collect();
    assert!(names.len() > 100);
    assert!(resident_name("harbor", 0).is_ascii());
}
