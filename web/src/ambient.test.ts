import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';
import {
  MAX_VANS,
  ROOST_SHARE,
  SIGNAL_TICKS,
  SMOKE_TICKS,
  TRUCK_KIND,
  VAN_KIND,
  birdVisit,
  buildRoads,
  dayOf,
  hasRoost,
  hourOf,
  makeRoute,
  planDay,
  puffAge,
  roll,
  routePose,
  seedNumber,
  shopOpen,
  signalAt,
  smokeLevel,
  type LotTile,
  type Placed,
  type RoadTile,
} from './ambient';

const SEED = seedNumber('harbor');
const at = (hour: number) => hour * TICKS_PER_HOUR;

describe('seeds and hours', () => {
  it('turns a seed string into one number, and different seeds into different ones', () => {
    expect(seedNumber('harbor')).toBe(seedNumber('harbor'));
    expect(seedNumber('harbor')).not.toBe(seedNumber('lakeside'));
  });

  it('rolls a fixed number in [0, 1) for a seed and two integers', () => {
    for (let i = 0; i < 200; i++) {
      const r = roll(SEED, i, 3);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      expect(roll(SEED, i, 3)).toBe(r);
    }
    expect(roll(SEED, 1, 3)).not.toBe(roll(SEED, 2, 3));
    expect(roll(SEED, 1, 3)).not.toBe(roll(seedNumber('lakeside'), 1, 3));
  });

  it('reads the hour and the day off a tick', () => {
    expect(hourOf(0)).toBe(0);
    expect(hourOf(at(17.5))).toBe(17.5);
    expect(hourOf(TICKS_PER_DAY + at(3))).toBe(3);
    expect(hourOf(-at(1))).toBe(23);
    expect(dayOf(TICKS_PER_DAY - 1)).toBe(0);
    expect(dayOf(TICKS_PER_DAY)).toBe(1);
  });
});

describe('shopOpen', () => {
  const lots = Array.from({ length: 60 }, (_, i) => i);

  it('is dark at night, lit through the day and dark again after closing', () => {
    for (const lot of lots) {
      expect(shopOpen(3, SEED, lot)).toBe(0);
      expect(shopOpen(12.5, SEED, lot)).toBe(1);
      expect(shopOpen(23, SEED, lot)).toBe(0);
    }
  });

  it('opens between 07:30 and 09:40 and closes between 18:00 and 22:10, each shop at its own hour', () => {
    for (const lot of lots) {
      expect(shopOpen(7.49, SEED, lot)).toBe(0);
      expect(shopOpen(9.7, SEED, lot)).toBe(1);
      expect(shopOpen(17.99, SEED, lot)).toBe(1);
      expect(shopOpen(22.2, SEED, lot)).toBe(0);
    }
    const opens = new Set(
      lots.map((l) => {
        let h = 7;
        while (shopOpen(h, SEED, l) < 0.5) h += 0.01;
        return h.toFixed(2);
      }),
    );
    expect(opens.size).toBeGreaterThan(20);
  });

  it('fades in and out smoothly', () => {
    for (const lot of lots) {
      let last = 0;
      for (let h = 7; h <= 10; h += 0.01) {
        const v = shopOpen(h, SEED, lot);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
      }
    }
  });
});

