import { describe, expect, it, vi } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));
const {
  clusterMarkers,
  clusterAt,
  clusterName,
  clusterTarget,
  createMarkerFeed,
  markerName,
  markersKey,
  mergeMarkers,
  parseMarkers,
  rushMarkers,
} = await import('./markers');

const MORNING = 8 * TICKS_PER_HOUR;
const EVENING = 17.25 * TICKS_PER_HOUR;
const stored = (day: number, ...marks: [number, number, string?][]) =>
  new TextEncoder().encode(
    JSON.stringify({
      kind: 'markers',
      day,
      markers: marks.map(([tick, type, by]) => ({ tick, type, subject: 1, what: 0, by: by ?? '' })),
    }),
  );
const built = (tick: number) => ({ tick, kind: 'built' as const, label: 'Mara built a building' });

describe('rush hour markers', () => {
  it('puts a morning and an evening peak on every day the span touches', () => {
    const marks = rushMarkers({ oldest: 0, live: 2 * TICKS_PER_DAY + 9 * TICKS_PER_HOUR });
    expect(marks.map((m) => m.tick)).toEqual([
      MORNING,
      EVENING,
      TICKS_PER_DAY + MORNING,
      TICKS_PER_DAY + EVENING,
      2 * TICKS_PER_DAY + MORNING,
    ]);
    expect(marks[0]).toEqual({ tick: MORNING, kind: 'rush', label: 'Morning rush hour' });
    expect(marks[1]!.label).toBe('Evening rush hour');
  });

  it('leaves out a peak before the oldest moment or after the live tip', () => {
    // A young city live at 16:00 on day 2 has had one peak that morning and none of its evening.
    const live = TICKS_PER_DAY + 16 * TICKS_PER_HOUR;
    const marks = rushMarkers({ oldest: MORNING + 1, live });
    expect(marks.map((m) => m.tick)).toEqual([EVENING, TICKS_PER_DAY + MORNING]);
    expect(rushMarkers({ oldest: 0, live: MORNING - 1 })).toEqual([]);
    // The tip itself has happened.
    expect(rushMarkers({ oldest: 0, live: MORNING })).toHaveLength(1);
  });
});

describe('what builders did', () => {
  it('labels a stored change with who made it', () => {
    const parsed = parseMarkers(stored(0, [100, 1, 'Mara'], [200, 2, 'Bo'], [300, 3, 'Cy'], [400, 1]));
    expect(parsed?.markers.map((m) => [m.kind, m.label])).toEqual([
      ['built', 'Mara built a building'],
      ['demolished', 'Bo tore a building down'],
      ['road', 'Cy closed a road'],
      ['built', 'A building went up'],
    ]);
  });

  it('skips a marker of a kind it does not know and refuses bytes that are not markers', () => {
    expect(parseMarkers(stored(0, [1, 9], [2, 1]))?.markers).toHaveLength(1);
    expect(parseMarkers(new TextEncoder().encode('{"kind":"tick"}'))).toBeNull();
    expect(parseMarkers(new TextEncoder().encode('not json'))).toBeNull();
  });

  it('shows no change that happened after the live tip or before the oldest moment', () => {
    const span = { oldest: 1000, live: 3000 };
    const merged = mergeMarkers(span, [built(500), built(1000), built(2500), built(3000), built(3001), built(9000)]);
    expect(merged.filter((m) => m.kind === 'built').map((m) => m.tick)).toEqual([1000, 2500, 3000]);
  });

  it('merges with the rush hours in order', () => {
    const merged = mergeMarkers({ oldest: 0, live: TICKS_PER_DAY }, [built(EVENING), built(100)]);
    expect(merged.map((m) => [m.tick, m.kind])).toEqual([
      [100, 'built'],
      [MORNING, 'rush'],
      [EVENING, 'rush'],
      [EVENING, 'built'],
    ]);
  });
});

