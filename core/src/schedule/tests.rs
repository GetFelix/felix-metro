use super::*;

fn make(archetype: Archetype, seed: &str) -> Schedule {
    let mut rng = Rng::new(seed);
    let anchors = Anchors {
        home: 1,
        work: 2,
        shop: 3,
        park: 4,
    };
    Schedule::new(archetype, &mut rng, &anchors, |_, _| 60)
}

#[test]
fn every_archetype_leaves_in_order_inside_the_day() {
    for archetype in Archetype::ALL {
        for i in 0..200 {
            let s = make(archetype, &format!("r{i}"));
            assert!(s.blocks.len() >= 2, "{archetype:?}");
            for w in s.blocks.windows(2) {
                assert!(w[0].leave < w[1].leave, "{archetype:?} {:?}", s.blocks);
            }
            assert!(s.blocks.last().unwrap().leave < TICKS_PER_DAY);
        }
    }
}

#[test]
fn times_are_jittered_and_follow_the_archetype() {
    let leaves = |a| -> Vec<u32> {
        (0..50)
            .map(|i| make(a, &format!("r{i}")).blocks[0].leave)
            .collect()
    };
    let office = leaves(Archetype::Office);
    assert!(office.iter().any(|&t| t != office[0]));
    assert!(
        office
            .iter()
            .all(|&t| (6 * TICKS_PER_HOUR..9 * TICKS_PER_HOUR).contains(&t))
    );
    let shift = leaves(Archetype::Shift);
    assert!(shift.iter().all(|&t| t < 7 * TICKS_PER_HOUR));
    let night = make(Archetype::Night, "r0");
    assert_eq!(night.blocks[0].activity, Activity::Work);
    assert!(night.blocks[0].leave < 7 * TICKS_PER_HOUR);
    assert!(night.blocks[1].leave > 19 * TICKS_PER_HOUR);
}

#[test]
fn the_same_seed_gives_the_same_day() {
    for a in Archetype::ALL {
        assert_eq!(make(a, "x").blocks, make(a, "x").blocks);
    }
}

#[test]
fn rolls_cover_every_archetype() {
    let seen: std::collections::HashSet<_> =
        (0..100).map(|r| Archetype::from_roll(r) as u8).collect();
    assert_eq!(seen.len(), Archetype::ALL.len());
}
