import { describe, expect, it } from 'vitest';
import type { Journey, Voyage } from './city';
import { DOOR_SETBACK, LANE, PAVEMENT, Traffic, doorEase, poseBetween, type Fleet } from './traffic';

describe('poseBetween', () => {
  it('moves along the way and faces it', () => {
    const east = poseBetween([0, 0], [2, 0], 0.5, 0, 0);
    expect(east.x).toBeCloseTo(1);
    expect(east.heading).toBeCloseTo(Math.PI / 2);
    expect(poseBetween([0, 0], [0, 2], 0.5, 0, 0).heading).toBeCloseTo(0);
    expect(poseBetween([0, 0], [0, -2], 0.5, 0, 0).heading).toBeCloseTo(Math.PI);
  });

  it('keeps right of the way, as the frame’s traffic does', () => {
    const east = poseBetween([0, 0], [1, 0], 0, LANE, 0);
    expect([east.x, east.z]).toEqual([expect.closeTo(0), expect.closeTo(-LANE)]);
    const south = poseBetween([0, 0], [0, 1], 0, LANE, 0);
    expect([south.x, south.z]).toEqual([expect.closeTo(LANE), expect.closeTo(0)]);
    const west = poseBetween([0, 0], [-1, 0], 0, LANE, 0);
    expect(west.z).toBeCloseTo(LANE);
  });

  it('keeps its heading when it stands still', () => {
    expect(poseBetween([1, 1], [1, 1], 0.5, 0, 1.25).heading).toBe(1.25);
  });
});

/** A journey straight east along z = 0, one tile a tick from `from`, and over at `to`. */
function journey(from: number, to: number): Journey {
  return {
    arrive: () => to,
    positionAt(tick, out) {
      out[0] = Math.min(to, Math.max(from, tick)) * 1000;
      out[1] = 0;
    },
    lots(out) {
      out[0] = 0;
      out[1] = 1;
    },
    free() {},
  };
}

interface Placed {
  car: boolean;
  id: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  size: number;
}

/** A fleet that remembers what the last update placed, and the dt it was given. */
function fleet() {
  const placed: Placed[] = [];
  const seen = { rounds: 0, dt: NaN, open: false };
  const f: Fleet = {
    view() {},
    begin(dt) {
      placed.length = 0;
      seen.rounds++;
      seen.dt = dt;
      seen.open = true;
    },
    car: (id, x, y, z, heading, size) => placed.push({ car: true, id, x, y, z, heading, size }),
    person: (id, x, y, z, heading, size) => placed.push({ car: false, id, x, y, z, heading, size }),
    end() {
      seen.open = false;
    },
  };
  return { f, placed, seen };
}

const voyage = (resident: number, vehicle: number, from: number, to: number): Voyage => ({
  resident,
  vehicle,
  depart: from,
  journey: journey(from, to),
});

