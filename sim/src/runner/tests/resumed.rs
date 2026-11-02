//! A city started over a log that already holds its history.

use felix_metro_core::record::{
    BuildingDiff, Command, CommandRecord, RESULT_APPLIED, principal_hash,
};

use super::*;
use crate::commands::tests::{city as harbor, free_lot};

/// Runs as fast as the log answers.
fn quick(stop: u32) -> Settings {
    Settings {
        paced: false,
        ..settings(stop)
    }
}

/// Every district's records, with the wall clock zeroed: the one thing a
/// restart is allowed to change.
fn records(log: &Memory) -> Vec<Vec<TickRecord>> {
    (0..4)
        .map(|district| {
            log.records(district)
                .into_iter()
                .map(|mut r| {
                    r.header.wall_us = 0;
                    r
                })
                .collect()
        })
        .collect()
}

async fn straight(settings: Settings) -> Memory {
    let log = Memory::healthy();
    run_city("harbor", harbor(), settings, log.clone())
        .await
        .unwrap();
    log
}

impl Memory {
    /// Appends a stamped command to the command stream and returns it as the
    /// follower would deliver it.
    fn publish(&self, principal: &str, id: u32, command: Command) -> Incoming {
        let record = CommandRecord {
            id,
            name: principal.to_owned(),
            command,
        };
        let mut payload = (principal.len() as u16).to_be_bytes().to_vec();
        payload.extend_from_slice(principal.as_bytes());
        payload.extend_from_slice(&record.encode().unwrap());
        let mut commands = self.commands.lock().unwrap();
        commands.push(payload);
        Incoming {
            principal: principal_hash(principal),
            command: Some(record),
            offset: Some(commands.len() as u64 - 1),
        }
    }
}

fn command_events(log: &Memory) -> Vec<(u32, u32, u8)> {
    let mut out = Vec::new();
    for district in 0..4 {
        for r in log.records(district) {
            for e in &r.events {
                if let Event::Command { id, result, .. } = e {
                    out.push((r.header.tick, *id, *result));
                }
            }
        }
    }
    out.sort();
    out
}

/// Cuts a run off after `wait`, as a killed process is.
async fn killed(wait: Duration, run: impl Future<Output = Result<Done>>) {
    tokio::time::timeout(wait, run)
        .await
        .expect_err("the run was meant to hang");
}

#[tokio::test(start_paused = true)]
async fn a_restart_gives_the_log_a_straight_run_would_have() {
    // Past the 08:00 rush, when most of the city is on the road, and through a keyframe or two.
    const TOTAL: u32 = 2100;
    let whole = records(&straight(quick(TOTAL)).await);
    for stop in [1, 239, 240, 241, 700, 1925] {
        let log = Memory::healthy();
        run_city("harbor", harbor(), quick(stop), log.clone())
            .await
            .unwrap();
        let done = run_city("harbor", harbor(), quick(TOTAL), log.clone())
            .await
            .unwrap();
        assert_eq!(done.ticks, TOTAL);
        assert!(records(&log) == whole, "stopped at tick {stop}");
        assert_whole(&log, TOTAL);
    }
}

/// A trip that left before the records a restart first reads must not stop the city coming back.
#[tokio::test(start_paused = true)]
async fn a_trip_that_began_before_the_lookback_is_found_by_reading_further_back() {
    const TOTAL: u32 = 2100;
    let whole = records(&straight(quick(TOTAL)).await);
    // Stopped in the morning rush, with the 08:00 keyframe full of residents who left earlier.
    let log = Memory::healthy();
    run_city("harbor", harbor(), quick(1960), log.clone())
        .await
        .unwrap();
    let retry = Retry::of(&quick(TOTAL));
    // No lookback at all reads nothing of the trips under way.
    let history = read_history(&log, 4, retry, 0).await.unwrap();
    run_with_history("harbor", harbor(), quick(TOTAL), log.clone(), None, history)
        .await
        .unwrap();
    assert!(records(&log) == whole);
}

