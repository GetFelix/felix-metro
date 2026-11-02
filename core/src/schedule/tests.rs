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

/// The quiet night the page shows is planned here, not drawn: the page does not thin walkers. Planned departures
/// stay inside 04:30 to 23:30 for legs of up to an hour (the sim plans a leg at 5 ticks a tile). A departure can still
/// be held back by an unfinished trip, which this does not model.
#[test]
fn nobody_plans_to_set_off_in_the_small_hours() {
    for travel in [0, 60, 150, 240] {
        for archetype in Archetype::ALL {
            for i in 0..400 {
                let mut rng = Rng::new(&format!("r{i}"));
                let anchors = Anchors {
                    home: 1,
                    work: 2,
                    shop: 3,
                    park: 4,
                };
                let s = Schedule::new(archetype, &mut rng, &anchors, |_, _| travel);
                for b in &s.blocks {
                    assert!(
                        (9 * TICKS_PER_HOUR / 2..47 * TICKS_PER_HOUR / 2).contains(&b.leave),
                        "{archetype:?} with legs of {travel} ticks leaves at {}",
                        b.leave
                    );
                }
            }
        }
    }
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
