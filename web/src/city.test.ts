import { describe, expect, it } from 'vitest';
import {
  CityState,
  syncRoads,
  NO_BUILDING,
  ROAD_ADDED,
  ROAD_REMOVED,
  type Journey,
  type TickEvent,
  type TickRecord,
  type Trips,
  type Voyage,
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

  it('tells of each command event once, as the records are taken', () => {
    const state = new CityState(city, trips, 2);
    const seen: [number, number][] = [];
    state.onCommand = (e) => seen.push([e.id, e.result]);
    const command = (id: number, result: number): TickEvent => ({
      type: 'command',
      principal: '00000000000000ff',
      name: 'Ana',
      id,
      result,
    });
    state.apply(record(0, 5, [command(7, 0), command(8, 3)]));
    state.apply(record(0, 5, [command(9, 0)]));
    state.apply(record(1, 5, [command(10, 8)]));
    expect(seen).toEqual([
      [7, 0],
      [8, 3],
      [10, 8],
    ]);
  });

  it('takes command events with nobody listening', () => {
    const state = new CityState(city, trips, 2);
    expect(state.apply(record(0, 5, [{ type: 'command', principal: '0', name: 'A', id: 1, result: 0 }]))).toBe(
      'applied',
    );
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

  it('keeps the newest council event', () => {
    const state = new CityState(city, trips, 2);
    expect(state.council).toBeNull();
    const standing = { demand: 48, measure: 62, satisfaction: 77, unhappyDays: 0 };
    const council = (days: number) => ({ type: 'council' as const, days, patience: 3, standings: [standing] });
    state.apply(record(0, 240, [council(0)]));
    state.apply(record(0, 241, [council(1)]));
    expect(state.council?.days).toBe(1);
  });

  it('keeps the newest policy event', () => {
    const state = new CityState(city, trips, 2);
    expect(state.policy).toBeNull();
    const policy = (hours: number) => ({
      type: 'policy' as const,
      settings: [{ value: hours, changed: hours ? 100 : null }],
    });
    state.apply(record(0, 240, [policy(0)]));
    state.apply(record(0, 241, [policy(2)]));
    expect(state.policy?.settings[0]?.value).toBe(2);
  });

  const roadwork = (segment: number, change: number, a = 1, b = 2): TickEvent => ({
    type: 'roadwork',
    segment,
    change,
    a,
    b,
  });

  it('keeps every road a builder added, live or taken away, and a keyframe replaces what its district knew', () => {
    const state = new CityState(city, trips, 2);
    let told = 0;
    state.onRoads = () => told++;
    state.apply(record(0, 1, [roadwork(104, ROAD_ADDED, 6, 7)]));
    state.apply(record(0, 2, [roadwork(105, ROAD_ADDED, 3, 4)]));
    state.apply(record(1, 2, [roadwork(106, ROAD_ADDED, 30, 31)]));
    state.apply(record(0, 3, [roadwork(104, ROAD_REMOVED, 6, 7)]));
    expect(told).toBe(4);
    // A road taken away keeps its entry: its id is never used again.
    expect([...state.roads]).toEqual([
      [104, { change: ROAD_REMOVED, a: 6, b: 7 }],
      [105, { change: ROAD_ADDED, a: 3, b: 4 }],
      [106, { change: ROAD_ADDED, a: 30, b: 31 }],
    ]);
    // District 0's keyframe lists every road of its own, so 105, which it leaves out, goes; district 1's road stays.
    state.apply(record(0, 4, [], { buildings: [], roads: [[104, ROAD_REMOVED, 6, 7]] }));
    expect([...state.roads.keys()].sort()).toEqual([104, 106]);
    expect(told).toBe(5);
    // A keyframe that says what the state already knows changes nothing.
    state.apply(record(1, 4, [], { buildings: [], roads: [[106, ROAD_ADDED, 30, 31]] }));
    expect(told).toBe(5);
  });

  it('lists the built roads in segment order as core takes them, the same array until they change', () => {
    const state = new CityState(city, trips, 2);
    expect(state.builtRoads()).toEqual(new Uint32Array(0));
    state.apply(record(1, 1, [roadwork(110, ROAD_ADDED, 30, 31)]));
    state.apply(record(0, 1, [roadwork(108, ROAD_ADDED, 6, 7), roadwork(108, ROAD_REMOVED, 6, 7)]));
    const list = state.builtRoads();
    expect([...list]).toEqual([108, 6, 7, 1, 110, 30, 31, 0]);
    expect(state.builtRoads()).toBe(list);
    state.apply(record(0, 2, [roadwork(111, ROAD_ADDED, 1, 2)]));
    expect(state.builtRoads()).not.toBe(list);
  });

  it('gives core the built roads before it turns a trip into a journey, and only when they changed', () => {
    const given: number[][] = [];
    const seen: number[] = [];
    const metro: Trips = {
      trip(_resident, _vehicle, depart) {
        seen.push(given.length);
        return new FakeJourney(depart + 10);
      },
      setRoads(roads) {
        given.push([...roads]);
      },
    };
    const state = new CityState(city, metro, 2);
    state.apply(record(0, 1, [trip(1, 1)]));
    expect(given).toEqual([]);
    state.apply(record(0, 2, [roadwork(104, ROAD_ADDED, 6, 7), trip(2, 2), trip(3, 2)]));
    expect(given).toEqual([[104, 6, 7, 0]]);
    expect(seen).toEqual([0, 1, 1]);
    // A second state on the same core city puts its own roads back before its trips.
    const other = new CityState(city, metro, 2);
    other.apply(record(0, 1, [trip(4, 1)]));
    state.apply(record(0, 3, [trip(5, 3)]));
    expect(given).toEqual([[104, 6, 7, 0], [], [104, 6, 7, 0]]);
  });

  describe('a replan', () => {
    const replanning = () => {
      const made: { resident: number; depart: number; node: number; journey: FakeJourney }[] = [];
      const metro: Trips & { made: typeof made } = {
        made,
        trip: (_resident, _vehicle, depart) => new FakeJourney(depart + 10),
        replan(resident, _vehicle, depart, node) {
          if (resident === 999) return undefined;
          const journey = new FakeJourney(depart + 5);
          made.push({ resident, depart, node, journey });
          return journey;
        },
      };
      return metro;
    };
    const replan = (resident: number, node = 12): TickEvent => ({
      type: 'replan',
      resident,
      vehicle: 1,
      node,
      route: [[3, 100]],
    });

    it('ends the trip under way at once and starts the new one from the node', () => {
      const metro = replanning();
      const state = new CityState(city, metro, 2);
      const ended: Voyage[] = [];
      state.onVoyageEnd = (v) => ended.push(v);
      state.apply(record(0, 5, [trip(1, 5)]));
      const old = state.voyages.get(1)!;
      state.apply(record(0, 6, [replan(1)]));
      // Released and freed now, not drawn on until it would have arrived: its road may be gone.
      expect(ended).toEqual([old]);
      expect((old.journey as FakeJourney).freed).toBe(true);
      expect([...state.active()].map((v) => v.depart)).toEqual([6]);
      expect(metro.made.map((m) => [m.resident, m.depart, m.node])).toEqual([[1, 6, 12]]);
      expect(state.voyages.get(1)!.journey).toBe(metro.made[0]!.journey);
      expect(state.unplaced).toBe(0);
    });

    it('also ends an earlier trip still being drawn', () => {
      const state = new CityState(city, replanning(), 2);
      state.apply(record(0, 5, [trip(1, 5)]));
      state.apply(record(0, 6, [trip(1, 6)]));
      expect([...state.active()]).toHaveLength(2);
      state.apply(record(0, 7, [replan(1)]));
      expect([...state.active()].map((v) => v.depart)).toEqual([7]);
    });

    it('keeps the resident on the road until the new route arrives', () => {
      const metro: Trips = {
        trip: (_resident, _vehicle, depart) => new FakeJourney(depart + 10),
        replan: (_resident, _vehicle, depart) => new FakeJourney(depart + 20),
      };
      const state = new CityState(city, metro, 2);
      state.apply(record(0, 5, [trip(1, 5)]));
      state.apply(record(0, 6, [replan(1)]));
      expect(state.onRoad(20).cars).toBe(1);
      expect(state.onRoad(26).cars).toBe(0);
    });

    it('counts a replan core cannot place, and draws nothing for it', () => {
      const state = new CityState(city, replanning(), 2);
      state.apply(record(0, 5, [trip(999, 5)]));
      state.apply(record(0, 6, [replan(999)]));
      expect(state.voyages.has(999)).toBe(false);
      expect(state.unplaced).toBe(1);
      // A page whose core cannot replan counts every replan.
      const plain = new CityState(city, trips, 2);
      plain.apply(record(0, 6, [replan(1)]));
      expect(plain.unplaced).toBe(1);
    });
  });

  it('rewinds a road: a state folded from a keyframe before it has none, and one before its removal has it', () => {
    const records = [
      record(0, 240, [], { buildings: [], roads: [] }),
      record(0, 241, [roadwork(104, ROAD_ADDED, 6, 7)]),
      record(0, 242, [roadwork(104, ROAD_REMOVED, 6, 7)]),
    ];
    const foldTo = (tick: number) => {
      const s = new CityState(city, trips, 1);
      for (const r of records) if (r.tick <= tick) s.apply(r);
      return s;
    };
    expect([...foldTo(240).builtRoads()]).toEqual([]);
    expect([...foldTo(241).builtRoads()]).toEqual([104, 6, 7, 0]);
    expect([...foldTo(242).builtRoads()]).toEqual([104, 6, 7, 1]);
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
});

describe('syncRoads', () => {
  it('keeps what core had when it turns the roads down, and does not ask again for the same list', () => {
    let asked = 0;
    const metro: Trips = {
      trip: () => undefined,
      setRoads(roads) {
        asked++;
        if (roads[0] === 3) throw new Error('roads out of order');
      },
    };
    const good = Uint32Array.from([104, 6, 7, 0]);
    const bad = Uint32Array.from([3, 6, 7, 0]);
    expect(syncRoads(metro, good)).toBe(true);
    expect(syncRoads(metro, good)).toBe(true);
    expect(asked).toBe(1);
    expect(syncRoads(metro, bad)).toBe(false);
    expect(syncRoads(metro, bad)).toBe(false);
    expect(asked).toBe(2);
    // The good list is still what core holds, so going back to it costs nothing.
    expect(syncRoads(metro, good)).toBe(true);
    expect(asked).toBe(2);
  });

  it('does not lay the roads again for another list with the same roads', () => {
    let asked = 0;
    const metro: Trips = { trip: () => undefined, setRoads: () => void asked++ };
    expect(syncRoads(metro, Uint32Array.from([104, 6, 7, 0]))).toBe(true);
    expect(syncRoads(metro, Uint32Array.from([104, 6, 7, 0]))).toBe(true);
    expect(asked).toBe(1);
  });
});