describe('smokeLevel and puffAge', () => {
  it('smokes on work hours and not at night or in the evening', () => {
    for (let lot = 0; lot < 40; lot++) {
      expect(smokeLevel(2, SEED, lot)).toBe(0);
      expect(smokeLevel(5.4, SEED, lot)).toBe(0);
      expect(smokeLevel(12, SEED, lot)).toBe(1);
      expect(smokeLevel(18.8, SEED, lot)).toBe(0);
      expect(smokeLevel(22, SEED, lot)).toBe(0);
    }
  });

  it('starts each stack at its own hour', () => {
    const levels = new Set(Array.from({ length: 40 }, (_, l) => smokeLevel(6.5, SEED, l).toFixed(3)));
    expect(levels.size).toBeGreaterThan(5);
  });

  it('keeps every puff in [0, 1), spaced evenly and repeating every SMOKE_TICKS', () => {
    const n = 4;
    for (let t = 0; t < 100; t += 0.7) {
      const ages = Array.from({ length: n }, (_, i) => puffAge(t, SEED, 7, i, n));
      for (const a of ages) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }
      const sorted = [...ages].sort((a, b) => a - b);
      for (let i = 1; i < n; i++) expect(sorted[i]! - sorted[i - 1]!).toBeCloseTo(1 / n, 6);
      expect(puffAge(t + SMOKE_TICKS, SEED, 7, 0, n)).toBeCloseTo(ages[0]!, 6);
    }
  });

  it('has a puff older as the tick goes on, and younger as it goes back', () => {
    const a = puffAge(100, SEED, 3, 0, 3);
    const b = puffAge(101, SEED, 3, 0, 3);
    expect((b - a + 1) % 1).toBeCloseTo(1 / SMOKE_TICKS, 6);
    expect(puffAge(100, SEED, 3, 0, 3)).toBe(a);
  });
});

describe('birdVisit', () => {
  it('has no flock before dawn or after the morning, one landed by 06:30 only on days it comes, and gone by 08:40', () => {
    for (let lot = 0; lot < 40; lot++) {
      expect(birdVisit(3, SEED, lot).here).toBe(false);
      expect(birdVisit(12, SEED, lot).here).toBe(false);
      expect(birdVisit(8.7, SEED, lot).here).toBe(false);
      const v = birdVisit(6.5, SEED, lot);
      expect(v.here).toBe(true);
      expect(v.landing).toBe(1);
    }
  });

  it('lands and leaves in about seven minutes', () => {
    const lot = 5;
    const arrive = 5 + roll(SEED, lot, 6);
    expect(birdVisit(arrive - 0.01, SEED, lot).here).toBe(false);
    expect(birdVisit(arrive + 0.06, SEED, lot).landing).toBeCloseTo(0.5, 5);
    expect(birdVisit(arrive + 0.13, SEED, lot).landing).toBe(1);
    const leave = 7 + 1.5 * roll(SEED, lot, 7);
    expect(birdVisit(leave + 0.06, SEED, lot).leaving).toBeCloseTo(0.5, 5);
    expect(birdVisit(leave + 0.13, SEED, lot).here).toBe(false);
  });

  it('settles on about the share of roofs it says', () => {
    const n = 2000;
    const roosts = Array.from({ length: n }, (_, l) => hasRoost(SEED, l)).filter(Boolean).length;
    expect(roosts / n).toBeGreaterThan(ROOST_SHARE - 0.05);
    expect(roosts / n).toBeLessThan(ROOST_SHARE + 0.05);
  });
});

describe('signalAt', () => {
  it('never shows two roads a go at once, and gives each its turn', () => {
    for (let node = 0; node < 10; node++) {
      let both = 0;
      let nsGreen = 0;
      let ewGreen = 0;
      for (let t = 0; t < SIGNAL_TICKS * 3; t += 0.5) {
        const s = signalAt(t, SEED, node);
        if (s.ns !== 'red' && s.ew !== 'red') both++;
        if (s.ns === 'green') nsGreen++;
        if (s.ew === 'green') ewGreen++;
      }
      expect(both).toBe(0);
      expect(nsGreen).toBe(ewGreen);
      expect(nsGreen).toBeGreaterThan(0);
    }
  });

  it('goes green, then amber, then red on each road', () => {
    const order: string[] = [];
    for (let t = 0; t < SIGNAL_TICKS; t += 0.25) {
      const l = signalAt(t, SEED, 3).ns;
      if (order[order.length - 1] !== l) order.push(l);
    }
    // The cycle wraps somewhere inside the sampled span, so look for the three in sequence.
    expect(order.join(',')).toMatch(/green,amber,red|amber,red,green|red,green,amber/);
  });

  it('repeats every cycle, so the same tick is the same picture however it was reached', () => {
    const forward = Array.from({ length: 100 }, (_, t) => signalAt(t * 0.9, SEED, 4));
    const back = Array.from({ length: 100 }, (_, i) => signalAt((99 - i) * 0.9, SEED, 4)).reverse();
    expect(back).toEqual(forward);
    expect(signalAt(11.3 + SIGNAL_TICKS * 5, SEED, 4)).toEqual(signalAt(11.3, SEED, 4));
  });

  it('puts neighbouring crossings out of step', () => {
    const phases = new Set(Array.from({ length: 12 }, (_, n) => JSON.stringify(signalAt(10, SEED, n))));
    expect(phases.size).toBeGreaterThan(1);
  });
});

