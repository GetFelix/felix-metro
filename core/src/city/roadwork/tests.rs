use std::collections::HashSet;

use super::*;
use crate::record::Leg;

fn city_of(seed: &str, d: u16) -> City {
    City::generate(seed, d).unwrap()
}

/// Every pair of nodes in one row or column up to the limit, with what a road between them would do.
type Tiles = Result<Vec<(u16, u16)>, RoadError>;

fn pairs(city: &City) -> Vec<(u32, u32, Tiles)> {
    let mut out = Vec::new();
    for a in 0..city.nodes.len() as u32 {
        for b in 0..city.nodes.len() as u32 {
            let (na, nb) = (city.nodes[a as usize], city.nodes[b as usize]);
            if a != b
                && (na.0 == nb.0 || na.1 == nb.1)
                && na.0.abs_diff(nb.0) + na.1.abs_diff(nb.1) <= 14
            {
                out.push((a, b, city.road_tiles(a, b)));
            }
        }
    }
    out
}

/// Places that a road may be built between, one for each pair (a below b).
fn placeable(city: &City) -> Vec<(u32, u32)> {
    pairs(city)
        .into_iter()
        .filter(|(a, b, r)| a < b && r.is_ok())
        .map(|(a, b, _)| (a, b))
        .collect()
}

/// Two roads whose tiles and neighbours do not meet, so both can be built.
fn two_apart(city: &City) -> ((u32, u32), (u32, u32)) {
    let all = placeable(city);
    let tiles = |&(a, b): &(u32, u32)| -> HashSet<(i32, i32)> {
        let mut t: HashSet<(i32, i32)> = HashSet::new();
        for (x, z) in city.road_tiles(a, b).unwrap() {
            for (dx, dz) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                t.insert((i32::from(x) + dx, i32::from(z) + dz));
            }
        }
        t
    };
    for (i, p) in all.iter().enumerate() {
        let tp = tiles(p);
        for q in &all[i + 1..] {
            let own: HashSet<(u16, u16)> = city.road_tiles(q.0, q.1).unwrap().into_iter().collect();
            if !own
                .iter()
                .any(|&(x, z)| tp.contains(&(i32::from(x), i32::from(z))))
                && p.0 != q.0
                && p.0 != q.1
                && p.1 != q.0
                && p.1 != q.1
            {
                return (*p, *q);
            }
        }
    }
    panic!("no two separate places for a road");
}

/// Every road tile's piece is the one its neighbours ask for, the tiles are in row order, and every node is road.
fn assert_consistent(city: &City) {
    assert!(
        city.roads
            .windows(2)
            .all(|w| (w[0].z, w[0].x) < (w[1].z, w[1].x))
    );
    for r in &city.roads {
        let mut mask = 0;
        for (bit, dx, dz) in [(1u8, 0i32, -1i32), (2, 1, 0), (4, 0, 1), (8, -1, 0)] {
            let (x, z) = (i32::from(r.x) + dx, i32::from(r.z) + dz);
            if x >= 0 && z >= 0 && city.is_road(x as u16, z as u16) {
                mask |= bit;
            }
        }
        assert_eq!(r.mask, mask, "tile {},{}", r.x, r.z);
        assert_eq!((r.piece, r.rot), piece_of(mask));
    }
    for &(x, z) in &city.nodes {
        assert!(city.is_road(x, z));
    }
}

fn connected(city: &City) -> bool {
    let mut seen = vec![false; city.nodes.len()];
    let mut stack = vec![0u32];
    seen[0] = true;
    while let Some(n) = stack.pop() {
        for &(m, _) in &city.adjacency[n as usize] {
            if !seen[m as usize] {
                seen[m as usize] = true;
                stack.push(m);
            }
        }
    }
    seen.iter().all(|&s| s)
}

#[test]
fn a_road_between_two_nodes_adds_a_segment_and_its_tiles() {
    let mut city = city_of("harbor", 2);
    let (a, b) = placeable(&city)[0];
    let before = (city.segments.len(), city.roads.len(), city.hash());
    let tiles = city.road_tiles(a, b).unwrap();
    let id = city.add_road(a, b).unwrap();
    assert_eq!(id as usize, before.0);
    assert_eq!(city.segments.len(), before.0 + 1);
    assert_eq!(city.roads.len(), before.1 + tiles.len());
    let seg = &city.segments[id as usize];
    assert!(seg.built && !seg.removed);
    assert_eq!(seg.length as usize, tiles.len() + 1);
    assert_eq!(seg.class, SegmentClass::Street);
    assert!(city.adjacency[a as usize].contains(&(b, id)));
    assert!(city.adjacency[b as usize].contains(&(a, id)));
    assert_eq!(city.streets[seg.street as usize], "Link Road 1");
    assert_ne!(city.hash(), before.2);
    assert_consistent(&city);
}