describe('Traffic', () => {
  it('draws a car between its two ticks, in its lane', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 0);
    const v = voyage(1, 2, 0, 10);
    traffic.update(4.5, 0.016, [v]);
    const [car] = traffic.where();
    expect(car).toMatchObject({ resident: 1, car: true });
    expect(car!.x).toBeCloseTo(4.5 / 1, 0);
    expect(car!.z).toBeCloseTo(-LANE);
  });

  it('hands the fleet each voyage once, as a car of its kind or as the resident walking', () => {
    const { f, placed, seen } = fleet();
    const traffic = new Traffic(f, 0);
    traffic.update(2, 0.25, [voyage(5, 0, 0, 10), voyage(6, 3, 0, 10)]);
    expect(placed).toEqual([
      expect.objectContaining({ car: false, id: 5, y: 0, z: expect.closeTo(-PAVEMENT), size: 1 }),
      expect.objectContaining({ car: true, id: 3, y: 0.036, z: expect.closeTo(-LANE), size: 1 }),
    ]);
    expect(traffic.where()[0]).toMatchObject({ car: false, z: expect.closeTo(-PAVEMENT) });
    expect(seen).toEqual({ rounds: 1, dt: 0.25, open: false });
  });

  it('places the page’s own vehicles after the voyages, in the same round, and again when a release redraws', () => {
    const { f, placed, seen } = fleet();
    const traffic = new Traffic(f, 0);
    const during: boolean[] = [];
    traffic.extras = (fleet) => {
      during.push(seen.open);
      fleet.car(7, 1, 0, 1, 0, 1);
    };
    const a = voyage(1, 2, 0, 10);
    traffic.update(2, 0, [a]);
    expect(placed.map((p) => p.id)).toEqual([2, 7]);
    expect(during).toEqual([true]);
    traffic.release(a);
    traffic.sync();
    expect(placed.map((p) => p.id)).toEqual([7]);
    expect(seen.rounds).toBe(2);
  });

  it('starts every round afresh, so a voyage that ended is not drawn again', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    const a = voyage(1, 2, 0, 10);
    const b = voyage(2, 2, 0, 20);
    traffic.update(5, 0, [a, b]);
    expect(placed).toHaveLength(2);
    traffic.update(15, 0, [a, b]);
    expect(placed.map((p) => p.id)).toEqual([2]);
  });

  it('says where a trip stands at a tick without it holding a place, and what the cap leaves out is still found', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    traffic.cap = 1;
    const a = voyage(1, 2, 0, 10);
    const b = voyage(2, 0, 0, 10);
    traffic.update(4, 0, [a, b]);
    expect(placed.map((p) => p.id)).toEqual([2]);
    expect(traffic.capped).toBe(1);
    const found = traffic.positionOf(b, 4.5)!;
    expect(found.x).toBeCloseTo(4.5);
    expect(found.z).toBeCloseTo(-PAVEMENT);
    expect(traffic.drawn).toBe(1);
    expect(traffic.positionOf(b, 10)).toBeNull();
    expect(traffic.positionOf(b, -1)).toBeNull();
  });

  it('agrees with where a drawn trip is placed', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 0);
    const a = voyage(1, 2, 0, 10);
    traffic.update(6.25, 0, [a]);
    const [drawn] = traffic.where();
    expect(traffic.positionOf(a, 6.25)).toMatchObject({ x: drawn!.x, z: drawn!.z, heading: drawn!.heading });
  });

  it('fills the object it is given and hands it back, so asking every frame allocates nothing', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 0);
    const a = voyage(1, 2, 0, 10);
    const into = { x: -1, y: -1, z: -1, heading: -1, size: -1, road: 0 };
    expect(traffic.positionOf(a, 4.5, into)).toBe(into);
    expect(into).toMatchObject({ x: expect.closeTo(4.5), z: expect.closeTo(-LANE), size: 1 });
    expect(traffic.positionOf(a, 12, into)).toBeNull();
  });

  it('always draws the pinned resident, whatever the cap', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    traffic.cap = 1;
    traffic.pinned = 7;
    traffic.update(4, 0, [voyage(1, 2, 0, 10), voyage(7, 3, 0, 10)]);
    expect(placed.map((p) => p.id)).toEqual([2, 3]);
    expect(traffic.capped).toBe(0);
  });

  it('draws nothing before a trip leaves or after it arrives', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 0);
    const a = voyage(1, 3, 10, 20);
    traffic.update(5, 0, [a]);
    expect(traffic.drawn).toBe(0);
    traffic.update(12, 0, [a]);
    expect(traffic.drawn).toBe(1);
    traffic.update(20, 0, [a]);
    expect(traffic.drawn).toBe(0);
    traffic.update(33, 0, [voyage(2, 3, 30, 40)]);
    expect(traffic.drawn).toBe(1);
  });

  // A road along z = 0. Lots 0 and 1 are a tile to its north and south at the west end, 2 and 3 the same at x = 10, and
  // 4 is a north lot at x = 30. A trip's ends are the lots beside where it starts and stops.
  const lots = [
    { x: 0, z: -1 },
    { x: 0, z: 1 },
    { x: 10, z: -1 },
    { x: 10, z: 1 },
    { x: 30, z: -1 },
  ];
  const trip = (from: number, to: number, ends: [number, number], vehicle = 2): Voyage => ({
    resident: 1,
    vehicle,
    depart: from,
    journey: { ...journey(from, to), lots: (out) => ((out[0] = ends[0]), (out[1] = ends[1])) },
  });
  const drawn = (v: Voyage, tick: number, vehicle = v.vehicle) => {
    const { f, placed } = fleet();
    new Traffic(f, 0, lots).update(tick, 0, [v]);
    return { x: placed[0]!.x, z: placed[0]!.z, scale: placed[0]!.size, vehicle };
  };

  it('walks up to the door of the lot it leaves and the lot it enters, whichever side of the road that is', () => {
    for (const vehicle of [2, 0]) {
      for (const [ends, side] of [
        [[0, 3], -1],
        [[1, 2], 1],
      ] as const) {
        // Leaves lot ends[0], arrives at lot ends[1]: the other side of the road.
        const start = drawn(trip(0, 10, [...ends], vehicle), 0.01);
        // The door is a little inside the lot's near edge; full size all the way there.
        expect(start.z).toBeCloseTo(side * (1 - DOOR_SETBACK), 1);
        expect(start.scale).toBe(1);
        const end = drawn(trip(0, 10, [...ends], vehicle), 9.99);
        expect(end.z).toBeCloseTo(-side * (1 - DOOR_SETBACK), 1);
        expect(end.scale).toBe(1);
      }
    }
  });

  it('turns in on the same side at both ends of a round trip on one lot', () => {
    const out = drawn(trip(0, 10, [0, 0]), 0.01);
    const back = drawn(trip(20, 30, [0, 4]), 29.99);
    expect(out.z).toBeCloseTo(-(1 - DOOR_SETBACK), 1);
    expect(back.z).toBeCloseTo(-(1 - DOOR_SETBACK), 1);
  });

  it('drives in its lane mid-trip and walks on the pavement', () => {
    expect(drawn(trip(0, 10, [0, 1]), 5).z).toBeCloseTo(-LANE);
    expect(drawn(trip(0, 10, [0, 1], 0), 5, 0).z).toBeCloseTo(-PAVEMENT);
    expect(drawn(trip(0, 10, [0, 1]), 5).scale).toBe(1);
  });

  it('gives a one tick trip half a tick at each end, without a jump at the middle', () => {
    const v = trip(0, 1, [0, 1]);
    const early = drawn(v, 0.499);
    const late = drawn(v, 0.501);
    expect(early.scale).toBeGreaterThan(0.9);
    expect(late.scale).toBeGreaterThan(0.9);
    expect(Math.abs(early.z - late.z)).toBeLessThan(0.1);
    for (const tick of [0, 0.1, 0.25, 0.75, 0.9, 0.999]) {
      const s = drawn(v, tick).scale;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('draws a zero length trip never', () => {
    const v = trip(5, 5, [0, 1]);
    for (const tick of [4.9, 5, 5.1]) {
      const { f, placed } = fleet();
      const traffic = new Traffic(f, 0, lots);
      traffic.update(tick, 0, [v]);
      expect(traffic.drawn).toBe(0);
      expect(placed).toEqual([]);
    }
  });

  it('places every voyage in the update it first appears in, however many there are', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    const trips = Array.from({ length: 800 }, (_, i) => voyage(i, i % 7, 0, 100));
    traffic.update(5, 0, trips);
    expect(traffic.drawn).toBe(800);
    expect(placed).toHaveLength(800);
  });

  it('stops drawing a released voyage on the next sync, though no update follows', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    const a = voyage(1, 2, 0, 10);
    const b = voyage(2, 2, 0, 10);
    traffic.update(5, 0, [a, b]);
    expect(placed).toHaveLength(2);
    traffic.sync();
    expect(placed).toHaveLength(2);
    traffic.release(a);
    traffic.sync();
    expect(placed.map((p) => p.id)).toEqual([2]);
  });

  it('does not draw again for a release inside an update, which draws at its end', () => {
    const { f, seen } = fleet();
    const traffic = new Traffic(f, 0);
    const a = voyage(1, 2, 0, 10);
    traffic.update(5, 0, [a]);
    traffic.update(12, 0, [a]);
    expect(seen.rounds).toBe(2);
    traffic.sync();
    expect(seen.rounds).toBe(2);
  });

  it('draws no more than its cap, counts the rest, and draws them as room is made', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    traffic.cap = 3;
    const trips = Array.from({ length: 5 }, (_, i) => voyage(i, 2, 0, 10 + i));
    traffic.update(5, 0, trips);
    expect(traffic.drawn).toBe(3);
    expect(traffic.capped).toBe(2);
    expect(placed).toHaveLength(3);
    // The first to arrive makes room, and the next in line is drawn.
    traffic.update(10.5, 0, trips);
    expect(traffic.drawn).toBe(3);
    expect(traffic.capped).toBe(1);
    expect(placed).toHaveLength(3);
  });

  it('keeps a standing trip facing the way it last moved', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0);
    // Moves east for the first tick, then stands still.
    const v: Voyage = {
      resident: 1,
      vehicle: 2,
      depart: 0,
      journey: { ...journey(0, 10), positionAt: (tick, out) => ((out[0] = Math.min(tick, 1) * 1000), (out[1] = 0)) },
    };
    traffic.update(0.5, 0, [v]);
    expect(placed[0]!.heading).toBeCloseTo(Math.PI / 2);
    traffic.update(5.5, 0, [v]);
    expect(placed[0]!.heading).toBeCloseTo(Math.PI / 2);
  });

  it('keeps drawing a trip while the resident’s next one waits to leave', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 0);
    const first = voyage(1, 2, 0, 10);
    const next = voyage(1, 2, 12, 20);
    traffic.update(8, 0, [first, next]);
    expect(traffic.drawn).toBe(1);
    expect(traffic.where()[0]!.x).toBeCloseTo(8);
    traffic.update(11, 0, [first, next]);
    expect(traffic.drawn).toBe(0);
    traffic.update(13, 0, [first, next]);
    expect(traffic.where()[0]!.x).toBeCloseTo(13);
  });

  it('centres the map’s tiles on the middle', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 5);
    traffic.update(5, 0, [voyage(1, 1, 0, 10)]);
    expect(traffic.where()[0]!.x).toBeCloseTo(0);
  });
});

