import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickRecord } from './city';
import { TICKS_PER_DAY } from './clock';
import { SLACK, DayLog, rows } from './day';
import { DayPanel, type DayDeps, type DayView } from './day-panel';
import { recordedDay } from './day-fixture';

const day = recordedDay();
const [resident] = [...day.expected.keys()];

/** A panel over the recorded day, with a log that holds the records up to `newest`. */
function setup(newest = day.through, patch: Partial<DayDeps> = {}) {
  const views: (DayView | null)[] = [];
  const seeks: number[] = [];
  const scans: [number, number][] = [];
  const listeners = new Set<(r: TickRecord) => void>();
  let tip: number | null = newest;
  const deps: DayDeps = {
    scan: async (from, to, visit) => {
      scans.push([from, to]);
      for (const r of day.records) if (r.tick >= from && r.tick < to && r.tick <= newest) visit(r);
    },
    span: async () => ({ oldest: 0, newest }),
    live: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    tip: () => tip,
    seek: (t) => seeks.push(t),
    placeName: (lot) => `lot ${lot}`,
    show: (v) => views.push(v),
    ...patch,
  };
  const panel = new DayPanel(deps);
  return {
    panel,
    views,
    seeks,
    scans,
    listeners,
    setTip: (t: number | null) => (tip = t),
    last: () => views.at(-1)!,
    settled: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const panelRows = (id: number, which: number, through = day.through) => {
  const log = new DayLog(id);
  for (const r of day.records) if (r.tick <= through) log.add(r);
  const from = which * TICKS_PER_DAY;
  return rows(
    log.entries(from, from + TICKS_PER_DAY),
    (lot) => `lot ${lot}`,
    which === Math.floor(through / TICKS_PER_DAY),
  );
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the day panel', () => {
  it('shows the day the tick on screen is in, read from the log from midnight to an hour past the next', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    expect(t.scans).toEqual([[0, Math.min(TICKS_PER_DAY + SLACK, day.through + 1)]]);
    const view = t.last();
    expect(view).toMatchObject({ status: 'ready', label: 'Day 1', canPrev: false, canNext: true, note: null });
    expect(view.rows).toEqual(panelRows(resident!, 0));
  });

  it('marks the row they are in at the tick on screen, and moves the mark as the tick does', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    const list = t.last().rows;
    const at = (tick: number) => list.reduce((at, r, i) => (r.kind !== 'replan' && r.tick <= tick ? i : at), -1);
    expect(t.last().current).toBe(at(2000));
    t.panel.frame(4300);
    expect(t.last().current).toBe(at(4300));
    expect(at(4300)).not.toBe(at(2000));
  });

  it('seeks to the tick of the row chosen', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    const i = t.last().rows.findIndex((r) => r.kind === 'trip');
    t.panel.pick(i);
    expect(t.seeks).toEqual([t.last().rows[i]!.tick]);
    t.panel.pick(999);
    expect(t.seeks).toHaveLength(1);
  });

  it('pages to another day and back without reading a day twice', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    t.panel.step(1);
    await t.settled();
    expect(t.last()).toMatchObject({ status: 'ready', label: 'Day 2, today', canPrev: true, canNext: false });
    expect(t.last().rows).toEqual(panelRows(resident!, 1));
    t.panel.step(1);
    expect(t.last().label).toBe('Day 2, today');
    t.panel.step(-1);
    await t.settled();
    expect(t.last().label).toBe('Day 1');
    expect(t.scans).toHaveLength(2);
    t.panel.step(-1);
    expect(t.last().label).toBe('Day 1');
  });

  it('keeps the day the person chose while the tick on screen is somewhere else', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(TICKS_PER_DAY + 10);
    await t.settled();
    t.panel.step(-1);
    await t.settled();
    expect(t.last().label).toBe('Day 1');
    t.panel.frame(TICKS_PER_DAY + 10);
    vi.advanceTimersByTime(2000);
    await t.settled();
    expect(t.last().label).toBe('Day 1');
  });

  it('moves to the day the tick on screen is in, once it has stayed there', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    t.panel.frame(TICKS_PER_DAY + 10);
    expect(t.last().label).toBe('Day 1');
    t.panel.frame(2000);
    vi.advanceTimersByTime(1000);
    expect(t.last().label).toBe('Day 1');
    t.panel.frame(TICKS_PER_DAY + 10);
    vi.advanceTimersByTime(1000);
    await t.settled();
    expect(t.last().label).toBe('Day 2, today');
  });

  it('shows a live record as a new row, once, without reading the day again', async () => {
    const t = setup(1000);
    t.panel.follow(resident!);
    t.panel.frame(1000);
    await t.settled();
    const rowsBefore = t.last().rows.length;
    const arrival = {
      kind: 'tick',
      epoch: 1,
      district: 0,
      tick: 1001,
      speed: 4,
      keyframeOffset: 0,
      wallUs: 0,
      keyframe: null,
      events: [{ type: 'trip', resident, vehicle: 1, depart: 1001, route: [[1, 100]] }],
    } as unknown as TickRecord;
    const feed = [...t.listeners][0]!;
    feed(arrival);
    feed(arrival);
    vi.advanceTimersByTime(500);
    expect(t.last().rows).toHaveLength(rowsBefore + 1);
    expect(t.last().rows.at(-1)).toMatchObject({ kind: 'trip', tick: 1001, when: 'from 04:10' });
    expect(t.scans).toHaveLength(1);
  });

  it('goes back to following the screen once the person pages back to today', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    t.panel.step(1);
    await t.settled();
    t.panel.step(-1);
    await t.settled();
    t.panel.step(1);
    await t.settled();
    expect(t.last().label).toBe('Day 2, today');
    // On today, so the screen's tick leads again: a moment in day 1 moves the panel there.
    t.panel.frame(2000);
    vi.advanceTimersByTime(1000);
    await t.settled();
    expect(t.last().label).toBe('Day 1');
  });

  it('does not draw a half read day when a live record lands just before the person pages to it', async () => {
    const t = setup(1000);
    t.panel.follow(resident!);
    t.panel.frame(1000);
    await t.settled();
    const feed = [...t.listeners][0]!;
    // In the first hour of day 2, which day 1's view also takes in.
    feed({
      kind: 'tick',
      epoch: 1,
      district: 0,
      tick: TICKS_PER_DAY + 50,
      speed: 4,
      keyframeOffset: 0,
      wallUs: 0,
      keyframe: null,
      events: [{ type: 'trip', resident, vehicle: 1, depart: TICKS_PER_DAY + 50, route: [[1, 100]] }],
    } as unknown as TickRecord);
    t.setTip(TICKS_PER_DAY + 100);
    t.panel.step(1);
    const shown = t.views.length;
    vi.advanceTimersByTime(500);
    expect(t.views.slice(shown).filter((v) => v!.status === 'loading' && v!.rows.length > 0)).toEqual([]);
  });

  it('says so when the page has no log, so the card can show the schedule', async () => {
    const t = setup(day.through, { span: async () => null });
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    expect(t.last()).toMatchObject({ status: 'unavailable', rows: [] });
  });

  it('says when the log has lost a day, or cannot be read', async () => {
    const lost = setup(day.through, { span: async () => ({ oldest: TICKS_PER_DAY, newest: day.through }) });
    lost.panel.follow(resident!);
    lost.panel.frame(10);
    await lost.settled();
    expect(lost.last()).toMatchObject({ status: 'unretained', note: 'The log no longer holds this day.' });
    const broken = setup(day.through, {
      scan: async () => {
        throw new Error('the gateway went away');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    broken.panel.follow(resident!);
    broken.panel.frame(2000);
    await broken.settled();
    expect(broken.last()).toMatchObject({ status: 'failed', note: 'Their day could not be read.' });
  });

  it('says when the start of the day is gone but the rest is kept', async () => {
    const t = setup(day.through, { span: async () => ({ oldest: 480, newest: day.through }) });
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    expect(t.last()).toMatchObject({ status: 'ready', note: 'The log no longer holds the start of this day.' });
  });

  it('drops a read that a later one replaced', async () => {
    let release: (() => void) | null = null;
    const slow = setup(day.through, {
      scan: (from, _to, visit) =>
        from === 0
          ? new Promise<void>((done) => {
              release = () => {
                for (const r of day.records) if (r.tick < TICKS_PER_DAY) visit(r);
                done();
              };
            })
          : Promise.resolve(),
    });
    slow.panel.follow(resident!);
    slow.panel.frame(2000);
    await slow.settled();
    slow.panel.step(1);
    await slow.settled();
    release!();
    await slow.settled();
    expect(slow.last().label).toBe('Day 2, today');
    expect(slow.last().status).toBe('ready');
  });

  it('stops listening and reading when the follow ends', async () => {
    const t = setup();
    t.panel.follow(resident!);
    t.panel.frame(2000);
    await t.settled();
    expect(t.listeners.size).toBe(1);
    t.panel.follow(null);
    expect(t.listeners.size).toBe(0);
    const shown = t.views.length;
    t.panel.frame(3000);
    expect(t.views).toHaveLength(shown);
  });

  it('starts over for another resident', async () => {
    const ids = [...day.expected.keys()];
    const t = setup();
    t.panel.follow(ids[0]!);
    t.panel.frame(2000);
    await t.settled();
    t.panel.follow(ids[1]!);
    t.panel.frame(2000);
    await t.settled();
    expect(t.last().rows).toEqual(panelRows(ids[1]!, 0));
  });
});
