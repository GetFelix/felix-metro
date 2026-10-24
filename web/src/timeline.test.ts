import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';
import { STEP_TICKS, agoText, clampTick, dayBands, hourMarks, momentText, stepTick, tickAtFraction } from './timeline';

const range = { oldest: 480, newest: 480 + 3 * TICKS_PER_DAY };

describe('timeline maths', () => {
  it('maps a position along the bar to a tick inside the range', () => {
    expect(tickAtFraction(range, 0)).toBe(480);
    expect(tickAtFraction(range, 1)).toBe(range.newest);
    expect(tickAtFraction(range, 0.5)).toBe(480 + Math.round(1.5 * TICKS_PER_DAY));
    expect(tickAtFraction(range, -3)).toBe(480);
    expect(tickAtFraction(range, 7)).toBe(range.newest);
  });

  it('steps 15 city minutes, an hour with shift, and stops at both ends', () => {
    expect(STEP_TICKS).toBe(60);
    expect(stepTick(range, 1000, 1, false)).toBe(1060);
    expect(stepTick(range, 1000, -1, false)).toBe(940);
    expect(stepTick(range, 1000, 1, true)).toBe(1000 + TICKS_PER_HOUR);
    expect(stepTick(range, 500, -1, true)).toBe(480);
    expect(stepTick(range, range.newest - 10, 1, false)).toBe(range.newest);
    // Steps stop at the oldest moment, so a run of them is not the sum of their sizes.
    let at = range.oldest + 150;
    for (let i = 0; i < 3; i++) at = stepTick(range, at, -1, false);
    expect(at).toBe(range.oldest);
    expect(stepTick(range, at, 1, false)).toBe(range.oldest + STEP_TICKS);
    expect(clampTick(range, 1e9)).toBe(range.newest);
  });

  it('says how long ago in city time', () => {
    expect(agoText(0)).toBe('just now');
    expect(agoText(4 * 45)).toBe('45 m ago');
    expect(agoText(4 * (3 * 60 + 12))).toBe('3 h 12 m ago');
  });

  it('names a moment by day and time', () => {
    expect(momentText(0)).toBe('Day 1, 00:00');
    expect(momentText(TICKS_PER_DAY + 14 * TICKS_PER_HOUR + 60)).toBe('Day 2, 14:15');
  });

  it('lists the days the range touches and an hour mark for each city hour in it', () => {
    expect(dayBands(range).map((b) => b.day)).toEqual([1, 2, 3, 4]);
    const marks = hourMarks(range);
    expect(marks[0]).toEqual({ tick: 480, major: false });
    expect(marks.length).toBe(73);
    expect(marks.filter((m) => m.major).map((m) => (m.tick / TICKS_PER_HOUR) % 24)).toContain(6);
  });

  it('keeps only the major marks once the range is crowded', () => {
    const marks = hourMarks({ oldest: 0, newest: 6 * TICKS_PER_DAY });
    expect(marks.every((m) => m.major)).toBe(true);
    expect(marks.length).toBe(6 * 4 + 1);
  });
});
