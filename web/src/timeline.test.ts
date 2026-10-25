import { describe, expect, it, vi } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';
import {
  STEP_TICKS,
  MIN_SPAN,
  barSpan,
  guessOldest,
  createSpanHold,
  startsDrag,
  tickAtPointer,
  agoText,
  clampTick,
  dayBands,
  hourMarks,
  momentText,
  stepTick,
  tickAtFraction,
} from './timeline';

const range = { oldest: 480, newest: 480 + 3 * TICKS_PER_DAY };

describe('timeline maths', () => {
  it('maps a position along the bar to a tick inside the range', () => {
    expect(tickAtFraction(range, 0)).toBe(480);
    expect(tickAtFraction(range, 1)).toBe(range.newest);
    expect(tickAtFraction(range, 0.5)).toBe(480 + Math.round(1.5 * TICKS_PER_DAY));
    expect(tickAtFraction(range, -3)).toBe(480);
    expect(tickAtFraction(range, 7)).toBe(range.newest);
  });

  it('steps 15 city minutes, an hour with shift, and stops at both ends', () => {
    expect(STEP_TICKS).toBe(60);
    expect(stepTick(range, 1000, 1, false)).toBe(1060);
    expect(stepTick(range, 1000, -1, false)).toBe(940);
    expect(stepTick(range, 1000, 1, true)).toBe(1000 + TICKS_PER_HOUR);
    expect(stepTick(range, 500, -1, true)).toBe(480);
    expect(stepTick(range, range.newest - 10, 1, false)).toBe(range.newest);
    // Steps stop at the oldest moment, so a run of them is not the sum of their sizes.
    let at = range.oldest + 150;
    for (let i = 0; i < 3; i++) at = stepTick(range, at, -1, false);
    expect(at).toBe(range.oldest);
    expect(stepTick(range, at, 1, false)).toBe(range.oldest + STEP_TICKS);
    expect(clampTick(range, 1e9)).toBe(range.newest);
  });

  it('says how long ago in city time', () => {
    expect(agoText(0)).toBe('just now');
    expect(agoText(4 * 45)).toBe('45 m ago');
    expect(agoText(4 * (3 * 60 + 12))).toBe('3 h 12 m ago');
  });

  it('names a moment by day and time', () => {
    expect(momentText(0)).toBe('Day 1, 00:00');
    expect(momentText(TICKS_PER_DAY + 14 * TICKS_PER_HOUR + 60)).toBe('Day 2, 14:15');
  });

  it('lists the days the range touches and an hour mark for each city hour in it', () => {
    expect(dayBands(range).map((b) => b.day)).toEqual([1, 2, 3, 4]);
    const marks = hourMarks(range);
    expect(marks[0]).toEqual({ tick: 480, major: false });
    expect(marks.length).toBe(73);
    expect(marks.filter((m) => m.major).map((m) => (m.tick / TICKS_PER_HOUR) % 24)).toContain(6);
  });

  it('keeps only the major marks once the range is crowded', () => {
    const marks = hourMarks({ oldest: 0, newest: 6 * TICKS_PER_DAY });
    expect(marks.every((m) => m.major)).toBe(true);
    expect(marks.length).toBe(6 * 4 + 1);
  });
});

describe('a steady bar', () => {
  it('maps a held drag to stable ticks while the city grows', () => {
    const hold = createSpanHold();
    hold.set(barSpan(0, 1000));
    hold.hold();
    const first = tickAtPointer(hold.current, 0.5);
    let last = 1000;
    for (let tip = 1100; tip < 20000; tip += 700) {
      last = tip;
      hold.set(barSpan(0, tip));
      expect(tickAtPointer(hold.current, 0.5)).toBe(first);
    }
    // After the release the latest span is the one in use.
    hold.release();
    expect(hold.current.live).toBe(last);
    expect(tickAtPointer(hold.current, 0.5)).not.toBe(first);
  });

  it('releases at the right end on the live head the drag began with', () => {
    const hold = createSpanHold();
    hold.set(barSpan(0, 3 * TICKS_PER_DAY));
    hold.hold();
    hold.set(barSpan(0, 3 * TICKS_PER_DAY + 500));
    const held = hold.held!;
    expect(tickAtPointer(held, 1)).toBe(held.live);
    expect(tickAtPointer(held, 1)).toBe(3 * TICKS_PER_DAY);
    // The caller's snap: the tip it tests against is the held one, so this is "live", not the near past.
    expect(tickAtPointer(held, 1) >= held.live).toBe(true);
  });

  it('spans at least a day, with the live head short of the right end', () => {
    const young = barSpan(480, 480 + 600);
    expect(young.newest - young.oldest).toBe(MIN_SPAN);
    expect(young.live).toBe(1080);
    // The area right of the live head cannot be picked.
    expect(tickAtPointer(young, 1)).toBe(young.live);
    expect(tickAtPointer(young, 0)).toBe(480);
    expect(dayBands(young).map((b) => b.day)).toEqual([1, 2]);
    // An older city spans its whole history.
    const old = barSpan(0, 3 * TICKS_PER_DAY);
    expect(old.newest).toBe(old.live);
    // A tip at the oldest moment still has a span to draw.
    expect(barSpan(100, 100).live).toBe(101);
  });
});