/** A street of road tiles along z = 4 from x = 0 to 9 with a side road up at x = 5, and a lot on each side of the street. */
function street() {
  const roads: RoadTile[] = [];
  for (let x = 0; x <= 9; x++) roads.push({ x, z: 4 });
  for (let z = 0; z < 4; z++) roads.push({ x: 5, z });
  const lots: LotTile[] = [];
  for (let x = 0; x <= 9; x++) {
    if (x !== 5) lots.push({ id: x, x, z: 3, building: true, commercial: x < 5 });
    lots.push({ id: 10 + x, x, z: 5, building: true, commercial: false });
  }
  return { roads, lots, graph: buildRoads(roads, lots) };
}

describe('buildRoads', () => {
  it('links neighbouring tiles, finds a door beside each, and marks shopping streets', () => {
    const { graph } = street();
    expect(graph.next[0]).toEqual([1]);
    expect([...graph.next[5]!].sort((a, b) => a - b)).toEqual([4, 6, 13]);
    expect(graph.door[0]).toBeGreaterThanOrEqual(0);
    expect(graph.shopping[0]).toBe(1);
    expect(graph.shopping[9]).toBe(0);
  });
});

describe('makeRoute', () => {
  const spec = (pick: (i: number) => number, start = 0) => ({
    pick,
    start,
    steps: 60,
    ticksPerTile: 3,
    dwell: (_t: number, i: number) => (i % 5 === 0 ? 4 : 0),
  });

  it('is the same route for the same picks', () => {
    const { graph } = street();
    const pick = (i: number) => roll(SEED, i, 1);
    expect(makeRoute(graph, spec(pick))).toEqual(makeRoute(graph, spec(pick)));
  });

  it('moves one tile at a time, only turns round at a dead end, and takes time for tiles and stops', () => {
    const { graph } = street();
    const r = makeRoute(
      graph,
      spec((i) => roll(SEED, i, 2), 3),
    );
    for (let i = 1; i < r.tiles.length; i++) {
      expect(graph.next[r.tiles[i - 1]!]).toContain(r.tiles[i]);
      expect(r.arrive[i]! - r.leave[i - 1]!).toBe(3);
      expect(r.leave[i]! - r.arrive[i]!).toBe(i % 5 === 0 ? 4 : 0);
      if (i > 1 && r.tiles[i] === r.tiles[i - 2]) {
        expect(graph.next[r.tiles[i - 1]!]!.length).toBe(1);
      }
    }
    expect(r.total).toBe(r.leave[r.leave.length - 1]);
  });

  it('prefers the tiles it is asked to', () => {
    const { graph } = street();
    const r = makeRoute(graph, { ...spec((i) => roll(SEED, i, 3), 5), prefer: (t) => graph.x[t]! < 5 });
    expect(graph.x[r.tiles[1]!]).toBe(4);
  });
});