describe('arriving and leaving', () => {
  const lots = [
    { x: 0, z: -1 },
    { x: 10, z: 1 },
    { x: 20, z: 1 },
  ];
  const withLots = (v: Voyage, ends: [number, number]): Voyage => ({
    ...v,
    journey: { ...v.journey, lots: (out) => ((out[0] = ends[0]), (out[1] = ends[1])) },
  });

  it('eases to the door and back without a jump, and stays at full size', () => {
    for (const vehicle of [2, 0]) {
      const v = withLots(voyage(1, vehicle, 0, 10), [0, 1]);
      let last: { x: number; z: number } | null = null;
      for (let tick = 8.5; tick < 10; tick += 0.05) {
        const { f, placed } = fleet();
        new Traffic(f, 0, lots).update(tick, 0, [v]);
        const p = placed[0]!;
        expect(p.size).toBe(1);
        // Never inside the lot, and never more than a car's length from where it was a frame (50 ms at 4 ticks/s) before.
        expect(Math.abs(p.z - lots[1]!.z)).toBeGreaterThanOrEqual(DOOR_SETBACK - 1e-6);
        if (last) expect(Math.hypot(p.x - last.x, p.z - last.z)).toBeLessThan(0.2);
        last = p;
      }
    }
  });

  it('eases smoothly from 0 on the road to 1 at the door', () => {
    expect(doorEase(0, 0, 10)).toBe(1);
    expect(doorEase(5, 0, 10)).toBe(0);
    expect(doorEase(10, 0, 10)).toBe(1);
    const mid = doorEase(0.5, 0, 10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('stops drawing a trip the moment it arrives, and hands its place to the next one', () => {
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0, lots);
    const first = withLots(voyage(7, 2, 0, 10), [0, 1]);
    const second = withLots(voyage(7, 2, 20, 30), [2, 0]);
    traffic.update(9.99, 0, [first]);
    expect(placed).toHaveLength(1);
    traffic.update(10, 0, [first]);
    expect(placed).toHaveLength(0);
    expect(traffic.drawn).toBe(0);
    // The same resident's next trip starts at its own door, not where the last one ended.
    traffic.update(20.01, 0, [first, second]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.z).toBeCloseTo(1 - DOOR_SETBACK, 1);
    expect(placed[0]!.x).toBeCloseTo(20, 1);
  });

  it('draws the others where they would be alone when one arrives', () => {
    // A car is placed under its vehicle kind and a walker under its resident, so the three are told apart by those.
    const a = withLots(voyage(1, 1, 0, 10), [0, 1]);
    const b = withLots(voyage(2, 2, 0, 20), [0, 1]);
    const c = withLots(voyage(3, 0, 0, 20), [1, 0]);
    const idOf = (v: Voyage) => (v.vehicle === 0 ? v.resident : v.vehicle);
    const alone = (v: Voyage, tick: number) => {
      const { f, placed } = fleet();
      new Traffic(f, 0, lots).update(tick, 0, [v]);
      return placed[0]!;
    };
    const { f, placed } = fleet();
    const traffic = new Traffic(f, 0, lots);
    for (const tick of [9.5, 9.99, 10, 10.5, 11]) {
      traffic.update(tick, 0, [a, b, c]);
      for (const v of [b, c]) {
        expect(placed.find((p) => p.id === idOf(v))).toEqual(alone(v, tick));
      }
      expect(placed.some((p) => p.id === idOf(a))).toBe(tick < 10);
    }
  });
});
