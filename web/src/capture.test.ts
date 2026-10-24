import { describe, expect, it } from 'vitest';
import { sample, type Key } from './capture';

const keys: Key[] = [
  { t: 0, v: [0, 10] },
  { t: 1000, v: [4, 10] },
  { t: 3000, v: [4, 30] },
];

describe('sample', () => {
  it('passes through every key', () => {
    for (const k of keys) expect(sample(keys, k.t)).toEqual(k.v);
  });

  it('holds the first and the last value outside the path', () => {
    expect(sample(keys, -50)).toEqual([0, 10]);
    expect(sample(keys, 9000)).toEqual([4, 30]);
  });

  it('eases to a stop at both ends', () => {
    const [near] = sample(keys, 10);
    expect(near!).toBeLessThan(0.1);
  });

  it('keeps moving past a middle key that is on the way somewhere', () => {
    const rising: Key[] = [
      { t: 0, v: [0] },
      { t: 1000, v: [5] },
      { t: 2000, v: [10] },
    ];
    expect(sample(rising, 1010)[0]! - sample(rising, 990)[0]!).toBeGreaterThan(0.05);
  });

  it('never goes past its keys, so a camera does not dip under the ground', () => {
    const swing: Key[] = [
      { t: 0, v: [1] },
      { t: 1000, v: [0.5] },
      { t: 1500, v: [9] },
      { t: 3000, v: [9] },
    ];
    for (let t = 0; t <= 3000; t += 10) {
      const v = sample(swing, t)[0]!;
      expect(v).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(v).toBeLessThanOrEqual(9 + 1e-9);
    }
  });

  it('is monotonic between keys that rise', () => {
    let last = -Infinity;
    for (let t = 1000; t <= 3000; t += 50) {
      const y = sample(keys, t)[1]!;
      expect(y).toBeGreaterThanOrEqual(last - 1e-9);
      last = y;
    }
  });

  it('gives the same value for the same time', () => {
    expect(sample(keys, 1234)).toEqual(sample(keys, 1234));
  });
});
