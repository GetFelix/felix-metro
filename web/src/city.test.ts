import { describe, expect, it } from 'vitest';
import {
  CityState,
  NO_BUILDING,
  ROAD_ADDED,
  ROAD_CLOSED,
  ROAD_OPENED,
  ROAD_REMOVED,
  type Journey,
  type TickEvent,
  type TickRecord,
  type Trips,
} from './city';
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
  lots() {}
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
    state.apply(record(1, 5));
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
    state.retire(14);
    expect(state.voyages.size).toBe(2);
    state.retire(15);
    expect([...state.voyages.keys()]).toEqual([]);
    expect(ended).toEqual([1, 2]);
    expect(trips.made.every((j) => j.freed)).toBe(true);
  });

  it('keeps drawing a trip a resident’s next one replaced until it arrives', () => {
    trips.made.length = 0;
    const state = new CityState(city, trips, 2);
    const ended: number[] = [];
    state.onVoyageEnd = (v) => ended.push(v.depart);
    state.apply(record(0, 5, [trip(1, 5)]));
    state.apply(record(0, 6, [trip(1, 14)]));
    expect(ended).toEqual([]);
    expect([...state.active()].map((v) => v.depart)).toEqual([5, 14]);
    state.retire(14);
    expect(ended).toEqual([]);
    state.retire(15);
    expect(ended).toEqual([5]);
    expect(trips.made[0]!.freed).toBe(true);
    expect([...state.active()].map((v) => v.depart)).toEqual([14]);
  });

  it('finds the trip a resident is on at a tick by the resident number, from whichever district told of it', () => {
    const state = new CityState(city, trips, 2);
    // Resident 1 leaves from district 0; their next trip arrives in a record of district 1.
    state.apply(record(0, 5, [trip(1, 5)]));
    state.apply(record(1, 5, [trip(1, 14)]));
    expect(state.voyageAt(1, 4)).toBeUndefined();
    expect(state.voyageAt(1, 5)?.depart).toBe(5);
    // The earlier trip is replaced in the map but still on the road until it arrives.
    expect(state.voyageAt(1, 13)?.depart).toBe(5);
    expect(state.voyageAt(1, 16)?.depart).toBe(14);
    expect(state.voyageAt(1, 24)).toBeUndefined();
    expect(state.voyageAt(2, 8)).toBeUndefined();
  });

  it('refuses a record that skips a tick and takes it once the gap is filled', () => {
    const state = new CityState(city, trips, 2);
    expect(state.apply(record(0, 5))).toBe('applied');
    expect(state.apply(record(0, 7, [trip(1, 7)]))).toBe('gap');
    expect(state.ticks[0]).toBe(5);
    expect(state.voyages.size).toBe(0);
    expect(state.apply(record(0, 6))).toBe('applied');
    expect(state.apply(record(0, 7, [trip(1, 7)]))).toBe('applied');
    expect(state.voyages.size).toBe(1);
    // A keyframe repairs a gap, so it is never one.
    expect(state.apply(record(0, 240, [], { buildings: [] }))).toBe('applied');
    expect(state.apply(record(0, 300), true)).toBe('applied');
  });

  it('tells records apart by epoch, district and tick', () => {
    const state = new CityState(city, trips, 2);
    const at = (district: number, tick: number, epoch: number) => ({ ...record(district, tick), epoch });
    state.apply(at(0, 5, 2));
    expect(state.apply(at(0, 5, 2))).toBe('seen');
    expect(state.apply(at(0, 6, 1))).toBe('seen');
    // A new sim may re-commit a tick the old one had; the old one's records are the stale ones.
    expect(state.apply(at(0, 5, 3))).toBe('applied');
    expect(state.apply(at(0, 6, 2))).toBe('seen');
    expect(state.apply(at(0, 6, 3))).toBe('applied');
    expect(state.apply(at(1, 5, 1))).toBe('applied');
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

  it('adds up the districts’ funds once each has said its share, and follows the ledger', () => {
    const state = new CityState(city, trips, 2);
    expect(state.funds).toBeNull();
    state.apply(record(0, 240, [{ type: 'balance', amount: 5000 }]));
    expect(state.funds).toBeNull();
    state.apply(record(1, 240, [{ type: 'balance', amount: -200 }]));
    expect(state.funds).toBe(4800);
    // A build is spent in the district it is in, and the tick's balance, written last, agrees with it.
    state.apply(record(0, 241, [{ type: 'ledger', reason: 1, earned: 0, spent: 500 }]));
    expect(state.funds).toBe(4300);
    state.apply(
      record(1, 241, [
        { type: 'ledger', reason: 0, earned: 900, spent: 300 },
        { type: 'balance', amount: 400 },
      ]),
    );
    expect(state.funds).toBe(4900);
  });

  it('follows road events, and a keyframe replaces what its district knew', () => {
    const state = new CityState(city, trips, 2);
    state.apply(record(0, 1, [{ type: 'road', segment: 4, change: ROAD_CLOSED }]));
    state.apply(record(0, 2, [{ type: 'road', segment: 9, change: ROAD_ADDED }]));
    state.apply(record(1, 2, [{ type: 'road', segment: 20, change: ROAD_REMOVED }]));
    expect([...state.roads]).toEqual([
      [4, ROAD_CLOSED],
      [9, ROAD_ADDED],
      [20, ROAD_REMOVED],
    ]);
    state.apply(record(0, 3, [{ type: 'road', segment: 4, change: ROAD_OPENED }]));
    expect(state.roads.has(4)).toBe(false);
    // District 0's keyframe lists only what differs now, so segment 9 goes and district 1's entry stays.
    state.apply(record(0, 4, [], { buildings: [], roads: [[7, ROAD_CLOSED]] }));
    expect([...state.roads].sort((a, b) => a[0] - b[0])).toEqual([
      [7, ROAD_CLOSED],
      [20, ROAD_REMOVED],
    ]);
  });

  it('shows a command the same from events as from the keyframe after it', () => {
    const events = new CityState(city, trips, 2);
    events.apply(record(0, 1, [{ type: 'built', lot: 1, kind: 7, rotation: 2 }]));
    events.apply(record(0, 2, [{ type: 'demolished', lot: 0, kind: 3, rotation: 0 }]));
    const keyed = new CityState(city, trips, 2);
    keyed.apply(
      record(0, 240, [], {
        buildings: [
          [0, NO_BUILDING, 0],
          [1, 7, 2],
        ],
        roads: [],
      }),
    );
    expect([...keyed.built]).toEqual([...events.built].sort((a, b) => a[0] - b[0]));
  });

  it('ignores a command event with a result code it does not know', () => {
    const state = new CityState(city, trips, 2);
    const unknown = { type: 'command', principal: '00', name: 'x', id: 1, result: 250 } as unknown as TickEvent;
    expect(() => state.apply(record(0, 1, [unknown, { type: 'built', lot: 1, kind: 7, rotation: 0 }]))).not.toThrow();
    expect(state.built.get(1)).toEqual({ kind: 7, rotation: 0 });
  });

  describe('who built what', () => {
    const command = (name: string, result = 0): TickEvent => ({
      type: 'command',
      principal: `00000000000000${name.length}${name.length}`,
      name,
      id: 1,
      result,
    });
    const built = (lot: number): TickEvent => ({ type: 'built', lot, kind: 7, rotation: 2 });
    const author = (lot: number, tick: number, name: string): TickEvent => ({
      type: 'author',
      principal: `00000000000000${name.length}${name.length}`,
      name,
      lots: [[lot, tick]],
    });

    it('credits the sender of the command just before a built event, at that tick', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 9, [command('Ana'), built(1)]));
      expect(state.authors.get(1)).toEqual({ tick: 9, principal: '0000000000000033', name: 'Ana' });
    });

    it('credits nobody for a command that was refused, and not for a building it did not build', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 9, [command('Ana', 3), built(1)]));
      expect(state.authors.has(1)).toBe(false);
      // A command that built something does not carry over to the next building.
      state.apply(record(0, 10, [command('Bo'), built(0), built(1)]));
      expect(state.authors.get(0)!.name).toBe('Bo');
      expect(state.authors.has(1)).toBe(false);
    });

    it('credits the latest builder of a lot, and nobody once it is demolished', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 9, [command('Ana'), built(1)]));
      state.apply(record(0, 20, [command('Bo'), { type: 'demolished', lot: 1, kind: 7, rotation: 2 }]), true);
      expect(state.authors.has(1)).toBe(false);
      state.apply(record(0, 30, [command('Cy'), built(1)]), true);
      expect(state.authors.get(1)).toMatchObject({ tick: 30, name: 'Cy' });
    });

    it('learns the authors of a keyframe tick from its author events', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 240, [author(1, 9, 'Ana')], { buildings: [[1, 7, 2]], roads: [] }), true);
      expect(state.authors.get(1)).toEqual({ tick: 9, principal: '0000000000000033', name: 'Ana' });
    });

    it('takes every lot a builder’s author event lists', () => {
      const state = new CityState(city, trips, 2);
      const both: TickEvent = {
        type: 'author',
        principal: 'aa',
        name: 'Ana',
        lots: [
          [0, 7],
          [1, 9],
        ],
      };
      state.apply(
        record(0, 240, [both], {
          buildings: [
            [0, 7, 0],
            [1, 7, 0],
          ],
          roads: [],
        }),
        true,
      );
      expect([...state.authors].map(([lot, a]) => [lot, a.tick])).toEqual([
        [0, 7],
        [1, 9],
      ]);
    });

    it('is the same from a keyframe as from following the events', () => {
      const followed = new CityState(city, trips, 2);
      followed.apply(record(0, 9, [command('Ana'), built(1)]));
      const keyed = new CityState(city, trips, 2);
      keyed.apply(record(0, 240, [author(1, 9, 'Ana')], { buildings: [[1, 7, 2]], roads: [] }), true);
      expect([...keyed.authors]).toEqual([...followed.authors]);
    });

    it('carries on from a keyframe the way a seek folds it: its authors, then the commands after', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 240, [author(1, 9, 'Ana')], { buildings: [[1, 7, 2]], roads: [] }), true);
      state.apply(record(0, 241, [command('Bo'), built(0)]), true);
      state.apply(record(0, 242, [command('Cy'), { type: 'demolished', lot: 1, kind: 7, rotation: 2 }]), true);
      expect([...state.authors].map(([lot, a]) => [lot, a.name])).toEqual([[0, 'Bo']]);
    });

    it('drops the authors of a district a later keyframe says no longer have the building', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 9, [command('Ana'), built(1)]));
      state.apply(record(1, 9, [command('Bo'), built(2)]));
      state.apply(record(0, 240, [], { buildings: [], roads: [] }), true);
      expect([...state.authors.keys()]).toEqual([2]);
    });

    it('keeps the author of a lot rebuilt as exactly what was generated, which a keyframe does not list', () => {
      const state = new CityState(city, trips, 2);
      state.apply(record(0, 240, [author(1, 9, 'Ana')], { buildings: [], roads: [] }), true);
      expect(state.authors.get(1)!.name).toBe('Ana');
    });
  });
});
