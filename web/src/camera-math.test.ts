import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  cityBounds,
  clampTarget,
  clampView,
  groundPoint,
  nearestAngle,
  offsetOf,
  panBy,
  panGrab,
  settled,
  stepSpring,
  viewFromOffset,
  zoomToward,
  type Limits,
  type Ndc,
  type Spring,
  type View,
} from './camera-math';

const lens = { fov: 28, aspect: 16 / 9 };
const limits: Limits = { minDistance: 8, maxDistance: 80, minPolar: 0.5, maxPolar: 1.15, bounds: cityBounds(34) };
const home: View = { x: 0, z: 0, distance: 20, azimuth: 0.8, polar: 1.0 };

/** Where the ground point (x, z) lands on screen for a camera standing at `v`, drawn by Three.js itself. */
function project(v: View, x: number, z: number): Ndc {
  const cam = new THREE.PerspectiveCamera(lens.fov, lens.aspect, 0.1, 500);
  const o = offsetOf(v);
  cam.position.set(v.x + o.x, o.y, v.z + o.z);
  cam.lookAt(v.x, 0, v.z);
  cam.updateMatrixWorld();
  const p = new THREE.Vector3(x, 0, z).project(cam);
  return { x: p.x, y: p.y };
}

describe('clampTarget', () => {
  const b = cityBounds(34);
  it('keeps a point that is inside', () => {
    expect(clampTarget(3, -4, b)).toEqual({ x: 3, z: -4 });
  });
  it('pulls a point outside back to the nearest edge or corner', () => {
    expect(clampTarget(40, 0, b)).toEqual({ x: 17, z: 0 });
    expect(clampTarget(-99, 99, b)).toEqual({ x: -17, z: 17 });
  });
  it('follows the city size, so a larger map allows more', () => {
    expect(clampTarget(30, 0, cityBounds(34)).x).toBe(17);
    expect(clampTarget(30, 0, cityBounds(66)).x).toBe(30);
  });
});

describe('clampView', () => {
  it('holds every number inside its limit', () => {
    const v = clampView({ x: 99, z: -99, distance: 1, azimuth: 7, polar: 3 }, limits);
    expect(v).toEqual({ x: 17, z: -17, distance: 8, azimuth: 7, polar: 1.15 });
    expect(clampView({ ...home, distance: 1e6, polar: 0 }, limits)).toMatchObject({ distance: 80, polar: 0.5 });
  });
  it('replaces numbers that are not numbers', () => {
    const v = clampView({ x: NaN, z: 0, distance: Infinity, azimuth: NaN, polar: NaN }, limits);
    expect(Object.values(v).every(Number.isFinite)).toBe(true);
  });
});

describe('viewFromOffset', () => {
  it('turns a camera position back into the view that made it', () => {
    const v = viewFromOffset(2, -3, offsetOf(home));
    expect([v.x, v.z]).toEqual([2, -3]);
    expect(v.distance).toBeCloseTo(home.distance);
    expect(v.azimuth).toBeCloseTo(home.azimuth);
    expect(v.polar).toBeCloseTo(home.polar);
  });
});

describe('groundPoint', () => {
  it('is the look-at point at the centre of the screen', () => {
    const p = groundPoint({ ...home, x: 3, z: -2 }, { x: 0, y: 0 }, lens)!;
    expect(p.x).toBeCloseTo(3);
    expect(p.z).toBeCloseTo(-2);
  });
  it('agrees with where Three.js draws a point', () => {
    for (const at of [
      { x: 0.6, y: -0.4 },
      { x: -0.9, y: 0.8 },
    ]) {
      const p = groundPoint(home, at, lens)!;
      const back = project(home, p.x, p.z);
      expect(back.x).toBeCloseTo(at.x, 5);
      expect(back.y).toBeCloseTo(at.y, 5);
    }
  });
});

