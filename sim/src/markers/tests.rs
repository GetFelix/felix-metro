use felix_metro_core::record::{MARK_ROAD, REFUSED_OCCUPIED, ROAD_CLOSED};

use super::*;

fn command(name: &str, result: u8) -> Event {
    Event::Command {
        principal: 7,
        name: name.into(),
        id: 1,
        result,
    }
}

fn built(lot: u32) -> Event {
    Event::Built {
        lot,
        kind: 4,
        rotation: 0,
    }
}

fn marker(tick: u32, subject: u32) -> Marker {
    Marker {
        tick,
        kind: MARK_BUILT,
        subject,
        what: 4,
        by: "Mara".into(),
    }
}

fn stored(today: &mut Today, tick: u32, new: Vec<Marker>) -> MarkersRecord {
    let marked = today.add(tick, new).unwrap().unwrap();
    MarkersRecord::decode(&marked.bytes).unwrap()
}

#[test]
fn an_applied_change_is_marked_with_who_made_it() {
    let commanded = vec![
        vec![command("Mara", RESULT_APPLIED), built(12)],
        vec![
            command("Bo", RESULT_APPLIED),
            Event::Demolished {
                lot: 30,
                kind: 2,
                rotation: 0,
            },
            command("Cy", RESULT_APPLIED),
            Event::Road {
                segment: 5,
                change: ROAD_CLOSED,
            },
        ],
    ];
    let got = from_commands(100, &commanded);
    let kinds: Vec<_> = got
        .iter()
        .map(|m| (m.kind, m.subject, m.by.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            (MARK_BUILT, 12, "Mara"),
            (MARK_DEMOLISHED, 30, "Bo"),
            (MARK_ROAD, 5, "Cy")
        ]
    );
    assert!(got.iter().all(|m| m.tick == 100));
}

#[test]
fn a_refused_command_and_a_speed_change_leave_no_marker() {
    let commanded = vec![
        vec![
            command("Mara", REFUSED_OCCUPIED),
            command("Bo", RESULT_APPLIED),
            Event::Speed {
                ticks_per_second: 8,
            },
        ],
        Vec::new(),
    ];
    assert!(from_commands(1, &commanded).is_empty());
}

#[test]
fn a_tick_run_again_leaves_the_list_as_it_was() {
    let mut today = Today::load(0, None).unwrap();
    stored(&mut today, 10, vec![marker(10, 1)]);
    let first = stored(&mut today, 20, vec![marker(20, 2), marker(20, 3)]);
    let again = stored(&mut today, 20, vec![marker(20, 2), marker(20, 3)]);
    assert_eq!(first, again);
    assert_eq!(again.markers.len(), 3);
}

#[test]
fn a_day_loaded_from_the_log_carries_on() {
    let mut before = Today::load(2, None).unwrap();
    let written = before
        .add(
            2 * TICKS_PER_DAY + 5,
            vec![marker(2 * TICKS_PER_DAY + 5, 9)],
        )
        .unwrap()
        .unwrap();
    let mut after = Today::load(2, Some(&written.bytes)).unwrap();
    let next = stored(
        &mut after,
        2 * TICKS_PER_DAY + 40,
        vec![marker(2 * TICKS_PER_DAY + 40, 10)],
    );
    let subjects: Vec<_> = next.markers.iter().map(|m| m.subject).collect();
    assert_eq!(subjects, [9, 10]);
    assert!(Today::load(3, Some(&written.bytes)).is_err());
}

#[test]
fn a_day_holds_a_bounded_number() {
    let mut today = Today::load(0, None).unwrap();
    for t in 0..MAX_PER_DAY as u32 + 20 {
        today.add(t, vec![marker(t, t)]).unwrap();
    }
    let full = stored(&mut today, 400, vec![marker(400, 1)]);
    assert_eq!(full.markers.len(), MAX_PER_DAY);
    assert_eq!(full.markers.last().unwrap().tick, 255);
}

#[test]
fn a_tick_without_markers_writes_nothing() {
    let mut today = Today::load(0, None).unwrap();
    assert_eq!(today.add(5, Vec::new()).unwrap(), None);
}