#[tokio::test(start_paused = true)]
async fn a_restart_does_not_change_the_epoch_or_the_speed() {
    let mut first = quick(300);
    first.epoch = 7;
    first.ticks_per_second = 8;
    let log = Memory::healthy();
    run_city("harbor", harbor(), first, log.clone())
        .await
        .unwrap();
    // What the sim is started with now does not matter: the city keeps its own.
    run_city("harbor", harbor(), quick(500), log.clone())
        .await
        .unwrap();
    assert_whole(&log, 500);
    for r in log.records(2) {
        assert_eq!(
            (r.header.epoch, r.header.speed),
            (7, 8),
            "tick {}",
            r.header.tick
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_tick_only_some_districts_committed_is_finished_by_the_restart() {
    let whole = records(&straight(quick(1000)).await);
    for (hung, at) in [(0, 700), (1, 700), (2, 700), (3, 700), (2, 720), (0, 720)] {
        let log = Memory::new(move |district, offset, attempt| {
            (district == hung && offset == at && attempt == 1).then_some(Fault::Hang)
        });
        killed(
            Duration::from_secs(3),
            run_city("harbor", harbor(), quick(2000), log.clone()),
        )
        .await;
        let held: Vec<usize> = (0..4).map(|d| log.records(d).len()).collect();
        let want: Vec<usize> = (0..4)
            .map(|d| at as usize + 1 - usize::from(d == hung))
            .collect();
        assert_eq!(held, want, "district {hung} left behind");

        run_city("harbor", harbor(), quick(1000), log.clone())
            .await
            .unwrap();
        assert!(records(&log) == whole, "district {hung} left behind");
    }
}

#[tokio::test(start_paused = true)]
async fn a_killed_warmup_carries_on_from_where_every_district_got_to() {
    let whole = records(&straight(quick(1500)).await);
    let log = Memory::new(|district, offset, attempt| {
        (district == 1 && offset == 300 && attempt == 1).then_some(Fault::Hang)
    });
    let mut first = quick(1500);
    first.warmup_ticks = 1500;
    killed(
        Duration::from_secs(3),
        run_city("harbor", harbor(), first, log.clone()),
    )
    .await;
    // The other districts ran ahead of the one that stopped.
    assert_eq!(log.records(1).len(), 300);
    assert!((0..4).any(|d| log.records(d).len() > 400));

    run_city("harbor", harbor(), quick(1500), log.clone())
        .await
        .unwrap();
    assert!(records(&log) == whole);
}

#[tokio::test(start_paused = true)]
async fn what_builders_built_is_still_there_after_a_restart() {
    let world = World::new(harbor());
    let lot = free_lot(&world);
    let district = world.city.lots[lot as usize].district;
    let (send, inbox) = mpsc::channel(8);
    let log = Memory::healthy();
    let incoming = log.publish(
        "mayor",
        1,
        Command::Build {
            lot,
            kind: 4,
            rotation: 1,
        },
    );
    send.try_send(incoming).unwrap();
    run_city_with("harbor", harbor(), quick(300), log.clone(), Some(inbox))
        .await
        .unwrap();

    let (_send, inbox) = mpsc::channel(8);
    run_city_with("harbor", harbor(), quick(1000), log.clone(), Some(inbox))
        .await
        .unwrap();
    assert_whole(&log, 1000);
    let built = BuildingDiff {
        lot,
        kind: 4,
        rotation: 1,
    };
    for tick in [240, 480, 720, 960] {
        let frame = log.records(district)[tick].keyframe.clone().unwrap();
        assert_eq!(frame.buildings, vec![built], "keyframe at {tick}");
    }
    // Applied once, at the first tick, and not again.
    assert_eq!(command_events(&log), vec![(0, 1, RESULT_APPLIED)]);
}

/// The account is rebuilt from a keyframe and the prices and days after it. The build lands mid-hour, so a restart
/// at 300 or 470 reads its price from the log, and one at 5600 or 5770 reads it from a keyframe. 6100 restarts
/// from the first keyframe after a scored day, where the council has a score and a part-day tally to restore.
#[tokio::test(start_paused = true)]
async fn the_account_is_the_same_after_a_restart_on_either_side_of_a_day() {
    const TOTAL: u32 = 6300;
    let lot = free_lot(&World::new(harbor()));
    let build = Command::Build {
        lot,
        kind: 4,
        rotation: 1,
    };
    // Runs the city to `stop`, sending `command` first when there is one.
    let run = |log: Memory, stop: u32, command: Option<Command>| {
        let inbox = command.map(|command| {
            let (send, inbox) = mpsc::channel(8);
            send.try_send(log.publish("mayor", 1, command)).unwrap();
            // Keep the sender alive for the run, as the follower would.
            std::mem::forget(send);
            inbox
        });
        async move { run_city_with("harbor", harbor(), quick(stop), log, inbox).await }
    };
    // The reference restarts once, at tick 250, where the build is sent.
    let whole_log = Memory::healthy();
    run(whole_log.clone(), 250, None).await.unwrap();
    run(whole_log.clone(), TOTAL, Some(build.clone()))
        .await
        .unwrap();
    let whole = records(&whole_log);
    let balance_at = |tick: usize| -> i64 {
        (0..4)
            .flat_map(|d| whole_log.records(d)[tick].events.clone())
            .filter_map(|e| match e {
                Event::Balance { amount } => Some(amount),
                _ => None,
            })
            .sum()
    };
    let (before, after) = (balance_at(5520), balance_at(5760));
    assert!(before < 100_000, "the build cost something: {before}");
    assert!(after > before, "the day's taxes outran its upkeep");

    for stop in [300, 470, 5600, 5770, 6100] {
        let log = Memory::healthy();
        run(log.clone(), 250, None).await.unwrap();
        run(log.clone(), stop, Some(build.clone())).await.unwrap();
        run(log.clone(), TOTAL, None).await.unwrap();
        assert!(records(&log) == whole, "stopped at tick {stop}");
    }
}

#[tokio::test(start_paused = true)]
async fn the_command_stream_resumes_where_the_sim_stopped_reading() {
    let world = World::new(harbor());
    let lot = free_lot(&world);
    let build = |kind| Command::Build {
        lot,
        kind,
        rotation: 0,
    };
    let (send, inbox) = mpsc::channel(8);
    let log = Memory::healthy();
    send.try_send(log.publish("mayor", 1, build(4))).unwrap();
    send.try_send(log.publish("mayor", 2, Command::Demolish { lot }))
        .unwrap();
    run_city_with("harbor", harbor(), quick(300), log.clone(), Some(inbox))
        .await
        .unwrap();

    let history = load_history(&log, 4, &quick(0)).await.unwrap().unwrap();
    assert_eq!(history.commands_from(), Some(2));

    // Sent while the sim was down: the follower starts at the position and finds it.
    log.publish("mayor", 3, build(6));
    let (send, inbox) = mpsc::channel(8);
    for missed in log.commands(2, u64::MAX).await.unwrap() {
        send.try_send(missed).unwrap();
    }
    run_with_history(
        "harbor",
        harbor(),
        quick(400),
        log.clone(),
        Some(inbox),
        Some(history),
    )
    .await
    .unwrap();
    assert_eq!(
        command_events(&log),
        vec![
            (0, 1, RESULT_APPLIED),
            (0, 2, RESULT_APPLIED),
            (300, 3, RESULT_APPLIED)
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_command_in_a_tick_some_districts_missed_is_applied_for_all_of_them_once() {
    let world = World::new(harbor());
    let lot = free_lot(&world);
    let district = world.city.lots[lot as usize].district;
    // Sent after tick 49 is committed in district 0, so it is applied for tick 50.
    let with_command = |hang: bool| {
        let (send, inbox) = mpsc::channel(8);
        let mut log = Memory::new(move |d, offset, attempt| {
            (hang && d == district && offset == 50 && attempt == 1).then_some(Fault::Hang)
        });
        let published = log.clone();
        log.hook = Arc::new(move |d, offset| {
            if d == 0 && offset == 49 {
                let build = Command::Build {
                    lot,
                    kind: 4,
                    rotation: 0,
                };
                send.try_send(published.publish("mayor", 9, build)).unwrap();
            }
        });
        (log, inbox)
    };
    let (whole, inbox) = with_command(false);
    run_city_with("harbor", harbor(), quick(500), whole.clone(), Some(inbox))
        .await
        .unwrap();
    assert_eq!(command_events(&whole), vec![(50, 9, RESULT_APPLIED)]);

    let (log, inbox) = with_command(true);
    killed(
        Duration::from_secs(3),
        run_city_with("harbor", harbor(), quick(500), log.clone(), Some(inbox)),
    )
    .await;
    assert_eq!(log.records(district).len(), 50);
    // The district that missed the tick is the one the command was for: nothing else records it.
    assert!(command_events(&log).is_empty());

    // The follower is not asked for the command again: the restart reads it back from the stream.
    let (_send, inbox) = mpsc::channel(8);
    run_city_with("harbor", harbor(), quick(500), log.clone(), Some(inbox))
        .await
        .unwrap();
    assert_eq!(command_events(&log), vec![(50, 9, RESULT_APPLIED)]);
    assert!(records(&log) == records(&whole));
}

#[tokio::test(start_paused = true)]
async fn a_city_left_paused_stays_paused_until_it_is_resumed() {
    let (tx, rx) = watch::channel(4u8);
    let log = Memory::steered(&[(10, 0)], tx.clone());
    let mut first = quick(12);
    first.speed = Some(rx);
    first.speed_out = Some(tx);
    run_city("harbor", harbor(), first, log.clone())
        .await
        .unwrap();
    assert_eq!(log.records(0).last().unwrap().header.speed, 0);

    let (control, speed) = watch::channel(4u8);
    let mut again = quick(20);
    again.speed = Some(speed);
    again.speed_out = Some(control.clone());
    let task = tokio::spawn(run_city("harbor", harbor(), again, log.clone()));
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(log.records(0).len(), 12);
    assert_eq!(*control.borrow(), 0);
    control.send_replace(8);
    task.await.unwrap().unwrap();
    assert_whole(&log, 20);
    assert_eq!(log.records(0)[12].header.speed, 8);
}

#[tokio::test(start_paused = true)]
async fn a_log_with_a_record_that_is_not_a_keyframe_is_not_resumed() {
    let log = Memory::healthy();
    log.append(2, 0, vec![1, 2, 3], (false, None));
    let err = run_city("harbor", harbor(), quick(10), log.clone())
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("no keyframe"), "{err:#}");
}

fn marker_subjects(log: &Memory, day: u32) -> Vec<(u32, u32, String)> {
    let stored = log.markers.lock().unwrap().get(&day).cloned();
    stored.map_or_else(Vec::new, |bytes| {
        let record = felix_metro_core::record::MarkersRecord::decode(&bytes).unwrap();
        record
            .markers
            .into_iter()
            .map(|m| (m.tick, m.subject, m.by))
            .collect()
    })
}

#[tokio::test(start_paused = true)]
async fn markers_survive_a_restart_and_a_refused_command_leaves_none() {
    let world = World::new(harbor());
    let lot = free_lot(&world);
    let build = |kind| Command::Build {
        lot,
        kind,
        rotation: 0,
    };
    let (send, inbox) = mpsc::channel(8);
    let log = Memory::healthy();
    send.try_send(log.publish("mayor", 1, build(4))).unwrap();
    // Occupied by the first, so refused.
    send.try_send(log.publish("viewer", 2, build(6))).unwrap();
    run_city_with("harbor", harbor(), quick(300), log.clone(), Some(inbox))
        .await
        .unwrap();
    assert_eq!(
        marker_subjects(&log, 0),
        vec![(0, lot, "mayor".to_string())]
    );

    // A restart carries the day's list on instead of starting it over.
    let (send, inbox) = mpsc::channel(8);
    let history = load_history(&log, 4, &quick(0)).await.unwrap().unwrap();
    send.try_send(log.publish("mayor", 3, Command::Demolish { lot }))
        .unwrap();
    for missed in log.commands(2, u64::MAX).await.unwrap() {
        send.try_send(missed).unwrap();
    }
    run_with_history(
        "harbor",
        harbor(),
        quick(400),
        log.clone(),
        Some(inbox),
        Some(history),
    )
    .await
    .unwrap();
    assert_eq!(
        marker_subjects(&log, 0),
        vec![
            (0, lot, "mayor".to_string()),
            (300, lot, "mayor".to_string())
        ]
    );

    // The same lot built again in the same day, across another restart, is a second marker at its own tick
    // and leaves the earlier ones as they were: a lot's history is every change, not the latest.
    let (send, inbox) = mpsc::channel(8);
    let history = load_history(&log, 4, &quick(0)).await.unwrap().unwrap();
    send.try_send(log.publish("mayor", 4, build(6))).unwrap();
    for missed in log.commands(3, u64::MAX).await.unwrap() {
        send.try_send(missed).unwrap();
    }
    run_with_history(
        "harbor",
        harbor(),
        quick(500),
        log.clone(),
        Some(inbox),
        Some(history),
    )
    .await
    .unwrap();
    let marks = marker_subjects(&log, 0);
    assert_eq!(marks.iter().map(|m| m.0).collect::<Vec<_>>(), [0, 300, 400]);
    assert!(marks.iter().all(|m| m.1 == lot));
}

#[tokio::test(start_paused = true)]
async fn the_markers_of_a_tick_district_0_missed_are_written_by_the_restart() {
    let world = World::new(harbor());
    let lot = free_lot(&world);
    // Sent after tick 49 is committed in district 0, so it is applied for tick 50.
    let with_command = |hang: bool| {
        let (send, inbox) = mpsc::channel(8);
        let mut log = Memory::new(move |d, offset, attempt| {
            (hang && d == 0 && offset == 50 && attempt == 1).then_some(Fault::Hang)
        });
        let published = log.clone();
        log.hook = Arc::new(move |d, offset| {
            if d == 0 && offset == 49 {
                let build = Command::Build {
                    lot,
                    kind: 4,
                    rotation: 0,
                };
                send.try_send(published.publish("mayor", 9, build)).unwrap();
            }
        });
        (log, inbox)
    };
    let (whole, inbox) = with_command(false);
    run_city_with("harbor", harbor(), quick(500), whole.clone(), Some(inbox))
        .await
        .unwrap();
    assert_eq!(
        marker_subjects(&whole, 0),
        vec![(50, lot, "mayor".to_string())]
    );

    let (log, inbox) = with_command(true);
    killed(
        Duration::from_secs(3),
        run_city_with("harbor", harbor(), quick(500), log.clone(), Some(inbox)),
    )
    .await;
    assert_eq!(log.records(0).len(), 50);
    assert!(marker_subjects(&log, 0).is_empty());

    let (_send, inbox) = mpsc::channel(8);
    run_city_with("harbor", harbor(), quick(500), log.clone(), Some(inbox))
        .await
        .unwrap();
    assert_eq!(marker_subjects(&log, 0), marker_subjects(&whole, 0));
}

#[tokio::test(start_paused = true)]
async fn each_city_day_keeps_its_own_list_and_a_restart_reads_the_days_it_writes_to() {
    let log = Memory::healthy();
    let retry = Retry::of(&Settings::default());
    let change = |lot| {
        vec![vec![
            Event::Command {
                principal: 1,
                name: "mayor".into(),
                id: 1,
                result: RESULT_APPLIED,
            },
            Event::Built {
                lot,
                kind: 4,
                rotation: 0,
            },
        ]]
    };
    let mut today = Today::default();
    let a = mark(&mut today, 10, &change(1)).unwrap().unwrap();
    assert_eq!(a.day, 0);
    log.markers.lock().unwrap().insert(0, a.bytes);
    let b = mark(&mut today, TICKS_PER_DAY + 3, &change(2))
        .unwrap()
        .unwrap();
    assert_eq!(b.day, 1);
    // A restart reads the days from its first tick to the one after its last.
    let mut fresh = load_markers(&log, retry, 20..=TICKS_PER_DAY - 1)
        .await
        .unwrap();
    let c = mark(&mut fresh, 20, &change(3)).unwrap().unwrap();
    let record = felix_metro_core::record::MarkersRecord::decode(&c.bytes).unwrap();
    let ticks: Vec<_> = record.markers.iter().map(|m| (m.tick, m.subject)).collect();
    assert_eq!(ticks, [(10, 1), (20, 3)]);
    // A tick with no change writes nothing.
    assert_eq!(mark(&mut Today::default(), 5, &[Vec::new()]).unwrap(), None);
}

/// A log whose reads of the markers fail, as a broker that is briefly unreachable would.
#[tokio::test(start_paused = true)]
async fn a_failed_read_of_the_markers_stops_the_start_and_never_a_tick() {
    #[derive(Clone)]
    struct Unreadable(Memory);
    impl Log for Unreadable {
        async fn commit(
            &self,
            d: u16,
            e: u64,
            r: Vec<u8>,
            k: bool,
            m: Option<&Marked>,
        ) -> Result<Write> {
            self.0.commit(d, e, r, k, m).await
        }
        async fn markers(&self, _day: u32) -> Result<Option<Vec<u8>>> {
            anyhow::bail!("unreachable")
        }
        async fn read(&self, d: u16, o: u64) -> Result<Option<Vec<u8>>> {
            self.0.read(d, o).await
        }
        async fn keyframe(&self, d: u16) -> Result<Option<u64>> {
            self.0.keyframe(d).await
        }
        async fn read_from(&self, d: u16, o: u64, m: u32) -> Result<Vec<(u64, Vec<u8>)>> {
            self.0.read_from(d, o, m).await
        }
        async fn commands(&self, f: u64, u: u64) -> Result<Vec<Incoming>> {
            self.0.commands(f, u).await
        }
    }
    let world = World::new(harbor());
    let lot = free_lot(&world);
    let inner = Memory::healthy();
    let (send, inbox) = mpsc::channel(8);
    let build = Command::Build {
        lot,
        kind: 4,
        rotation: 0,
    };
    send.try_send(inner.publish("mayor", 1, build)).unwrap();
    let mut s = quick(300);
    s.max_failures = 2;
    // A new city reads no markers, so a build in it commits whatever the log says about them.
    run_city_with(
        "harbor",
        harbor(),
        s.clone(),
        Unreadable(inner.clone()),
        Some(inbox),
    )
    .await
    .unwrap();
    assert_eq!(
        marker_subjects(&inner, 0),
        vec![(0, lot, "mayor".to_string())]
    );
    // A restart reads them before its first tick, and stops there when it cannot.
    let log = Unreadable(inner);
    let history = load_history(&log, 4, &quick(0)).await.unwrap().unwrap();
    s.stop_at = Some(310);
    let err = run_with_history("harbor", harbor(), s, log, None, Some(history))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("markers"), "{err:#}");
}

#[tokio::test(start_paused = true)]
async fn a_stored_list_that_does_not_decode_does_not_stop_a_restart() {
    let world = World::new(harbor());
    let lot = free_lot(&world);
    let log = Memory::healthy();
    run_city("harbor", harbor(), quick(300), log.clone())
        .await
        .unwrap();
    log.markers
        .lock()
        .unwrap()
        .insert(0, vec![5, 0xff, 0xff, 0xff]);
    let (send, inbox) = mpsc::channel(8);
    let build = Command::Build {
        lot,
        kind: 4,
        rotation: 0,
    };
    send.try_send(log.publish("mayor", 1, build)).unwrap();
    let history = load_history(&log, 4, &quick(0)).await.unwrap().unwrap();
    run_with_history(
        "harbor",
        harbor(),
        quick(310),
        log.clone(),
        Some(inbox),
        Some(history),
    )
    .await
    .unwrap();
    // The unreadable value is replaced by a list that holds what this run marked.
    assert_eq!(
        marker_subjects(&log, 0),
        vec![(300, lot, "mayor".to_string())]
    );
}
