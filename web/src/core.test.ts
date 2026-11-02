import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Metro,
  decodeRecord,
  hash as cityHash,
  initSync,
  residentDayHash,
  residentName,
} from './core/felix_metro_core.js';

const built = (name: string) => readFileSync(new URL(`./core/${name}`, import.meta.url));

/** What the native build wrote: each record's bytes, what it decodes to, and a hash of that JSON. */
const fixture = JSON.parse(built('fixture.json').toString()) as {
  cities: { seed: string; districts: number; hash: string }[];
  days: { seed: string; districts: number; index: number; hash: string }[];
  trips: {
    seed: string;
    districts: number;
    resident: number;
    vehicle: number;
    depart: number;
    route: [number, number][];
    arrive: number;
    at: [number, number, number][];
  }[];
  roads: { seed: string; districts: number; roads: number[][]; tiles: number; hash: string }[];
  records: { name: string; record: string; json: unknown; hash: string }[];
};
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));

/** FNV-1a over the UTF-8 text, as the fixture example computes it. */
function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

beforeAll(() => {
  initSync({ module: built('felix_metro_core_bg.wasm') });
});

describe('cities and residents in WebAssembly', () => {
  it('generates every native city to the same hash', () => {
    expect(fixture.cities.length).toBeGreaterThan(0);
    for (const { seed, districts, hash } of fixture.cities) {
      expect(cityHash(seed, districts)).toBe(hash);
    }
  });

  it('walks and drives every native resident’s day to the same hash', () => {
    expect(fixture.days.length).toBeGreaterThan(0);
    for (const { seed, districts, index, hash } of fixture.days) {
      expect(residentDayHash(seed, districts, index)).toBe(hash);
    }
  });

  it('refuses a resident the city does not have', () => {
    expect(() => residentDayHash('harbor', 2, 4_000_000_000)).toThrow('no such resident');
  });
});

describe('trips in WebAssembly', () => {
  const place = (metro: Metro, t: (typeof fixture.trips)[number], route = t.route) =>
    metro.trip(t.resident, t.vehicle, t.depart, Uint32Array.from(route.flat()));

  it('places every native trip where the native build does, from its event alone', () => {
    expect(fixture.trips.length).toBeGreaterThan(0);
    const out = new Uint32Array(2);
    for (const t of fixture.trips) {
      const journey = place(new Metro(t.seed, t.districts), t)!;
      expect(journey, `resident ${t.resident} at ${t.depart}`).toBeDefined();
      expect(journey.arrive()).toBe(t.arrive);
      for (const [tick, x, z] of t.at) {
        journey.positionAt(tick, out);
        expect([tick, out[0], out[1]]).toEqual([tick, x, z]);
      }
      journey.free();
    }
  });

  it('gives no trip for legs the resident cannot make', () => {
    const t = fixture.trips[0]!;
    const metro = new Metro(t.seed, t.districts);
    expect(place(metro, t, [])).toBeUndefined();
    expect(place(metro, t, [[4_000_000_000, 100]])).toBeUndefined();
    expect(metro.trip(4_000_000_000, 1, t.depart, Uint32Array.from(t.route.flat()))).toBeUndefined();
  });
});

