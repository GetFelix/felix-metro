import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CityState, NO_BUILDING, type TickRecord } from './city';
import { Metro, generate, initSync } from './core/felix_metro_core.js';
import { KINDS } from './kinds';
import { parseCity, type City } from './layout';
import { fold, type SeekResult } from './seek';
import { GROUPS, createStats, groupOf, type CityStats } from './stats';

// The sim's own log of a morning, from 07:00 to 09:00 in a city of four districts, and what it says was on the road at
// every tick. sim/src/world/tests.rs writes it. A keyframe lists the residents on the road and counts the rest.
const fixture = JSON.parse(readFileSync(new URL('./stats-fixture.json', import.meta.url), 'utf8')) as {
  seed: string;
  districts: number;
  from: number;
  to: number;
  population: number;
  onRoad: number[];
  walkers: number[];
  records: { held: number; record: TickRecord }[];
};

const districts = fixture.districts ** 2;
let city: City;

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
  city = parseCity(generate(fixture.seed, fixture.districts));
});

/** The log by tick and district. A tick with nothing in it was not written to the fixture; it is a bare record. */
function log(): (tick: number, district: number) => TickRecord {
  const byKey = new Map<string, TickRecord>();
  for (const { held, record } of fixture.records) {
    // The fixture keeps the residents on the road and counts the rest; stand-ins make up the count.
    if (record.keyframe) {
      const road = record.keyframe.residents ?? [];
      const rest = Array.from({ length: held - road.length }, (_, i) => ({ id: -1 - i }));
      record.keyframe.residents = [...road, ...rest];
    }
    byKey.set(`${record.tick}/${record.district}`, record);
  }
  return (tick, district) =>
    byKey.get(`${tick}/${district}`) ?? {
      kind: 'tick',
      epoch: 1,
      district,
      tick,
      speed: 4,
      keyframeOffset: 0,
      wallUs: 0,
      keyframe: null,
      events: [],
    };
}

/** Who is on the road in a read of the stats; NaN when the state could not say. */
const road = (s: CityStats) => (s.cars ?? NaN) + (s.walkers ?? NaN);

const at = (tick: number) => tick - fixture.from;

/** Follows the log the way the page does: every district's records for a tick, then the stats for that tick. */
function follow(lead: number, onTick: (state: CityState, tick: number, read: ReturnType<typeof createStats>) => void) {
  const record = log();
  const metro = new Metro(fixture.seed, fixture.districts);
  const state = new CityState(city, metro, districts);
  const read = createStats(city);
  let next = fixture.from;
  for (let tick = fixture.from; tick <= fixture.to; tick++) {
    // Records ahead of the tick drawn, as a live page holds them.
    for (; next <= Math.min(tick + lead, fixture.to); next++) {
      for (let d = 0; d < districts; d++) state.apply(record(next, d));
    }
    state.retire(tick);
    onTick(state, tick, read);
  }
}

