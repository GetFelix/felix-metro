//! A city forked from another's history.

use felix_metro_core::City;
use felix_metro_core::record::{
    Command, Event, REFUSED_FORK_EXISTS, REFUSED_FORK_NAME, REFUSED_FORK_TICK,
    REFUSED_FORK_TOO_DEEP, REFUSED_UNSUPPORTED, RESULT_APPLIED, TickRecord, principal_hash,
};
use tokio::sync::mpsc::{self, UnboundedReceiver};

use super::resumed::{command_events, killed, quick, records};
use super::*;
use crate::commands::tests::city as harbor;
use crate::fork::{Forks, Request, copy_history, is_final};

fn fork_city() -> City {
    City::generate("harbor~a", 2).unwrap()
}

fn retry() -> Retry {
    Retry::of(&quick(0))
}

/// The records with the command stream position and the wall clock zeroed: the two things a fork writes
/// differently from its parent.
fn same_world(log: &Memory) -> Vec<Vec<TickRecord>> {
    let mut all = records(log);
    for record in all.iter_mut().flatten() {
        for event in &mut record.events {
            if let Event::CommandCursor { next } = event {
                *next = 0;
            }
        }
    }
    all
}

fn build(lot: u32, kind: u16) -> Command {
    Command::Build {
        lot,
        kind,
        rotation: 0,
    }
}

/// `n` lots a builder can build on.
fn free_lots(n: usize) -> Vec<u32> {
    let world = World::new(harbor());
    let lots: Vec<u32> = (0..world.city.lots.len() as u32)
        .filter(|&lot| {
            !world.in_use.contains(&lot)
                && world.building(lot).is_some_and(|(k, _)| {
                    k >= u16::from(felix_metro_core::BuildingKind::TREE_FIRST)
                })
        })
        .take(n)
        .collect();
    assert_eq!(lots.len(), n);
    lots
}

fn built(log: &Memory, lot: u32) -> bool {
    (0..4).any(|d| {
        log.records(d).iter().any(|r| {
            r.events
                .iter()
                .any(|e| matches!(e, Event::Built { lot: l, .. } if *l == lot))
        })
    })
}

fn keyframe_lists(log: &Memory, tick: usize, lot: u32) -> bool {
    (0..4).any(|d| {
        log.records(d)[tick]
            .keyframe
            .as_ref()
            .is_some_and(|k| k.buildings.iter().any(|b| b.lot == lot))
    })
}

/// A parent that built one lot before tick 500 and another at tick 600.
async fn parent() -> (Memory, u32, u32) {
    let [early, late] = free_lots(2)[..] else {
        unreachable!()
    };
    let log = Memory::healthy();
    let (send, inbox) = mpsc::channel(8);
    send.try_send(log.publish("mayor", 1, build(early, 4)))
        .unwrap();
    run_city_with("harbor", harbor(), quick(600), log.clone(), Some(inbox))
        .await
        .unwrap();
    let history = load_history(&log, 4, &quick(0)).await.unwrap();
    let (send, inbox) = mpsc::channel(8);
    send.try_send(log.publish("mayor", 2, build(late, 6)))
        .unwrap();
    run_with_history(
        "harbor",
        harbor(),
        quick(1000),
        log.clone(),
        Some(inbox),
        history,
    )
    .await
    .unwrap();
    (log, early, late)
}

#[tokio::test(start_paused = true)]
async fn a_fork_has_the_world_its_parent_had_at_the_fork_tick_and_steps_on_the_same() {
    let (parent, early, late) = parent().await;
    let fork = Memory::healthy();
    copy_history(&parent, &fork, 4, 500, retry()).await.unwrap();
    for district in 0..4 {
        assert_eq!(fork.records(district).len(), 501, "district {district}");
    }

    // Opened like a restart. Until the parent's second build (tick 600) the two cities are the same.
    run_city("harbor~a", fork_city(), quick(600), fork.clone())
        .await
        .unwrap();
    let (parent_records, fork_records) = (same_world(&parent), same_world(&fork));
    for district in 0..4 {
        assert_eq!(
            parent_records[district][..600],
            fork_records[district][..600],
            "district {district}"
        );
    }
    // The build before the fork tick is in the fork; the later one is not, and never will be.
    run_city("harbor~a", fork_city(), quick(1000), fork.clone())
        .await
        .unwrap();
    assert!(keyframe_lists(&fork, 720, early));
    assert!(!keyframe_lists(&fork, 720, late));
    assert!(keyframe_lists(&parent, 720, late));
    assert!(!built(&fork, late));
}