describe('built roads in WebAssembly', () => {
  it('lays the roads a log lists to the same city as the native build', () => {
    expect(fixture.roads.length).toBeGreaterThan(0);
    for (const { seed, districts, roads, tiles, hash } of fixture.roads) {
      const metro = new Metro(seed, districts);
      metro.setRoads(Uint32Array.from(roads.flat()));
      expect(metro.cityHash(), `${seed} ${JSON.stringify(roads)}`).toBe(hash);
      expect(JSON.parse(metro.roadsJson())).toHaveLength(tiles);
    }
  });

  it('puts the generated city back when the roads are cleared', () => {
    const metro = new Metro('harbor', 2);
    const generated = metro.cityHash();
    expect(generated).toBe(fixture.cities.find((c) => c.seed === 'harbor' && c.districts === 2)!.hash);
    metro.setRoads(Uint32Array.from([104, 6, 7, 0]));
    expect(metro.cityHash()).not.toBe(generated);
    metro.setRoads(new Uint32Array(0));
    expect(metro.cityHash()).toBe(generated);
  });

  it('goes back to roads it laid before as they were', () => {
    const metro = new Metro('harbor', 2);
    metro.setRoads(Uint32Array.from([104, 6, 7, 0]));
    const added = metro.cityHash();
    metro.setRoads(Uint32Array.from([104, 6, 7, 1]));
    const removed = metro.cityHash();
    expect(removed).not.toBe(added);
    metro.setRoads(Uint32Array.from([104, 6, 7, 0]));
    expect(metro.cityHash()).toBe(added);
    metro.setRoads(Uint32Array.from([104, 6, 7, 1]));
    expect(metro.cityHash()).toBe(removed);
  });

  it('numbers a road after a gap: core fills a segment it has not been told of', () => {
    const metro = new Metro('harbor', 2);
    expect(() => metro.setRoads(Uint32Array.from([105, 6, 7, 0]))).not.toThrow();
    expect(() => metro.setRoads(Uint32Array.from([3, 6, 7, 0]))).toThrow();
  });

  it('checks a road on the land and roads alone, with the sim’s result codes', () => {
    const metro = new Metro('harbor', 2);
    expect(metro.roadCheck(6, 7)).toBe(0);
    expect([...metro.roadTiles(6, 7)]).toEqual([17, 0, 18, 0]);
    expect(metro.roadCheck(6, 6)).toBe(22);
    expect(metro.roadCheck(4_000_000, 7)).toBe(2);
    metro.setRoads(Uint32Array.from([104, 6, 7, 0]));
    expect(metro.roadCheck(6, 7)).toBe(24);
    expect(metro.roadTiles(6, 7)).toHaveLength(0);
  });

  it('gives no replanned trip from a node the city does not have', () => {
    const metro = new Metro('harbor', 2);
    expect(metro.replan(0, 1, 100, 4_000_000, Uint32Array.from([0, 100]))).toBeUndefined();
  });
});

describe('records in WebAssembly', () => {
  it('decodes every native record to the same JSON text', () => {
    const names = fixture.records.map((r) => r.name);
    for (const name of ['tick', 'keyframe', 'command', 'registry']) expect(names).toContain(name);
    for (const { record, json, hash } of fixture.records) {
      const text = decodeRecord(bytes(record));
      expect(fnv1a(text)).toBe(hash);
      expect(JSON.parse(text)).toEqual(json);
    }
  });

  it('reads a keyframe record’s header, diffs and counts', () => {
    const { record } = fixture.records.find((r) => r.name === 'keyframe')!;
    const key = JSON.parse(decodeRecord(bytes(record)));
    expect(key).toMatchObject({ kind: 'tick', tick: 240, keyframeOffset: 8192 });
    expect(key.keyframe.buildings).toHaveLength(2);
    expect(key.keyframe.counts).toEqual({ home: 120, atWork: 80, onRoad: 14, asleep: 6 });
  });

  it('refuses truncated bytes and unknown kinds', () => {
    const { record } = fixture.records.find((r) => r.name === 'tick')!;
    const whole = bytes(record);
    for (let n = 0; n < whole.length; n++) {
      expect(() => decodeRecord(whole.subarray(0, n))).toThrow();
    }
    expect(() => decodeRecord(new Uint8Array([99, 0, 0]))).toThrow('unknown record kind 99');
  });
});

describe('a resident’s card', () => {
  const metro = () => new Metro('harbor', 2);

  it('names the resident and lists a day that closes on the first block', () => {
    const m = metro();
    expect(m.population()).toBeGreaterThan(100);
    const p = JSON.parse(m.profile(3)!);
    expect(p).toMatchObject({ id: 3, name: residentName('harbor', 3) });
    expect(['office', 'shift', 'shopkeeper', 'student', 'retiree', 'night']).toContain(p.archetype);
    expect(p.blocks.length).toBeGreaterThanOrEqual(2);
    for (const b of p.blocks) expect(['home', 'work', 'school', 'shop', 'leisure']).toContain(b.activity);
    const leaves: number[] = p.blocks.map((b: { leave: number }) => b.leave);
    expect(leaves).toEqual([...leaves].sort((a, b) => a - b));
    expect(leaves.at(-1)!).toBeLessThan(5760);
  });

  it('is the same from one Metro to the next, and different between residents', () => {
    expect(metro().profile(10)).toBe(metro().profile(10));
    expect(metro().profile(10)).not.toBe(metro().profile(11));
  });

  it('has nothing for a resident the city does not have', () => {
    const m = metro();
    expect(m.profile(m.population())).toBeUndefined();
    expect(m.profile(4_000_000_000)).toBeUndefined();
  });
});