describe('the stats against the sim', () => {
  it('has a morning with a rush in it', () => {
    expect(Math.max(...fixture.onRoad)).toBeGreaterThan(50);
    expect(Math.max(...fixture.walkers)).toBeGreaterThan(5);
    expect(fixture.walkers.some((w, i) => fixture.onRoad[i]! > w)).toBe(true);
  });

  it('count who is on the road at every tick, cars and walkers apart', () => {
    follow(0, (state, tick, read) => {
      const s = read(state, tick);
      expect(road(s), `on the road at ${tick}`).toBe(fixture.onRoad[at(tick)]);
      expect(s.walkers, `walking at ${tick}`).toBe(fixture.walkers[at(tick)]);
    });
  });

  it('count the tick drawn when the state holds records ahead of it', () => {
    follow(40, (state, tick, read) => {
      const s = read(state, tick);
      expect(road(s), `on the road at ${tick}`).toBe(fixture.onRoad[at(tick)]);
      expect(s.walkers, `walking at ${tick}`).toBe(fixture.walkers[at(tick)]);
    });
  });

  it('match what each keyframe says, and know the population from the first', () => {
    let keyframes = 0;
    follow(0, (state, tick, read) => {
      const s = read(state, tick);
      expect(s.population).toBe(fixture.population);
      const frames = fixture.records.filter((r) => r.record.tick === tick && r.record.keyframe);
      if (frames.length === 0) return;
      keyframes++;
      const held = frames.reduce(
        (n, r) => n + (r.record.keyframe as unknown as { counts: { onRoad: number } }).counts.onRoad,
        0,
      );
      expect(road(s), `keyframe at ${tick}`).toBe(held);
    });
    expect(keyframes).toBe(3);
  });

  // The keyframes at 08:00 and 09:00 have people on the road with no trip event in what is folded.
  const starts = [fixture.from + 240, fixture.from + 480];
  const random = (start: number, each: (tick: number) => void) => {
    let seed = start;
    for (let i = 0; i < 40; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      each(start + (seed % (Math.min(240, fixture.to - start) + 1)));
    }
  };
  const fresh = () => new CityState(city, new Metro(fixture.seed, fixture.districts), districts);
  const expectSim = (state: CityState, tick: number, what: string) => {
    state.retire(tick);
    const s = createStats(city)(state, tick);
    expect(road(s), `${what} to ${tick}`).toBe(fixture.onRoad[at(tick)]);
    expect(s.walkers, `walking ${what} to ${tick}`).toBe(fixture.walkers[at(tick)]);
  };

  it('count a state folded from a keyframe, tick by tick, at random ticks', () => {
    const record = log();
    for (const start of starts) {
      random(start, (tick) => {
        const state = fresh();
        for (let t = start; t <= tick; t++) for (let d = 0; d < districts; d++) state.apply(record(t, d), true);
        expectSim(state, tick, `from ${start}`);
      });
    }
  });

  // A seek folds one district's records, then the next's. A traveller's arrival is in another district than the
  // keyframe that names them, so it can be folded first.
  it('count a state folded as a seek does, a district at a time, at random ticks', () => {
    const record = log();
    for (const start of starts) {
      random(start, (tick) => {
        const seek: SeekResult = {
          tick,
          requested: tick,
          exact: true,
          districts: Array.from({ length: districts }, (_, d) => ({
            records: Array.from({ length: tick - start + 1 }, (_, i) => record(start + i, d)),
            offset: tick,
            before: [],
          })),
        };
        const state = fresh();
        fold(state, seek);
        expectSim(state, tick, `seek from ${start}`);
      });
    }
  });
});

describe('buildings by kind', () => {
  it('only count what stands on a lot', () => {
    for (const [kind, k] of KINDS.entries()) {
      const g = groupOf(kind);
      if (k.model.startsWith('tree') || k.model === 'planter' || k.model.startsWith('detail'))
        expect(g).toBeUndefined();
      else if (k.pack === 'suburban') expect(g).toBe('homes');
    }
    expect(groupOf(NO_BUILDING)).toBeUndefined();
    expect(GROUPS.map((g) => g.id)).toEqual(['homes', 'shops', 'towers', 'factories']);
  });

  it('start from the generated city and follow the builds and demolitions', () => {
    const state = new CityState(city, new Metro(fixture.seed, fixture.districts), districts);
    const read = createStats(city);
    const before = read(state, 0).buildings;
    const total = (b: Record<string, number>) => Object.values(b).reduce((n, c) => n + c, 0);
    expect(total(before)).toBeGreaterThan(100);
    const home = city.lots.find((l) => groupOf(l.kind) === 'homes')!;
    const kind = KINDS.findIndex((k) => k.pack === 'industrial' && k.model === 'building-a');
    const event = (type: 'built' | 'demolished', lot: number, k: number) => ({ type, lot, kind: k, rotation: 0 });
    const record = (events: TickRecord['events']): TickRecord => ({
      kind: 'tick',
      epoch: 1,
      district: 0,
      tick: 1,
      speed: 4,
      keyframeOffset: 0,
      wallUs: 0,
      keyframe: null,
      events,
    });
    state.apply({ ...record([]), tick: 0 });
    state.apply(record([event('demolished', home.id, NO_BUILDING), event('built', home.id, kind)]));
    const after = read(state, 1).buildings;
    expect(after.homes).toBe(before.homes - 1);
    expect(after.factories).toBe(before.factories + 1);
    state.apply({ ...record([event('demolished', home.id, NO_BUILDING)]), tick: 2 });
    const bare = read(state, 2).buildings;
    expect(bare.homes).toBe(before.homes - 1);
    expect(bare.factories).toBe(before.factories);
  });
});
