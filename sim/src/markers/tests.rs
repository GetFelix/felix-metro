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

fn loaded(day: u32, stored: Option<&[u8]>) -> Today {
    let mut today = Today::default();
    today.load(day, stored).unwrap();
    today
}

#[test]
fn a_tick_run_again_replaces_what_it_listed_and_rewrites_nothing_that_is_the_same() {
    let mut today = loaded(0, None);
    stored(&mut today, 10, vec![marker(10, 1)]);
    let first = stored(&mut today, 20, vec![marker(20, 2), marker(20, 3)]);
    // The same tick again changes nothing, so nothing is written.
    assert_eq!(
        today.add(20, vec![marker(20, 2), marker(20, 3)]).unwrap(),
        None
    );
    // A different outcome for the tick replaces the earlier one.
    let other = stored(&mut today, 20, vec![marker(20, 9)]);
    assert_eq!(first.markers.len(), 3);
    assert_eq!(
        other.markers.iter().map(|m| m.subject).collect::<Vec<_>>(),
        [1, 9]
    );
}

#[test]
fn a_day_loaded_from_the_log_carries_on() {
    let mut before = loaded(2, None);
    let written = before
        .add(
            2 * TICKS_PER_DAY + 5,
            vec![marker(2 * TICKS_PER_DAY + 5, 9)],
        )
        .unwrap()
        .unwrap();
    let mut after = loaded(2, Some(&written.bytes));
    let next = stored(
        &mut after,
        2 * TICKS_PER_DAY + 40,
        vec![marker(2 * TICKS_PER_DAY + 40, 10)],
    );
    let subjects: Vec<_> = next.markers.iter().map(|m| m.subject).collect();
    assert_eq!(subjects, [9, 10]);
    assert!(Today::default().load(3, Some(&written.bytes)).is_err());
}

#[test]
fn a_full_day_marks_no_more_and_writes_nothing_for_it() {
    let mut today = loaded(0, None);
    for t in 0..MAX_PER_DAY as u32 {
        today.add(t, vec![marker(t, t)]).unwrap();
    }
    for t in [400, 401, 402] {
        assert_eq!(today.add(t, vec![marker(t, 1)]).unwrap(), None);
    }
    let again = today
        .add(100, vec![marker(100, 7)])
        .unwrap()
        .expect("a rerun that changes the list is written");
    let record = MarkersRecord::decode(&again.bytes).unwrap();
    assert!(record.markers.len() <= MAX_PER_DAY);
    assert_eq!(record.markers.last().unwrap().subject, 7);
}

#[test]
fn a_day_not_loaded_is_new() {
    let mut today = Today::default();
    let written = today.add(TICKS_PER_DAY + 3, vec![marker(TICKS_PER_DAY + 3, 4)]);
    let record = MarkersRecord::decode(&written.unwrap().unwrap().bytes).unwrap();
    assert_eq!((record.day, record.markers.len()), (1, 1));
}

#[test]
fn a_tick_without_markers_writes_nothing() {
    let mut today = loaded(0, None);
    assert_eq!(today.add(5, Vec::new()).unwrap(), None);
}