#[tokio::test(start_paused = true)]
async fn what_happens_in_a_fork_stays_out_of_its_parent_and_the_other_way_round() {
    let (parent_log, _, _) = parent().await;
    let before: Vec<_> = records(&parent_log);
    let fork = Memory::healthy();
    copy_history(&parent_log, &fork, 4, 500, retry())
        .await
        .unwrap();
    let other = free_lots(3)[2];
    let history = load_history(&fork, 4, &quick(0)).await.unwrap();
    assert_eq!(history.as_ref().unwrap().commands_from(), Some(0));
    let (send, inbox) = mpsc::channel(8);
    send.try_send(fork.publish("builder", 7, build(other, 5)))
        .unwrap();
    run_with_history(
        "harbor~a",
        fork_city(),
        quick(800),
        fork.clone(),
        Some(inbox),
        history,
    )
    .await
    .unwrap();
    assert!(built(&fork, other));
    assert!(!built(&parent_log, other));
    assert_eq!(records(&parent_log), before);
    // The parent's build is part of the history the fork keeps, with who made it.
    assert_eq!(
        command_events(&fork),
        vec![(0, 1, RESULT_APPLIED), (501, 7, RESULT_APPLIED)]
    );
}

#[tokio::test(start_paused = true)]
async fn the_copy_points_the_fork_at_the_start_of_its_own_command_stream() {
    let (parent, _, _) = parent().await;
    let fork = Memory::healthy();
    copy_history(&parent, &fork, 4, 700, retry()).await.unwrap();
    let cursors = |log: &Memory| -> Vec<u64> {
        log.records(0)
            .iter()
            .flat_map(|r| r.events.iter())
            .filter_map(|e| match e {
                Event::CommandCursor { next } => Some(*next),
                _ => None,
            })
            .collect()
    };
    assert!(
        cursors(&parent).iter().any(|&n| n > 0),
        "the parent read commands"
    );
    assert!(!cursors(&fork).is_empty());
    assert!(cursors(&fork).iter().all(|&n| n == 0));
}

#[tokio::test(start_paused = true)]
async fn a_copy_that_stopped_is_finished_and_a_finished_one_writes_nothing() {
    let (parent, _, _) = parent().await;
    let straight = Memory::healthy();
    copy_history(&parent, &straight, 4, 700, retry())
        .await
        .unwrap();

    let fork = Memory::healthy();
    copy_history(&parent, &fork, 4, 300, retry()).await.unwrap();
    // One district got further than the others.
    let more: Vec<Vec<u8>> = straight.records(1)[301..420]
        .iter()
        .map(|r| r.encode().unwrap())
        .collect();
    fork.shards
        .lock()
        .unwrap()
        .get_mut(&1)
        .unwrap()
        .extend(more);
    copy_history(&parent, &fork, 4, 700, retry()).await.unwrap();
    assert_eq!(records(&fork), records(&straight));
    let sent: u32 = fork.sends.lock().unwrap().values().sum();
    copy_history(&parent, &fork, 4, 700, retry()).await.unwrap();
    assert_eq!(fork.sends.lock().unwrap().values().sum::<u32>(), sent);
    assert_eq!(
        fork.keyframes.lock().unwrap().get(&0),
        straight.keyframes.lock().unwrap().get(&0)
    );
}

#[tokio::test(start_paused = true)]
async fn a_fork_log_that_holds_more_than_the_fork_tick_is_refused_for_good() {
    let (parent, _, _) = parent().await;
    let fork = Memory::healthy();
    copy_history(&parent, &fork, 4, 700, retry()).await.unwrap();
    let err = copy_history(&parent, &fork, 4, 500, retry())
        .await
        .unwrap_err();
    assert!(is_final(&err), "{err:#}");
    // So is a tick the parent never reached.
    let err = copy_history(&parent, &Memory::healthy(), 4, 5000, retry())
        .await
        .unwrap_err();
    assert!(is_final(&err), "{err:#}");
}

fn forking(taken: &[&str]) -> (Forks, UnboundedReceiver<Request>) {
    Forks::new(taken.iter().map(|s| s.to_string()))
}

fn fork_command(log: &Memory, id: u32, tick: u32, name: &str) -> Incoming {
    log.publish(
        "mayor",
        id,
        Command::Fork {
            tick,
            name: name.into(),
        },
    )
}

