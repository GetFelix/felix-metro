import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { daylight, lampId, lampSwitch, unitHash, WINDOW_BUCKETS, windowBucket, windowSwitch } from './daylight';

const STEP = 0.01;
const SAMPLES = Math.round(24 / STEP);

function flat(h: number) {
  const d = daylight(h);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v instanceof THREE.Color) {
      out[`${k}.r`] = v.r;
      out[`${k}.g`] = v.g;
      out[`${k}.b`] = v.b;
    } else if (Array.isArray(v)) v.forEach((x, i) => (out[`${k}.${i}`] = x));
    else out[k] = v as number;
  }
  return out;
}

// Largest change between neighbouring samples over a whole day, including the step from 23.99 to 0.
function maxStep(f: (h: number) => number) {
  let worst = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = f(i * STEP);
    const b = f(((i + 1) % SAMPLES) * STEP);
    worst = Math.max(worst, Math.abs(b - a));
  }
  return worst;
}

describe('daylight', () => {
  it('has no jump in any output over the day, including the wrap at midnight', () => {
    const keys = Object.keys(flat(0));
    for (const k of keys) {
      const bound = k.startsWith('sunPosition') ? 0.3 : 0.1;
      expect(
        maxStep((h) => flat(h)[k]!),
        k,
      ).toBeLessThan(bound);
    }
  });

  it('is the same at 24 as at 0 and for any whole number of days', () => {
    expect(flat(24)).toEqual(flat(0));
    expect(flat(36.5)).toEqual(flat(12.5));
    expect(flat(-1)).toEqual(flat(23));
  });

  it('lights the cars once it is dusk and not at noon', () => {
    expect(daylight(12).headlight).toBe(0);
    expect(daylight(21).headlight).toBe(1);
    expect(daylight(19).headlight).toBeGreaterThan(0.5);
  });
});

describe('window switch', () => {
  it('has no jump for any bucket, and each bucket flips at its own fixed hour', () => {
    const evening: number[] = [];
    for (let b = 0; b < WINDOW_BUCKETS; b++) {
      expect(
        maxStep((h) => windowSwitch(h, b)),
        `bucket ${b}`,
      ).toBeLessThan(0.1);
      expect(windowSwitch(12, b)).toBe(0);
      expect(windowSwitch(17.4, b)).toBe(0);
      expect(windowSwitch(19.7, b)).toBe(1);
      expect(windowSwitch(23, b)).toBe(1);
      expect(windowSwitch(0, b)).toBe(1);
      expect(windowSwitch(5.9, b)).toBe(1);
      expect(windowSwitch(7.7, b)).toBe(0);
      let h = 17;
      while (windowSwitch(h, b) < 0.5) h += 0.01;
      evening.push(h);
    }
    expect(Math.min(...evening)).toBeGreaterThan(17.5);
    expect(Math.max(...evening)).toBeLessThan(19.7);
    expect(new Set(evening.map((h) => h.toFixed(1))).size).toBeGreaterThan(4);
  });

  it('puts buildings in buckets by tile and spreads them', () => {
    const counts = new Array<number>(WINDOW_BUCKETS).fill(0);
    for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) counts[windowBucket(x, z)]!++;
    expect(counts.every((c) => c > 0)).toBe(true);
    expect(windowBucket(3, 4)).toBe(windowBucket(3, 4));
  });
});

describe('lamp switch', () => {
  it('has no jump for any lamp and spreads switch-on over twenty minutes', () => {
    const starts: number[] = [];
    for (let i = 0; i < 50; i++) {
      const id = lampId(i * 0.7 - 12, (i * 7) % 13);
      expect(maxStep((h) => lampSwitch(h, id))).toBeLessThan(0.1);
      expect(lampSwitch(12, id)).toBe(0);
      expect(lampSwitch(19.2, id)).toBe(1);
      expect(lampSwitch(3, id)).toBe(1);
      let h = 18;
      while (lampSwitch(h, id) < 0.5) h += 0.01;
      starts.push(h);
    }
    const spread = Math.max(...starts) - Math.min(...starts);
    expect(spread).toBeGreaterThan(0.2);
    expect(spread).toBeLessThan(0.4);
  });

  it('derives ids from position alone', () => {
    expect(lampId(1.44, -2)).toBe(lampId(1.44, -2));
    expect(unitHash(1, 2)).toBeGreaterThanOrEqual(0);
    expect(unitHash(1, 2)).toBeLessThan(1);
  });
});
