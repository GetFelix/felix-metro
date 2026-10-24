import { describe, expect, it } from 'vitest';
import { CityState, NO_BUILDING, type Journey, type TickEvent, type TickRecord, type Trips } from './city';
import type { City } from './layout';

const city = {
  lots: [0, 1, 2, 3].map((id) => ({ id, district: id < 2 ? 0 : 1 })),
} as unknown as City;

class FakeJourney implements Journey {
  freed = false;
  constructor(private readonly end: number) {}
  arrive() {
    return this.end;
  }
  positionAt() {}
  free() {
    this.freed = true;
  }
}

/** Trips of ten ticks, except for a resident the city has no trip for. */
const trips: Trips & { made: FakeJourney[] } = {
  made: [],
  trip(resident, _vehicle, depart) {
    if (resident === 999) return undefined;
    const j = new FakeJourney(depart + 10);
    this.made.push(j);
    return j;
  },
};

const record = (district: number, tick: number, events: TickEvent[] = [], keyframe: TickRecord['keyframe'] = null) =>
  ({ kind: 'tick', epoch: 1, district, tick, speed: 4, keyframeOffset: 0, wallUs: 0, keyframe, events }) as TickRecord;
const trip = (resident: number, depart: number): TickEvent => ({
  type: 'trip',
  resident,
  vehicle: 1,
  depart,
  route: [[3, 100]],
});

describe('CityState', () => {
  it('has a tick only once every district does', () => {
    const state = new CityState(city, trips, 2);
    expect(state.latest).toBe(-1);
    state.apply(record(0, 5));
    expect(state.latest).toBe(-1);
    state.apply(record(1, 4));
    expect(state.latest).toBe(4);
    state.apply(record(1, 6));
    expect(state.latest).toBe(5);
  });

  it('ignores a record it has already seen', () => {
    const state = new CityState(city, trips, 2);
    state.apply(record(0, 5, [trip(1, 5)]));
    state.apply(record(0, 5, [trip(2, 5)]));
    state.apply(record(0, 3, [trip(3, 3)]));
    expect([...state.voyages.keys()]).toEqual([1]);
  });

  it('turns trip events into voyages and frees them when they end', () => {
    trips.made.length = 0;
    const state = new CityState(city, trips, 2);
    const ended: number[] = [];
    state.onVoyageEnd = (v) => ended.push(v.resident);
    state.apply(record(0, 5, [trip(1, 5), trip(2, 5)]));
    state.apply(record(0, 6, [trip(1, 6)]));
    expect(ended).toEqual([1]);
    expect(trips.made[0]!.freed).toBe(true);
    state.retire(14);
    expect(state.voyages.size).toBe(2);
    state.retire(15);
    expect([...state.voyages.keys()]).toEqual([1]);
    expect(ended).toEqual([1, 2]);
    state.retire(16);
    expect(state.voyages.size).toBe(0);
  });

  it('counts a trip it cannot place instead of drawing it', () => {
    const state = new CityState(city, trips, 2);
    state.apply(record(0, 1, [trip(999, 1)]));
    expect(state.voyages.size).toBe(0);
    expect(state.unplaced).toBe(1);
  });

  it('follows built and demolished events and says which lots changed', () => {
    const state = new CityState(city, trips, 2);
    const told: [number, number | null][] = [];
    state.onLot = (lot, b) => told.push([lot, b?.kind ?? null]);
    state.apply(record(0, 1, [{ type: 'built', lot: 1, kind: 7, rotation: 2 }]));
    state.apply(record(0, 2, [{ type: 'built', lot: 1, kind: 7, rotation: 2 }]));
    state.apply(record(0, 3, [{ type: 'demolished', lot: 1, kind: 7, rotation: 2 }]));
    expect(told).toEqual([
      [1, 7],
      [1, NO_BUILDING],
    ]);
    expect(state.built.get(1)).toEqual({ kind: NO_BUILDING, rotation: 0 });
  });

  it('takes a district’s keyframe as all of its changes, and leaves other districts alone', () => {
    const state = new CityState(city, trips, 2);
    state.apply(record(0, 1, [{ type: 'built', lot: 0, kind: 5, rotation: 0 }]));
    state.apply(record(1, 1, [{ type: 'built', lot: 2, kind: 6, rotation: 1 }]));
    const told: [number, number | null][] = [];
    state.onLot = (lot, b) => told.push([lot, b?.kind ?? null]);
    state.apply(record(0, 240, [], { buildings: [[1, 9, 3]] }));
    expect(told).toEqual([
      [0, null],
      [1, 9],
    ]);
    expect([...state.built.keys()].sort()).toEqual([1, 2]);
  });

  it('lists what changed since a drawing began from an earlier state', () => {
    const state = new CityState(city, trips, 2);
    state.apply(record(0, 1, [{ type: 'built', lot: 0, kind: 5, rotation: 0 }]));
    const drawn = new Map(state.built);
    state.apply(record(0, 2, [{ type: 'built', lot: 1, kind: 8, rotation: 0 }]));
    state.apply(record(0, 3, [{ type: 'built', lot: 0, kind: 6, rotation: 0 }]));
    expect(state.changesSince(drawn)).toEqual([
      [0, { kind: 6, rotation: 0 }],
      [1, { kind: 8, rotation: 0 }],
    ]);
    expect(new CityState(city, trips, 2).changesSince(drawn)).toEqual([[0, null]]);
  });

  it('follows the sim’s speed', () => {
    const state = new CityState(city, trips, 2);
    state.apply(record(0, 1, [{ type: 'speed', ticksPerSecond: 16 }]));
    expect(state.speed).toBe(16);
  });
});