#[test]
fn removing_it_puts_the_tiles_back_and_keeps_the_id() {
    let mut city = city_of("harbor", 2);
    let original = city.roads.clone();
    let hash = city.hash();
    let (a, b) = placeable(&city)[0];
    let id = city.add_road(a, b).unwrap();
    let with = city.hash();
    city.remove_road(id).unwrap();
    assert_eq!(city.roads, original);
    assert!(city.segments[id as usize].removed);
    assert!(city.adjacency.iter().flatten().all(|&(_, s)| s != id));
    assert_ne!(city.hash(), with);
    assert_ne!(city.hash(), hash, "the id is spent and the name stays");
    assert_consistent(&city);
    // The next road takes a new id.
    let (c, d) = placeable(&city)[0];
    assert_eq!(city.add_road(c, d).unwrap(), id + 1);
}

#[test]
fn the_same_roads_laid_again_give_the_same_city() {
    let generated = city_of("pinecrest", 2);
    let mut live = generated.clone();
    let (p, q) = two_apart(&generated);
    let first = live.add_road(p.0, p.1).unwrap();
    let second = live.add_road(q.0, q.1).unwrap();
    live.remove_road(first).unwrap();
    // Added again after the first was taken away.
    let third = live.add_road(p.0, p.1).unwrap();
    let list = [
        BuiltRoad {
            segment: first,
            a: p.0,
            b: p.1,
            removed: true,
        },
        BuiltRoad {
            segment: second,
            a: q.0,
            b: q.1,
            removed: false,
        },
        BuiltRoad {
            segment: third,
            a: p.0,
            b: p.1,
            removed: false,
        },
    ];
    let mut restored = generated.clone();
    restored.restore_roads(&list).unwrap();
    assert_eq!(restored.hash(), live.hash());
    assert_eq!(restored.roads, live.roads);
    assert_eq!(restored.adjacency, live.adjacency);
    assert_eq!(restored.streets, live.streets);
    assert_eq!(restored.roads_json(), live.roads_json());
    assert_eq!(restored.to_json(), live.to_json());
}

#[test]
fn a_skipped_id_is_held_by_a_removed_placeholder() {
    let generated = city_of("harbor", 2);
    let (a, b) = placeable(&generated)[0];
    let next = generated.segments.len() as u32;
    let mut city = generated.clone();
    city.restore_roads(&[BuiltRoad {
        segment: next + 2,
        a,
        b,
        removed: false,
    }])
    .unwrap();
    assert_eq!(city.segments.len(), next as usize + 3);
    assert!(city.segments[next as usize].removed && city.segments[next as usize + 1].removed);
    assert!(!city.segments[next as usize + 2].removed);
    assert_consistent(&city);
    assert_eq!(
        city.restore_roads(&[]),
        Err(RoadError::Order),
        "roads cannot be laid on a city that has some"
    );
}

#[test]
fn roads_out_of_order_are_refused() {
    let mut city = city_of("harbor", 2);
    let (a, b) = placeable(&city)[0];
    let next = city.segments.len() as u32;
    let road = |segment| BuiltRoad {
        segment,
        a,
        b,
        removed: true,
    };
    assert_eq!(
        city.restore_roads(&[road(next + 1), road(next)]),
        Err(RoadError::Order)
    );
}

#[test]
fn a_logged_road_is_laid_only_at_the_next_id() {
    let generated = city_of("harbor", 2);
    let (a, b) = placeable(&generated)[0];
    let next = generated.segments.len() as u32;
    let mut city = generated.clone();
    assert_eq!(city.lay_road(next + 1, a, b), Err(RoadError::Order));
    assert_eq!(city.lay_road(next, a, a), Err(RoadError::NotInLine));
    assert_eq!(city.segments.len(), next as usize);
    city.lay_road(next, a, b).unwrap();
    let mut added = generated.clone();
    added.add_road(a, b).unwrap();
    assert_eq!(city.hash(), added.hash());
    assert_eq!(city.lay_road(next, a, b), Err(RoadError::Order));
}

#[test]
fn every_way_a_road_can_be_refused_happens_on_some_pair() {
    let mut seen = HashSet::new();
    for seed in ["harbor", "pinecrest", "seed-3", "seed-7"] {
        let city = city_of(seed, 2);
        for (_, _, result) in pairs(&city) {
            if let Err(e) = result {
                seen.insert(e);
            }
        }
        let n = city.nodes.len() as u32;
        assert_eq!(city.road_tiles(n, 0), Err(RoadError::UnknownNode));
        assert_eq!(city.road_tiles(0, 0), Err(RoadError::NotInLine));
    }
    for e in [
        RoadError::NotInLine,
        RoadError::TooLong,
        RoadError::Joined,
        RoadError::Blocked,
    ] {
        assert!(
            seen.contains(&e) || e == RoadError::NotInLine,
            "{e:?} never happened"
        );
    }
}

#[test]
fn a_diagonal_pair_is_not_in_line() {
    let city = city_of("harbor", 2);
    let (a, b) = (0..city.nodes.len() as u32)
        .flat_map(|a| (0..city.nodes.len() as u32).map(move |b| (a, b)))
        .find(|&(a, b)| {
            city.nodes[a as usize].0 != city.nodes[b as usize].0
                && city.nodes[a as usize].1 != city.nodes[b as usize].1
        })
        .unwrap();
    assert_eq!(city.road_tiles(a, b), Err(RoadError::NotInLine));
}