/// Runs `name` to tick 300 over `log` with the commands in `commands`.
async fn run_forking(name: &str, log: &Memory, forks: Option<Forks>, commands: Vec<Incoming>) {
    // A fork keeps ticks that happened, so the city has to have run first.
    if log.records(0).is_empty() {
        run_city(name, harbor(), quick(50), log.clone())
            .await
            .unwrap();
    }
    let (send, inbox) = mpsc::channel(32);
    for command in commands {
        send.try_send(command).unwrap();
    }
    let history = load_history(log, 4, &quick(0)).await.unwrap();
    let mut settings = quick(300);
    settings.forks = forks;
    run_with_history(name, harbor(), settings, log.clone(), Some(inbox), history)
        .await
        .unwrap();
}

fn results(log: &Memory) -> Vec<(u32, u8)> {
    command_events(log)
        .into_iter()
        .map(|(_, id, result)| (id, result))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_fork_command_is_recorded_once_and_handed_over() {
    let log = Memory::healthy();
    let (forks, mut requests) = forking(&["harbor~taken"]);
    let long = "x".repeat(32);
    let commands = vec![
        fork_command(&log, 1, 0, "bridge"),
        fork_command(&log, 2, 0, "bridge"),
        fork_command(&log, 3, 0, "Bridge"),
        fork_command(&log, 4, 0, ""),
        fork_command(&log, 5, 0, &"y".repeat(33)),
        fork_command(&log, 6, 9999, "future"),
        fork_command(&log, 7, 0, "taken"),
        fork_command(&log, 8, 0, &long),
    ];
    run_forking("harbor", &log, Some(forks), commands).await;
    assert_eq!(
        results(&log),
        vec![
            (1, RESULT_APPLIED),
            (2, REFUSED_FORK_EXISTS),
            (3, REFUSED_FORK_NAME),
            (4, REFUSED_FORK_NAME),
            (5, REFUSED_FORK_NAME),
            (6, REFUSED_FORK_TICK),
            (7, REFUSED_FORK_EXISTS),
            (8, RESULT_APPLIED),
        ]
    );
    // The fork tick has to be one that happened: a tick not yet stepped is refused, the one before is not.
    let forked: Vec<Event> = log
        .records(0)
        .iter()
        .flat_map(|r| r.events.iter().cloned())
        .filter(|e| matches!(e, Event::Forked { .. }))
        .collect();
    assert_eq!(forked.len(), 2);
    assert_eq!(
        forked[0],
        Event::Forked {
            tick: 0,
            name: "harbor~bridge".into(),
            principal: principal_hash("mayor"),
        }
    );
    let first = requests.recv().await.unwrap();
    assert_eq!(
        first,
        Request {
            parent: "harbor".into(),
            child: "harbor~bridge".into(),
            tick: 0,
            principal: principal_hash("mayor"),
            side: 2,
        }
    );
    assert_eq!(
        requests.recv().await.unwrap().child,
        format!("harbor~{long}")
    );
    assert!(requests.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn a_fork_too_deep_to_name_is_refused() {
    let log = Memory::healthy();
    let (forks, mut requests) = forking(&[]);
    let parent = format!("harbor~{}", "a".repeat(32));
    let commands = vec![
        fork_command(&log, 1, 0, &"b".repeat(25)),
        fork_command(&log, 2, 0, &"b".repeat(26)),
    ];
    run_forking(&parent, &log, Some(forks), commands).await;
    // 6 + 1 + 32 + 1 + 25 is 65; 26 would be 66.
    assert_eq!(
        results(&log),
        vec![(1, REFUSED_FORK_TOO_DEEP), (2, REFUSED_FORK_TOO_DEEP)]
    );
    assert!(requests.try_recv().is_err());
    let (forks, mut requests) = forking(&[]);
    let log = Memory::healthy();
    run_forking(
        &parent,
        &log,
        Some(forks),
        vec![fork_command(&log, 1, 0, &"b".repeat(24))],
    )
    .await;
    assert_eq!(results(&log), vec![(1, RESULT_APPLIED)]);
    assert_eq!(requests.recv().await.unwrap().child.len(), 64);
}

#[tokio::test(start_paused = true)]
async fn a_sim_that_cannot_make_streams_refuses_to_fork() {
    let log = Memory::healthy();
    run_forking(
        "harbor",
        &log,
        None,
        vec![fork_command(&log, 1, 0, "bridge")],
    )
    .await;
    assert_eq!(results(&log), vec![(1, REFUSED_UNSUPPORTED)]);
}

/// The fork command is applied once. A sim restarted over the log hands the fork on again, in case it was
/// not finished, and does not record it a second time.
#[tokio::test(start_paused = true)]
async fn a_restart_hands_over_a_fork_the_log_recorded_and_applies_nothing_twice() {
    let log = Memory::healthy();
    let (forks, mut requests) = forking(&[]);
    run_city("harbor", harbor(), quick(10), log.clone())
        .await
        .unwrap();
    let history = load_history(&log, 4, &quick(0)).await.unwrap();
    let mut first = quick(100);
    first.forks = Some(forks);
    let (send, inbox) = mpsc::channel(4);
    send.try_send(fork_command(&log, 1, 0, "bridge")).unwrap();
    run_with_history("harbor", harbor(), first, log.clone(), Some(inbox), history)
        .await
        .unwrap();
    let handed = requests.recv().await.unwrap();

    let (forks, mut again) = forking(&[]);
    let history = load_history(&log, 4, &quick(0)).await.unwrap();
    assert_eq!(history.as_ref().unwrap().forks().len(), 1);
    let (_send, inbox) = mpsc::channel(4);
    let mut second = quick(200);
    second.forks = Some(forks.clone());
    run_with_history(
        "harbor",
        harbor(),
        second,
        log.clone(),
        Some(inbox),
        history,
    )
    .await
    .unwrap();
    let again_handed = tokio::time::timeout(Duration::from_secs(1), again.recv()).await;
    assert_eq!(again_handed.ok().flatten(), Some(handed));
    assert!(again.try_recv().is_err());
    assert_eq!(results(&log), vec![(1, RESULT_APPLIED)]);
    // The name stays taken across the restart, so the same name cannot make a second history.
    assert_eq!(
        forks.decide("harbor", 150, 10, "bridge"),
        Err(REFUSED_FORK_EXISTS)
    );
}

/// A tick only some districts committed: the fork command is in district 0, which either has the tick or does not,
/// and the fork is recorded once and handed over either way.
#[tokio::test(start_paused = true)]
async fn a_fork_in_a_tick_some_districts_missed_is_made_once() {
    // Sent after tick 49 is committed in district 0, so it is applied for tick 50.
    let sent = |hung: Option<u16>| {
        let (send, inbox) = mpsc::channel(8);
        let mut log = Memory::new(move |d, offset, attempt| {
            (Some(d) == hung && offset == 50 && attempt == 1).then_some(Fault::Hang)
        });
        let published = log.clone();
        log.hook = Arc::new(move |d, offset| {
            if d == 0 && offset == 49 {
                send.try_send(fork_command(&published, 9, 20, "bridge"))
                    .unwrap();
            }
        });
        (log, inbox)
    };
    let with_forks = || {
        let (forks, requests) = forking(&[]);
        let mut settings = quick(500);
        settings.forks = Some(forks);
        (settings, requests)
    };
    let (whole, inbox) = sent(None);
    let (settings, mut requests) = with_forks();
    run_city_with("harbor", harbor(), settings, whole.clone(), Some(inbox))
        .await
        .unwrap();
    assert_eq!(command_events(&whole), vec![(50, 9, RESULT_APPLIED)]);
    assert_eq!(requests.recv().await.unwrap().tick, 20);

    for hung in [0, 2] {
        let (log, inbox) = sent(Some(hung));
        let (settings, _) = with_forks();
        killed(
            Duration::from_secs(3),
            run_city_with("harbor", harbor(), settings, log.clone(), Some(inbox)),
        )
        .await;
        let (_send, inbox) = mpsc::channel(8);
        let (settings, mut requests) = with_forks();
        run_city_with("harbor", harbor(), settings, log.clone(), Some(inbox))
            .await
            .unwrap();
        assert_eq!(
            command_events(&log),
            vec![(50, 9, RESULT_APPLIED)],
            "district {hung} held back"
        );
        assert!(records(&log) == records(&whole));
        // The restart hands the fork over, once, whether or not the first run got that far.
        assert_eq!(requests.recv().await.unwrap().child, "harbor~bridge");
        assert!(requests.try_recv().is_err());
    }
}

#[test]
fn a_fork_may_take_the_name_of_another_cities_fork() {
    let (forks, _requests) = forking(&["lakeside~bridge"]);
    assert!(forks.decide("harbor", 10, 5, "bridge").is_ok());
    assert_eq!(
        forks.decide("harbor", 10, 5, "bridge"),
        Err(REFUSED_FORK_EXISTS)
    );
    assert_eq!(
        forks.decide("harbor", 10, 10, "other"),
        Err(REFUSED_FORK_TICK)
    );
    assert_eq!(
        forks.decide("harbor", 10, 9, "other"),
        Ok("harbor~other".into())
    );
}
