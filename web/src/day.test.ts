import { describe, expect, it } from 'vitest';
import type { TickRecord } from './city';
import { SLACK, DayLog, currentRow, dayOf, rows, type DayEntry } from './day';
import { recordedDay } from './day-fixture';
import { TICKS_PER_DAY } from './clock';

const day = recordedDay();

/** The panel's day for `resident`, from the records the log holds up to `through`. */
function panel(resident: number, which: number, records: readonly TickRecord[] = day.records): DayEntry[] {
  const log = new DayLog(resident);
  for (const r of records) log.add(r);
  const from = which * TICKS_PER_DAY;
  return log.entries(from, Math.min(from + TICKS_PER_DAY, day.through + 1));
}

/** What the fixture says the panel must show: the entries of the day, replans left out (the sim writes none). */
const expected = (resident: number, which: number) => day.expected.get(resident)![which]!;

describe('a recorded day', () => {
  it('has residents to check, with trips, stays and a day that starts mid-stay', () => {
    expect([...day.expected.keys()].length).toBeGreaterThanOrEqual(2);
    for (const id of day.expected.keys()) {
      const kinds = new Set(expected(id, 0).map((e) => e.kind));
      expect(kinds).toEqual(new Set(['trip', 'stay']));
    }
  });

  it('is what the sim did: the panel equals the sim’s events for every resident and both days', () => {
    for (const id of day.expected.keys()) {
      for (const which of [0, 1]) {
        expect(panel(id, which), `resident ${id}, day ${which}`).toEqual(expected(id, which));
      }
    }
  });

  it('does not depend on the order records arrive in, or on seeing one twice', () => {
    const shuffled = [...day.records].reverse();
    shuffled.push(...day.records.slice(0, 50));
    for (const id of day.expected.keys()) expect(panel(id, 0, shuffled)).toEqual(expected(id, 0));
  });

  it('shows a trip as its departure and arrival, with the place it ended at', () => {
    const [id] = [...day.expected.keys()];
    const trip = panel(id!, 0).find((e) => e.kind === 'trip');
    expect(trip).toMatchObject({ kind: 'trip', carried: false });
    const row = rows([trip!], (lot) => `lot ${lot}`)[0]!;
    expect(row.text).toMatch(/^(Drove|Walked) to /);
    expect(row.when).toMatch(/^\d\d:\d\d to \d\d:\d\d$/);
    expect(row.place).toMatch(/^lot \d+$/);
    expect(row.tick).toBe(trip!.tick);
  });

  it('puts the row for a tick on the stay or trip begun by then', () => {
    const [id] = [...day.expected.keys()];
    const list = rows(panel(id!, 0), () => null);
    expect(currentRow(list, 0)).toBe(0);
    for (const [i, row] of list.entries()) expect(currentRow(list, row.tick)).toBe(i);
    expect(currentRow(list, day.through)).toBe(list.length - 1);
  });
});