describe('picking up the handle while live', () => {
  it('starts a drag from a primary press anywhere, and the press at the live head reads as live', () => {
    expect(startsDrag(0)).toBe(true);
    expect(startsDrag(2)).toBe(false);
    const span = barSpan(0, 3 * TICKS_PER_DAY);
    // A press on the head, at the right end, maps to the live tick, so the first drag move is a no-op until it moves left.
    expect(tickAtPointer(span, 1)).toBe(span.live);
    expect(tickAtPointer(span, 0.9)).toBeLessThan(span.live);
  });
});

describe('pressing the live head', () => {
  type Fake = {
    children: Fake[];
    listeners: Record<string, ((e: unknown) => void)[]>;
    [k: string]: unknown;
  };
  const fake = (): Fake => {
    const f: Fake = {
      children: [],
      listeners: {},
      className: '',
      style: { setProperty() {}, cssText: '' },
      dataset: {},
      classList: { toggle() {} },
      append(...c: Fake[]) {
        f.children.push(...c);
      },
      replaceChildren() {
        f.children = [];
      },
      setAttribute() {},
      setPointerCapture: () => {},
      focus() {},
      getBoundingClientRect: () => ({ left: 0, width: 1000 }),
      addEventListener(t: string, fn: (e: unknown) => void) {
        (f.listeners[t] ??= []).push(fn);
      },
    };
    return f;
  };
  const setup = async (live: boolean) => {
    vi.stubGlobal('document', { createElement: fake });
    const { createTimeline } = await import('./timeline');
    const root = fake();
    const moves: [number, string][] = [];
    let lives = 0;
    const bar = createTimeline(root as unknown as HTMLElement, {
      onMove: (t, p) => moves.push([t, p]),
      onStep() {},
      onLive: () => lives++,
      onEngage() {},
    });
    const tip = root.children.find((c) => c.className === 'strip')!.children.find((c) => c.className === 'tip')!;
    const view = { ready: true, oldest: 0, newest: 2 * TICKS_PER_DAY, at: live ? 2 * TICKS_PER_DAY : 5000, live };
    bar.update(view);
    const fire = (type: string, extra: object) =>
      root.listeners[type]!.forEach((fn) => fn({ button: 0, pointerId: 1, preventDefault() {}, ...extra }));
    return { bar, tip, moves, fire, lives: () => lives };
  };

  it('goes live from the past without a drag', async () => {
    const t = await setup(false);
    t.fire('pointerdown', { target: t.tip, clientX: 1000 });
    t.fire('pointerup', { target: t.tip, clientX: 990 });
    expect(t.lives()).toBe(1);
    expect(t.moves).toEqual([]);
    expect(t.bar.dragging).toBe(false);
  });

  it('picks the handle up at once while live', async () => {
    const t = await setup(true);
    t.fire('pointerdown', { target: t.tip, clientX: 1000 });
    expect(t.bar.dragging).toBe(true);
    t.fire('pointermove', { target: t.tip, clientX: 500 });
    expect(t.moves.at(-1)).toEqual([TICKS_PER_DAY, 'drag']);
    t.fire('pointerup', { target: t.tip, clientX: 500 });
    expect(t.lives()).toBe(0);
  });
});

describe('the days the bar labels', () => {
  const days = (oldest: number, tip: number) => dayBands(barSpan(oldest, tip)).map((b) => b.day);
  const liveFraction = (oldest: number, tip: number) => {
    const s = barSpan(oldest, tip);
    return (s.live - s.oldest) / (s.newest - s.oldest);
  };

  it('labels the days a span from mid-day, from 0 and after retention dropped the start', () => {
    expect(days(4000, 4600)).toEqual([1, 2]);
    expect(days(0, 4100)).toEqual([1, 2]);
    expect(days(0, 2 * TICKS_PER_DAY + 10)).toEqual([1, 2, 3]);
    expect(days(3 * TICKS_PER_DAY + 100, 4 * TICKS_PER_DAY + 500)).toEqual([4, 5]);
  });

  it('before the range is read, puts live at the right end and the tip on its own day', () => {
    const tip = 4100;
    const span = barSpan(guessOldest(tip), tip);
    expect(span.oldest).toBe(0);
    expect(liveFraction(span.oldest, tip)).toBeCloseTo(4100 / TICKS_PER_DAY);
    expect(dayBands(span)[0].day).toBe(1);
    const late = 9600;
    const s2 = barSpan(guessOldest(late), late);
    expect(s2.live).toBe(s2.newest);
    expect(dayBands(s2).map((b) => b.day)).toContain(2);
  });

  it('keeps the live fraction once the range is read', () => {
    expect(liveFraction(0, 4100)).toBeCloseTo(4100 / TICKS_PER_DAY);
    expect(liveFraction(0, 3 * TICKS_PER_DAY)).toBe(1);
  });
});
