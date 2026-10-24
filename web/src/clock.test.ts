import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TickClock, cityTime } from './clock';

describe('cityTime', () => {
  it('counts days from 1 and hours from midnight', () => {
    expect(cityTime(0)).toEqual({ day: 1, hour: 0 });
    expect(cityTime(17 * 240 + 120)).toEqual({ day: 1, hour: 17.5 });
    expect(cityTime(TICKS_PER_DAY * 2 + 240)).toEqual({ day: 3, hour: 1 });
  });
});

describe('TickClock', () => {
  it('starts one tick behind the newest and waits for a first record', () => {
    const clock = new TickClock();
    expect(clock.advance(0.1, -1, 4)).toBeNaN();
    expect(clock.advance(0, 100, 4)).toBe(99);
  });

  it('follows a steady sim without drifting from its one tick of lag', () => {
    const clock = new TickClock();
    let latest = 50;
    clock.advance(0, latest, 4);
    for (let frame = 0; frame < 600; frame++) {
      latest = 50 + Math.floor(frame * (1 / 60) * 4);
      clock.advance(1 / 60, latest, 4);
    }
    expect(latest - clock.now).toBeGreaterThan(0.4);
    expect(latest - clock.now).toBeLessThan(1.6);
  });

  it('never passes the newest tick, and a pause stops it there', () => {
    const clock = new TickClock();
    clock.advance(0, 10, 0);
    for (let i = 0; i < 100; i++) clock.advance(0.1, 10, 4);
    expect(clock.now).toBe(10);
  });

  it('never runs backwards and catches up after a stall', () => {
    const clock = new TickClock();
    clock.advance(0, 10, 4);
    let last = clock.now;
    for (let frame = 0; frame < 300; frame++) {
      const latest = frame < 60 ? 10 : 40;
      const now = clock.advance(1 / 60, latest, 4);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(40 - last).toBeLessThan(2);
  });

  it('jumps to just behind the newest tick after a long stall', () => {
    const clock = new TickClock();
    clock.advance(0.016, 10, 4);
    // A hidden tab: the sim went on for a minute.
    const now = clock.advance(0.016, 250, 4);
    expect(now).toBeGreaterThanOrEqual(249);
    expect(now).toBeLessThanOrEqual(250);
  });

  it('steers instead of jumping when only a little behind', () => {
    const clock = new TickClock();
    clock.advance(0.016, 10, 4);
    expect(clock.advance(0.016, 20, 4)).toBeLessThan(11);
  });
});