describe('zoomToward', () => {
  it('keeps the ground under the cursor where it was', () => {
    for (const at of [
      { x: 0.7, y: -0.5 },
      { x: -0.8, y: 0.6 },
      { x: 0.95, y: 0.95 },
    ]) {
      const ground = groundPoint(home, at, lens)!;
      for (const factor of [0.5, 0.8, 1.3]) {
        const next = zoomToward(home, at, factor, lens, limits);
        expect(next.distance).toBeCloseTo(home.distance * factor);
        const seen = project(next, ground.x, ground.z);
        expect(seen.x).toBeCloseTo(at.x, 5);
        expect(seen.y).toBeCloseTo(at.y, 5);
      }
    }
  });
  it('is a plain dolly with the cursor at the centre', () => {
    const next = zoomToward({ ...home, x: 4, z: 5 }, { x: 0, y: 0 }, 0.5, lens, limits);
    expect(next.x).toBeCloseTo(4);
    expect(next.z).toBeCloseTo(5);
    expect(next.distance).toBeCloseTo(10);
  });
  it('leaves the angles alone', () => {
    const next = zoomToward(home, { x: 0.5, y: 0.5 }, 0.6, lens, limits);
    expect([next.azimuth, next.polar]).toEqual([home.azimuth, home.polar]);
  });
  it('stops at the nearest and the farthest distance and then stops sliding', () => {
    const near = zoomToward({ ...home, distance: 8.5 }, { x: 0.7, y: -0.3 }, 0.1, lens, limits);
    expect(near.distance).toBe(8);
    const again = zoomToward(near, { x: 0.7, y: -0.3 }, 0.1, lens, limits);
    expect(again).toEqual(near);
    expect(zoomToward({ ...home, distance: 70 }, { x: 0, y: 0 }, 9, lens, limits).distance).toBe(80);
  });
  it('cannot slide the look-at point out of the city', () => {
    let v: View = { ...home, x: 16, z: 16, distance: 60 };
    for (let i = 0; i < 40; i++) v = zoomToward(v, { x: 1, y: 1 }, 0.9, lens, limits);
    expect(Math.abs(v.x)).toBeLessThanOrEqual(17);
    expect(Math.abs(v.z)).toBeLessThanOrEqual(17);
    for (let i = 0; i < 40; i++) v = zoomToward(v, { x: -1, y: -1 }, 1.1, lens, limits);
    expect(Math.abs(v.x)).toBeLessThanOrEqual(17);
    expect(Math.abs(v.z)).toBeLessThanOrEqual(17);
  });
});

describe('panGrab', () => {
  it('puts the ground that was under the first spot under the second', () => {
    const [a, b] = [
      { x: 0.3, y: 0.2 },
      { x: -0.2, y: -0.5 },
    ];
    const ground = groundPoint(home, a, lens)!;
    const next = panGrab(home, a, b, lens, limits);
    const seen = project(next, ground.x, ground.z);
    expect(seen.x).toBeCloseTo(b.x, 5);
    expect(seen.y).toBeCloseTo(b.y, 5);
  });
  it('moves farther per pixel the farther the camera stands', () => {
    const [a, b] = [
      { x: 0, y: 0 },
      { x: 0.2, y: 0 },
    ];
    const near = panGrab({ ...home, distance: 10 }, a, b, lens, limits);
    const far = panGrab({ ...home, distance: 40 }, a, b, lens, limits);
    expect(Math.hypot(far.x, far.z) / Math.hypot(near.x, near.z)).toBeCloseTo(4, 3);
  });
  it('stays inside the city', () => {
    const next = panGrab({ ...home, x: 16, distance: 60 }, { x: 0, y: 0 }, { x: -1, y: 0 }, lens, limits);
    expect(next.x).toBeLessThanOrEqual(17);
  });
});

describe('panBy', () => {
  it('moves away from the camera for forward and to its right for right', () => {
    const north = panBy({ ...home, azimuth: 0 }, 5, 0, limits);
    expect(north.x).toBeCloseTo(0);
    expect(north.z).toBeCloseTo(-5);
    const east = panBy({ ...home, azimuth: 0 }, 0, 5, limits);
    expect(east.x).toBeCloseTo(5);
    expect(east.z).toBeCloseTo(0);
    const turned = panBy({ ...home, azimuth: Math.PI / 2 }, 5, 0, limits);
    expect(turned.x).toBeCloseTo(-5);
    expect(turned.z).toBeCloseTo(0);
  });
  it('stops at the edge', () => {
    expect(panBy({ ...home, azimuth: 0 }, -500, 0, limits).z).toBe(17);
  });
});

describe('nearestAngle', () => {
  it('turns the short way round', () => {
    expect(nearestAngle(3, -3)).toBeCloseTo(-3 + 2 * Math.PI);
    expect(nearestAngle(0, 0.5)).toBe(0.5);
    expect(nearestAngle(7, 0)).toBeCloseTo(2 * Math.PI);
  });
});

describe('stepSpring', () => {
  it('arrives without passing the goal', () => {
    const s: Spring = { value: 0, velocity: 0 };
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      stepSpring(s, 10, 9, 1 / 60);
      peak = Math.max(peak, s.value);
    }
    expect(peak).toBeLessThanOrEqual(10);
    expect(s.value).toBeCloseTo(10, 3);
  });
  it('does not pass the goal even when it starts moving the wrong way', () => {
    const s: Spring = { value: 0, velocity: -20 };
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      stepSpring(s, 1, 9, 1 / 60);
      peak = Math.max(peak, s.value);
    }
    expect(peak).toBeLessThan(1.5);
    expect(s.value).toBeCloseTo(1, 3);
  });
  it('is most of the way in about 5 over omega seconds', () => {
    const s: Spring = { value: 0, velocity: 0 };
    stepSpring(s, 1, 9, 5 / 9);
    expect(s.value).toBeGreaterThan(0.95);
  });
  it('says when it is there', () => {
    expect(settled({ value: 1.00001, velocity: 0 }, 1, 1e-4)).toBe(true);
    expect(settled({ value: 1, velocity: 0.5 }, 1, 1e-4)).toBe(false);
  });
});