describe('a day built from the log by hand', () => {
  const tick = (district: number, at: number, events: object[], keyframe: object[] | null = null, epoch = 1) =>
    ({
      kind: 'tick',
      epoch,
      district,
      tick: at,
      speed: 4,
      keyframeOffset: 0,
      wallUs: 0,
      keyframe: keyframe && { buildings: [], residents: keyframe },
      events,
    }) as unknown as TickRecord;
  const trip = (at: number, vehicle = 1) => ({ type: 'trip', resident: 7, vehicle, depart: at, route: [[1, 100]] });
  const arrive = (lot: number, kind: number, until = 0) => [
    { type: 'arrived', resident: 7, lot },
    { type: 'activity', resident: 7, kind, until },
  ];
  const log = (...records: TickRecord[]) => {
    const l = new DayLog(7);
    for (const r of records) l.add(r);
    return l;
  };

  it('keeps a trip that left late where it left, not where the schedule had it', () => {
    // Scheduled out at 08:00 (tick 1920); the sim sent them at 08:10 and they arrived 40 ticks later.
    const l = log(
      tick(0, 0, [], [{ id: 7, activity: 0, lot: 3, until: 1920 }]),
      tick(0, 1960, [trip(1960)]),
      tick(1, 2000, arrive(9, 1, 3000)),
    );
    expect(l.entries(0, TICKS_PER_DAY)).toEqual([
      { kind: 'stay', tick: 0, carried: true, lot: 3, activity: 0, left: 1960 },
      { kind: 'trip', tick: 1960, carried: false, car: true, arrived: 2000, lot: 9, activity: 1 },
      { kind: 'stay', tick: 2000, carried: false, lot: 9, activity: 1, left: null },
    ]);
  });

  it('lists a change of route where the log has it', () => {
    const l = log(
      tick(0, 100, [trip(100)]),
      tick(2, 120, [{ type: 'replan', resident: 7, fromSegment: 4, route: [[5, 80]] }]),
      tick(1, 140, arrive(2, 3)),
    );
    expect(l.entries(0, TICKS_PER_DAY).map((e) => [e.kind, e.tick])).toEqual([
      ['trip', 100],
      ['replan', 120],
      ['stay', 140],
    ]);
    expect(rows(l.entries(0, TICKS_PER_DAY), () => null)[1]!).toMatchObject({ text: 'Changed route', when: '00:30' });
  });

  it('opens on a trip already under way, which the next arrival ends', () => {
    const at = TICKS_PER_DAY;
    const l = log(tick(0, at, [], [{ id: 7, vehicle: 2, progress: 300, route: [] }]), tick(1, at + 40, arrive(5, 0)));
    expect(l.entries(at, at + TICKS_PER_DAY)).toEqual([
      { kind: 'trip', tick: at, carried: true, car: true, arrived: at + 40, lot: 5, activity: 0 },
      { kind: 'stay', tick: at + 40, carried: false, lot: 5, activity: 0, left: null },
    ]);
  });

  it('lets a trip that leaves in the first tick of a day speak for itself, not the keyframe', () => {
    const at = TICKS_PER_DAY;
    const l = log(
      tick(0, at, [trip(at, 0)], [{ id: 7, vehicle: 0, progress: 0, route: [] }]),
      tick(1, at + 30, arrive(5, 1)),
    );
    const entries = l.entries(at, at + TICKS_PER_DAY);
    expect(entries.map((e) => [e.kind, e.carried, e.tick])).toEqual([
      ['trip', false, at],
      ['stay', false, at + 30],
    ]);
  });

  it('closes a trip that left before midnight with an arrival after it, and leaves the next day’s stay to that day', () => {
    const l = log(
      tick(0, TICKS_PER_DAY - 10, [trip(TICKS_PER_DAY - 10, 0)]),
      tick(0, TICKS_PER_DAY + 20, arrive(1, 0)),
    );
    const today = l.entries(0, TICKS_PER_DAY);
    expect(today).toEqual([
      {
        kind: 'trip',
        tick: TICKS_PER_DAY - 10,
        carried: false,
        car: false,
        arrived: TICKS_PER_DAY + 20,
        lot: 1,
        activity: 0,
      },
    ]);
    expect(SLACK).toBeGreaterThan(30);
  });

  it('takes the newest epoch for a tick a restarted sim wrote again', () => {
    const l = log(
      tick(0, 100, [trip(100)], null, 1),
      tick(0, 100, [trip(100, 0)], null, 2),
      tick(0, 100, [trip(100)], null, 1),
    );
    expect(l.entries(0, TICKS_PER_DAY)).toHaveLength(1);
    expect(l.entries(0, TICKS_PER_DAY)[0]).toMatchObject({ car: false });
  });

  it('drops what an older epoch wrote at or after the tick a newer epoch began from', () => {
    // Epoch 1 ran to tick 200 and arrived at 200. A restart begins epoch 2 at tick 120, goes out at 150 and is still out.
    const old = [
      tick(0, 100, [trip(100)], null, 1),
      tick(0, 150, [trip(150, 0)], null, 1),
      tick(1, 200, arrive(9, 1), null, 1),
    ];
    const fresh = [tick(0, 120, [], null, 2), tick(0, 150, [trip(150)], null, 2)];
    for (const records of [
      [...old, ...fresh],
      [...fresh, ...old],
      [...old.slice(0, 1), ...fresh, ...old.slice(1)],
    ]) {
      const entries = log(...records).entries(0, TICKS_PER_DAY);
      expect(entries).toEqual([
        { kind: 'trip', tick: 100, carried: false, car: true, arrived: null, lot: null, activity: null },
        { kind: 'trip', tick: 150, carried: false, car: true, arrived: null, lot: null, activity: null },
      ]);
    }
  });

  it('words a trip with no arrival as under way only while the day is going', () => {
    const l = log(tick(0, 100, [trip(100)]));
    expect(rows(l.entries(0, TICKS_PER_DAY), () => null)[0]!.text).toBe('Driving');
    expect(rows(l.entries(0, TICKS_PER_DAY), () => null, false)[0]!.text).toBe('Drove');
  });

  it('says when a record added something and when it did not', () => {
    const l = new DayLog(7);
    expect(l.add(tick(0, 100, [{ type: 'speed', ticksPerSecond: 4 }]))).toBe(false);
    expect(l.add(tick(0, 101, [trip(101)]))).toBe(true);
    expect(l.add(tick(0, 101, [trip(101)]))).toBe(false);
  });

  it('knows the day a tick is in', () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(TICKS_PER_DAY - 1)).toBe(0);
    expect(dayOf(TICKS_PER_DAY)).toBe(1);
  });
});
