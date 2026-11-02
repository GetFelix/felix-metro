import { describe, expect, it } from 'vitest';
import { intoThePast, mixAt, startsRewind, WHOOSH_GAP_MS, whooshDue } from './ambient-mix';

describe('the mix by hour', () => {
  it('is traffic by day and crickets by night', () => {
    const noon = mixAt(12);
    expect(noon.traffic).toBeCloseTo(1);
    expect(noon.crickets).toBeCloseTo(0);
    const midnight = mixAt(0);
    expect(midnight.crickets).toBeCloseTo(1);
    expect(midnight.traffic).toBeGreaterThan(0);
    expect(midnight.traffic).toBeLessThan(0.3);
  });

  it('stays within 0 and 1 at every hour', () => {
    for (let h = 0; h <= 24; h += 0.05) {
      const m = mixAt(h);
      for (const level of [m.traffic, m.crickets]) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
    }
  });

  it('crosses over through dusk and dawn without a jump', () => {
    let before = mixAt(0);
    for (let h = 0.01; h <= 24; h += 0.01) {
      const m = mixAt(h);
      expect(Math.abs(m.traffic - before.traffic)).toBeLessThan(0.02);
      expect(Math.abs(m.crickets - before.crickets)).toBeLessThan(0.02);
      before = m;
    }
  });

  it('brings the crickets in over the evening and out over the morning', () => {
    const evening = [17, 18, 19, 20, 21].map((h) => mixAt(h).crickets);
    expect(evening).toEqual([...evening].sort((a, b) => a - b));
    expect(evening[0]).toBeCloseTo(0);
    expect(evening[4]).toBeCloseTo(1);
    const morning = [5, 6, 7, 8, 9].map((h) => mixAt(h).crickets);
    expect(morning).toEqual([...morning].sort((a, b) => b - a));
    expect(morning[0]).toBeCloseTo(1);
    expect(morning[4]).toBeCloseTo(0);
  });

  it('is the same at midnight whichever way the day is counted', () => {
    expect(mixAt(24)).toEqual(mixAt(0));
  });
});

describe('the rewind sweep', () => {
  it('is rate limited', () => {
    expect(whooshDue(null, 0)).toBe(true);
    expect(whooshDue(1000, 1000 + WHOOSH_GAP_MS - 1)).toBe(false);
    expect(whooshDue(1000, 1000 + WHOOSH_GAP_MS)).toBe(true);
  });

  it('starts when a rewind begins, not while one carries on or slows', () => {
    const play = { rate: 1, paused: false };
    expect(startsRewind(play, { rate: -1, paused: false })).toBe(true);
    expect(startsRewind({ rate: -1, paused: true }, { rate: -1, paused: false })).toBe(true);
    expect(startsRewind({ rate: -1, paused: false }, { rate: -2, paused: false })).toBe(false);
    expect(startsRewind({ rate: -2, paused: false }, { rate: -1, paused: false })).toBe(false);
    expect(startsRewind(play, { rate: 2, paused: false })).toBe(false);
    expect(startsRewind(play, { rate: -1, paused: true })).toBe(false);
  });

  it('starts when a scrub goes earlier and not when it goes later', () => {
    expect(intoThePast(500, 400)).toBe(true);
    expect(intoThePast(500, 500)).toBe(false);
    expect(intoThePast(500, 600)).toBe(false);
  });
});
