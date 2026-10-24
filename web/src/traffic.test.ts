import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Journey, Voyage } from './city';
import { LANE, PAVEMENT, Traffic, poseBetween, type Fleet } from './traffic';

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
    free() {},
  };
}

function fleet() {
  const made = { cars: 0, people: 0 };
  const f: Fleet = {
    car: () => (made.cars++, { o: new THREE.Object3D() }),
    person: () => (made.people++, { o: new THREE.Object3D() }),
  };
  return { f, made };
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

  it('walks on the pavement and a walker is not a car', () => {
    const { f, made } = fleet();
    const traffic = new Traffic(f, 0);
    traffic.update(2, 0, [voyage(5, 0, 0, 10)]);
    expect(made).toEqual({ cars: 0, people: 1 });
    expect(traffic.where()[0]).toMatchObject({ car: false, z: expect.closeTo(-PAVEMENT) });
  });

  it('draws nothing before a trip leaves or after it arrives, and reuses the model', () => {
    const { f, made } = fleet();
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
    expect(made.cars).toBe(1);
  });

  it('makes only so many new models in one update and the rest in the ones after it', () => {
    const { f, made } = fleet();
    const traffic = new Traffic(f, 0, 3);
    const trips = Array.from({ length: 8 }, (_, i) => voyage(i, 2, 0, 100));
    traffic.update(5, 0, trips);
    expect(traffic.drawn).toBe(3);
    expect(traffic.waiting).toBe(5);
    traffic.update(5, 0, trips);
    traffic.update(5, 0, trips);
    expect(traffic.drawn).toBe(8);
    expect(traffic.waiting).toBe(0);
    expect(made.cars).toBe(8);
    // Models the pool already holds cost nothing, so they are not held to the share.
    traffic.update(200, 0, trips);
    traffic.update(5, 0, trips);
    expect(traffic.drawn).toBe(8);
    expect(made.cars).toBe(8);
  });

  it('draws no more than its cap, counts the rest, and draws them as room is made', () => {
    const { f, made } = fleet();
    const traffic = new Traffic(f, 0);
    traffic.cap = 3;
    const trips = Array.from({ length: 5 }, (_, i) => voyage(i, 2, 0, 10 + i));
    traffic.update(5, 0, trips);
    expect(traffic.drawn).toBe(3);
    expect(traffic.capped).toBe(2);
    // The two over the cap are not model-pool waits, which a seek holds the frame for.
    expect(traffic.waiting).toBe(0);
    expect(made.cars).toBe(3);
    // The first to arrive hands over its model, and the next in line takes it.
    traffic.update(10.5, 0, trips);
    expect(traffic.drawn).toBe(3);
    expect(traffic.capped).toBe(1);
    expect(made.cars).toBe(3);
  });

  it('keeps drawing a trip while the resident’s next one waits to leave', () => {
    const { f, made } = fleet();
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
    expect(made.cars).toBe(1);
  });

  it('centres the map’s tiles on the middle', () => {
    const { f } = fleet();
    const traffic = new Traffic(f, 5);
    traffic.update(5, 0, [voyage(1, 1, 0, 10)]);
    expect(traffic.where()[0]!.x).toBeCloseTo(0);
  });
});