describe('routePose', () => {
  const { graph, lots } = street();
  const lotAt = (id: number) => {
    const l = lots.find((x) => x.id === id);
    return l ? { x: l.x, z: l.z } : null;
  };
  // Straight east along the street from tile 0 to tile 4, one stop at tile 2.
  const route = makeRoute(graph, {
    pick: () => 0,
    start: 0,
    steps: 4,
    ticksPerTile: 4,
    dwell: (t) => (t === 2 ? 6 : 0),
  });
  const out: Placed = { x: 0, z: 0, heading: 0, size: 0 };

  it('is nowhere before the drive and after it', () => {
    expect(routePose(graph, route, -1, lotAt, out)).toBe(false);
    expect(routePose(graph, route, route.total, lotAt, out)).toBe(false);
  });

  it('drives east in its lane, and stands still at the stop with its heading', () => {
    expect(routePose(graph, route, 6, lotAt, out)).toBe(true);
    expect(out.heading).toBeCloseTo(Math.PI / 2);
    expect(out.size).toBe(1);
    expect(out.x).toBeCloseTo(1.5);
    const arrive = route.arrive[2]!;
    routePose(graph, route, arrive + 1, lotAt, out);
    const standing = { ...out };
    routePose(graph, route, arrive + 5, lotAt, out);
    expect(out).toEqual(standing);
    expect(out.x).toBeCloseTo(2);
    expect(out.heading).toBeCloseTo(Math.PI / 2);
  });

  it('comes out of a lot door at the start and goes into one at the end', () => {
    routePose(graph, route, 0, lotAt, out);
    expect(out.size).toBe(0);
    // The door of tile 0 is the lot north of it, at z = 3.
    expect(out.z).toBeCloseTo(3);
    routePose(graph, route, route.total - 0.01, lotAt, out);
    expect(out.size).toBeCloseTo(0, 1);
    routePose(graph, route, 3, lotAt, out);
    expect(out.size).toBe(1);
  });

  it('gives the same pose at a time however the times are visited', () => {
    const times = Array.from({ length: 40 }, (_, i) => (i * route.total) / 40 + 0.3);
    const poses = (ts: number[]) => ts.map((t) => (routePose(graph, route, t, lotAt, out), { ...out }));
    const forward = poses(times);
    const back = poses([...times].reverse()).reverse();
    expect(back).toEqual(forward);
  });
});

describe('planDay', () => {
  const { graph } = street();

  it('is the same for the same seed and day, and different on another day', () => {
    expect(planDay(graph, SEED, 4)).toEqual(planDay(graph, SEED, 4));
    expect(planDay(graph, SEED, 4)).not.toEqual(planDay(graph, SEED, 5));
    expect(planDay(graph, SEED, 4)).not.toEqual(planDay(graph, seedNumber('lakeside'), 4));
  });

  it('sets the garbage truck off in the morning and the vans through the working day', () => {
    for (let day = 0; day < 20; day++) {
      const rounds = planDay(graph, SEED, day);
      const trucks = rounds.filter((r) => r.kind === TRUCK_KIND);
      const vans = rounds.filter((r) => r.kind === VAN_KIND);
      expect(trucks).toHaveLength(1);
      expect(vans).toHaveLength(MAX_VANS);
      for (const t of trucks) {
        expect(t.start).toBeGreaterThanOrEqual(6 * TICKS_PER_HOUR);
        expect(t.start).toBeLessThanOrEqual(7.5 * TICKS_PER_HOUR);
        expect(t.start + t.route.total).toBeLessThan(12 * TICKS_PER_HOUR);
      }
      for (const v of vans) {
        expect(v.start).toBeGreaterThanOrEqual(8 * TICKS_PER_HOUR);
        expect(v.start + v.route.total).toBeLessThan(TICKS_PER_DAY);
      }
    }
  });

  it('keeps the vans on commercial streets where it can, and stops them there', () => {
    const vans = planDay(graph, SEED, 1).filter((r) => r.kind === VAN_KIND);
    for (const v of vans) {
      const shopping = v.route.tiles.filter((t) => graph.shopping[t] === 1).length;
      expect(shopping / v.route.tiles.length).toBeGreaterThan(0.5);
      expect(v.route.leave.some((l, i) => l > v.route.arrive[i]!)).toBe(true);
    }
  });

  it('plans nothing for a city with no roads', () => {
    expect(planDay(buildRoads([], []), SEED, 0)).toEqual([]);
  });
});