#[test]
fn a_road_longer_than_the_limit_is_refused() {
    let city = city_of("harbor", 2);
    let far = pairs(&city)
        .into_iter()
        .find(|(a, b, _)| {
            let (na, nb) = (city.nodes[*a as usize], city.nodes[*b as usize]);
            na.0.abs_diff(nb.0) + na.1.abs_diff(nb.1) > MAX_ROAD_LENGTH
        })
        .expect("a pair further apart than the limit");
    assert_eq!(far.2, Err(RoadError::TooLong));
}

#[test]
fn nodes_a_segment_joins_cannot_be_joined_again() {
    let city = city_of("harbor", 2);
    let (a, &(b, _)) = (0, city.adjacency[0].first().unwrap());
    assert_eq!(city.road_tiles(a, b), Err(RoadError::Joined));
}

#[test]
fn a_road_cannot_cross_or_run_beside_another() {
    let mut city = city_of("pinecrest", 2);
    // Nodes along one generated road have road between them: blocked, not joined.
    let across = pairs(&city)
        .into_iter()
        .find(|(a, b, r)| a < b && *r == Err(RoadError::Blocked))
        .expect("a blocked pair");
    assert!(city.add_road(across.0, across.1).is_err());
    // A built road's own tiles block a second one that would touch it.
    let (a, b) = placeable(&city)[0];
    let tiles = city.road_tiles(a, b).unwrap();
    city.add_road(a, b).unwrap();
    for (_, _, r) in pairs(&city) {
        if let Ok(t) = r {
            assert!(
                t.iter().all(|x| !tiles.contains(x)),
                "a new road may not reuse a built tile"
            );
        }
    }
    assert_eq!(city.road_tiles(a, b), Err(RoadError::Joined));
}

#[test]
fn only_a_built_segment_can_be_removed_and_only_once() {
    let mut city = city_of("harbor", 2);
    assert_eq!(city.remove_road(0), Err(RoadError::NotBuilt));
    assert_eq!(
        city.remove_road(city.segments.len() as u32),
        Err(RoadError::UnknownSegment)
    );
    let (a, b) = placeable(&city)[0];
    let id = city.add_road(a, b).unwrap();
    city.remove_road(id).unwrap();
    assert_eq!(city.remove_road(id), Err(RoadError::NotBuilt));
}

#[test]
fn the_graph_stays_connected_whatever_is_built_and_removed() {
    let mut city = city_of("pinecrest", 2);
    let mut built = Vec::new();
    for _ in 0..6 {
        let Some(&(a, b)) = placeable(&city).first() else {
            break;
        };
        built.push(city.add_road(a, b).unwrap());
        assert!(connected(&city));
        assert_consistent(&city);
    }
    assert!(built.len() >= 2);
    for id in built {
        city.remove_road(id).unwrap();
        assert!(connected(&city));
        assert_consistent(&city);
    }
}

#[test]
fn a_built_road_joins_a_dead_end_and_the_pieces_follow() {
    let mut city = city_of("harbor", 2);
    let before: Vec<_> = city.roads.clone();
    let (a, b) = placeable(&city)[0];
    city.add_road(a, b).unwrap();
    for end in [a, b] {
        let (x, z) = city.nodes[end as usize];
        let tile = city.roads.iter().find(|r| (r.x, r.z) == (x, z)).unwrap();
        let was = before.iter().find(|r| (r.x, r.z) == (x, z)).unwrap();
        assert_eq!(tile.mask.count_ones(), was.mask.count_ones() + 1);
    }
}

#[test]
fn a_node_door_is_on_a_generated_segment_even_after_roads_are_built() {
    let mut city = city_of("harbor", 2);
    let (a, b) = placeable(&city)[0];
    let before = (city.node_door(a), city.node_door(b));
    city.add_road(a, b).unwrap();
    assert_eq!((city.node_door(a), city.node_door(b)), before);
    assert!(!city.segments[before.0.segment as usize].built);
    let at = city.node_door(a);
    let seg = &city.segments[at.segment as usize];
    assert_eq!(at.offset, if seg.a == a { 0 } else { seg.length });
}

#[test]
fn a_route_can_use_a_built_road_and_the_page_resolves_it() {
    let mut city = city_of("harbor", 2);
    let (a, b) = placeable(&city)[0];
    let id = city.add_road(a, b).unwrap();
    let (door_a, door_b) = (city.node_door(a), city.node_door(b));
    let trip = crate::route(&city, door_a, door_b, 0, &crate::Congestion::FREE);
    let trip = trip.expect("the nodes are connected");
    // Whatever route it chose resolves again from its legs alone.
    let legs: Vec<Leg> = trip.legs();
    let again = crate::Trip::from_route(&city, door_a, door_b, 0, &legs, trip.mode).unwrap();
    assert_eq!(again.legs(), legs);
    assert_eq!(again.arrive(), trip.arrive());
    // The built segment is the shortest way: no road ran straight between the nodes before.
    assert!(
        legs.iter().any(|l| l.segment == id),
        "{legs:?} avoids segment {id}"
    );
}
