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

  it('keeps moving past a middle key instead of stopping on it', () => {
    const before = sample(keys, 990)[1]!;
    const after = sample(keys, 1010)[1]!;
    expect(after - before).toBeGreaterThan(0.1);
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