describe('the marker feed', () => {
  const day = (n: number) => n * TICKS_PER_DAY;

  it('reads a finished day once and the tip’s day every time', async () => {
    const read = vi.fn(async (d: number) => stored(d, [day(d) + 10, 1, 'Mara']));
    const feed = createMarkerFeed(read);
    const span = { oldest: 0, live: day(2) + 50 };
    expect(await feed.load(span)).toBe(true);
    expect(read.mock.calls.map(([d]) => d).sort()).toEqual([0, 1, 2]);
    read.mockClear();
    expect(await feed.load(span)).toBe(false);
    expect(read.mock.calls.map(([d]) => d)).toEqual([2]);
    expect(feed.stored.map((m) => m.tick)).toEqual([10, day(1) + 10, day(2) + 10]);
  });

  it('reports a day that grew, and settles it once the tip moves to the next day', async () => {
    let marks: [number, number, string][] = [[day(1) + 10, 1, 'Mara']];
    const read = vi.fn(async (d: number) => (d === 1 ? stored(1, ...marks) : null));
    const feed = createMarkerFeed(read);
    await feed.load({ oldest: day(1), live: day(1) + 100 });
    marks = [...marks, [day(1) + 60, 1, 'Bo']];
    expect(await feed.load({ oldest: day(1), live: day(1) + 100 })).toBe(true);
    expect(feed.stored).toHaveLength(2);
    // The tip moves on: the last read of day 1 is its final one.
    await feed.load({ oldest: day(1), live: day(2) + 5 });
    read.mockClear();
    await feed.load({ oldest: day(1), live: day(2) + 9 });
    expect(read.mock.calls.map(([d]) => d)).toEqual([2]);
  });

  it('leaves a day whose read failed unsettled and reads it again after a wait', async () => {
    let fail = true;
    let now = 0;
    const read = vi.fn(async (d: number) => {
      if (fail) throw new Error('timeout');
      return stored(d, [day(d) + 1, 1, 'Mara']);
    });
    const feed = createMarkerFeed(read, () => now);
    // Day 0 is over; a failed read of it must not be taken for a day with nothing.
    const span = { oldest: 0, live: day(1) + 5 };
    expect(await feed.load(span)).toBe(false);
    expect(feed.stored).toEqual([]);
    read.mockClear();
    // Within the wait nothing is asked; after it, the read is made and the day fills in.
    now = 500;
    await feed.load(span);
    expect(read).not.toHaveBeenCalled();
    fail = false;
    now = 1500;
    expect(await feed.load(span)).toBe(true);
    expect(feed.stored.map((m) => m.tick)).toEqual([1, day(1) + 1]);
    read.mockClear();
    now = 1600;
    await feed.load(span);
    expect(read.mock.calls.map(([d]) => d)).toEqual([1]);
  });

  it('counts the wait from when the read failed, not from when the load began', async () => {
    let now = 0;
    const read = vi.fn(async () => {
      now += 20_000;
      throw new Error('timeout');
    });
    const feed = createMarkerFeed(read, () => now);
    const span = { oldest: 0, live: 5 };
    await feed.load(span);
    read.mockClear();
    // The read took 20 s to fail. Half a second after that is inside its 1 s wait.
    now += 500;
    await feed.load(span);
    expect(read).not.toHaveBeenCalled();
    now += 600;
    await feed.load(span);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('waits longer after each failure, to half a minute', async () => {
    let now = 0;
    const read = vi.fn(async () => {
      throw new Error('timeout');
    });
    const feed = createMarkerFeed(read, () => now);
    const span = { oldest: 0, live: 5 };
    await feed.load(span);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      let wait = 0;
      for (;;) {
        read.mockClear();
        await feed.load(span);
        if (read.mock.calls.length) break;
        now += 500;
        wait += 500;
      }
      waits.push(wait);
    }
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...waits)).toBe(30_000);
  });

  it('forgets the failures of days that have left the span', async () => {
    let now = 0;
    const read = vi.fn(async (_day: number) => {
      throw new Error('timeout');
    });
    const feed = createMarkerFeed(read, () => now);
    await feed.load({ oldest: 0, live: day(1) + 5 });
    await feed.load({ oldest: day(1), live: day(1) + 5 });
    // Day 0 is back in the span (the city restarted with an older oldest): it is read at once, not held to old waits.
    read.mockClear();
    await feed.load({ oldest: 0, live: day(1) + 5 });
    expect(read.mock.calls.map(([d]) => d)).toContain(0);
  });

  it('keeps what it had when a read fails and tries it again', async () => {
    let fail = false;
    const feed = createMarkerFeed(async (d) => {
      if (fail) throw new Error('closed');
      return stored(d, [day(d) + 1, 1, 'Mara']);
    });
    await feed.load({ oldest: 0, live: 10 });
    fail = true;
    expect(await feed.load({ oldest: 0, live: 20 })).toBe(false);
    expect(feed.stored).toHaveLength(1);
  });

  it('treats a day with nothing stored as empty, and a list written for another day as empty', async () => {
    const feed = createMarkerFeed(async (d) => (d === 0 ? null : stored(7, [1, 1])));
    await feed.load({ oldest: 0, live: day(1) + 5 });
    expect(feed.stored).toEqual([]);
  });

  it('drops the days retention took', async () => {
    const feed = createMarkerFeed(async (d) => stored(d, [day(d) + 1, 1, 'Mara']));
    await feed.load({ oldest: 0, live: day(2) + 5 });
    expect(await feed.load({ oldest: day(1), live: day(2) + 5 })).toBe(true);
    expect(feed.stored.map((m) => m.tick)).toEqual([day(1) + 1, day(2) + 1]);
  });

  it('keys a day’s list by the day counted from 0', () => {
    expect(markersKey(0)).toBe('markers.0');
    expect(markersKey(12)).toBe('markers.12');
  });
});

describe('clusters', () => {
  const at = (...ticks: number[]) => clusterMarkers(ticks.map(built), 100);

  it('joins markers closer than the gap and keeps the rest apart', () => {
    expect(at(0, 40, 99, 100, 500).map((c) => [c.tick, c.markers.length])).toEqual([
      [0, 3],
      [100, 1],
      [500, 1],
    ]);
    expect(at()).toEqual([]);
  });

  it('measures from the first marker so a long run still splits', () => {
    const clusters = at(0, 60, 120, 180, 240);
    expect(clusters.map((c) => c.markers.length)).toEqual([2, 2, 1]);
  });

  it('walks through a cluster one click at a time and wraps', () => {
    const [cluster] = at(10, 30, 50);
    expect(clusterTarget(cluster!, 0)).toBe(10);
    expect(clusterTarget(cluster!, 10)).toBe(30);
    expect(clusterTarget(cluster!, 30)).toBe(50);
    expect(clusterTarget(cluster!, 50)).toBe(10);
    expect(clusterTarget(cluster!, 9999)).toBe(10);
  });

  it('keeps focus on the button that holds a moment when clusters regroup', () => {
    const before = at(0, 300, 600);
    expect(before).toHaveLength(3);
    // The focused one starts at 300. Widened, it joins the first; the button that holds it is that one.
    const wider = clusterMarkers([0, 300, 600].map(built), 400);
    expect(clusterAt(wider, 300)).toBe(0);
    expect(clusterAt(before, 300)).toBe(1);
    expect(clusterAt(before, 450)).toBe(1);
    expect(clusterAt(before, -5)).toBe(-1);
  });

  it('names a marker and a cluster for a screen reader', () => {
    const one = built(TICKS_PER_DAY + 14 * TICKS_PER_HOUR + 60);
    expect(markerName(one)).toBe('Mara built a building, Day 2, 14:15');
    expect(clusterName({ tick: one.tick, markers: [one] })).toBe(markerName(one));
    const many = {
      tick: MORNING,
      markers: [built(MORNING), built(MORNING + 4), { ...built(MORNING + 8), label: 'Bo tore a building down' }],
    };
    expect(clusterName(many)).toBe('3 moments from Day 1, 08:00: Mara built a building, Bo tore a building down');
  });
});
