import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TickClock, cityTime, playoutLag } from './clock';

describe('cityTime', () => {
  it('counts days from 1 and hours from midnight', () => {
    expect(cityTime(0)).toEqual({ day: 1, hour: 0 });
    expect(cityTime(17 * 240 + 120)).toEqual({ day: 1, hour: 17.5 });
    expect(cityTime(TICKS_PER_DAY * 2 + 240)).toEqual({ day: 3, hour: 1 });
  });
});

describe('TickClock', () => {
  it('keeps half a second of ticks in hand, and at least one', () => {
    expect(playoutLag(4)).toBe(2);
    expect(playoutLag(16)).toBe(8);
    expect(playoutLag(0)).toBe(1);
  });

  it('starts the playout delay behind the newest and waits for a first record', () => {
    const clock = new TickClock();
    expect(clock.advance(0.1, -1, 4)).toBeNaN();
    expect(clock.advance(0, 100, 4)).toBe(98);
    expect(new TickClock().advance(0, 100, 16)).toBe(92);
  });

  it('follows a steady sim without drifting from its playout delay', () => {
    const clock = new TickClock();
    let latest = 50;
    clock.advance(0, latest, 4);
    for (let frame = 0; frame < 600; frame++) {
      latest = 50 + Math.floor(frame * (1 / 60) * 4);
      clock.advance(1 / 60, latest, 4);
    }
    expect(latest - clock.now).toBeGreaterThan(1.4);
    expect(latest - clock.now).toBeLessThan(2.6);
  });

  it('rides out a tick that is late by most of a second without standing still', () => {
    for (const speed of [4, 16]) {
      const clock = new TickClock();
      const dt = 1 / 60;
      let latest = 100;
      clock.advance(0, latest, speed);
      // Steady ticks, then one 400 ms late, then the sim carries on.
      let sim = 0;
      let stalled = 0;
      let last = clock.now;
      for (let frame = 0; frame < 60 * 12; frame++) {
        sim += dt;
        const late = sim > 6 && sim < 6.4;
        if (!late) latest = 100 + Math.floor(sim * speed - (sim >= 6.4 ? 0.4 * speed : 0));
        const now = clock.advance(dt, latest, speed);
        if (frame > 120 && now === last) stalled++;
        last = now;
      }
      expect(stalled).toBe(0);
    }
  });

  it('runs on to the newest tick when the city is paused, so the picture shows where the sim stopped', () => {
    for (const speed of [4, 16]) {
      const clock = new TickClock();
      clock.advance(0, 100, speed);
      for (let i = 0; i < 10; i++) clock.advance(1 / 60, 100, speed);
      // The pause: the newest tick is the last one, and the speed is now 0.
      expect(clock.now).toBeLessThan(100);
      for (let i = 0; i < 60 * 3; i++) clock.advance(1 / 60, 100, 0);
      expect(clock.now).toBe(100);
    }
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
    expect(now).toBeGreaterThanOrEqual(248);
    expect(now).toBeLessThanOrEqual(250);
  });

  it('steers instead of jumping when only a little behind', () => {
    const clock = new TickClock();
    clock.advance(0.016, 10, 4);
    expect(clock.advance(0.016, 20, 4)).toBeLessThan(11);
  });

  it('runs on past the newest tick while the connection is down, then waits for the records', () => {
    const clock = new TickClock();
    clock.advance(0, 100, 4);
    for (let i = 0; i < 300; i++) clock.advance(1 / 60, 100, 4, true);
    expect(clock.now).toBeCloseTo(98 + 20, 5);
    // The records come back: it holds until the newest tick passes it, and never moves backwards.
    const held = clock.now;
    expect(clock.advance(1 / 60, 110, 4)).toBe(held);
    expect(clock.advance(1 / 60, 150, 4)).toBeGreaterThanOrEqual(held);
  });

  it('stops running on its own after a minute without records', () => {
    const clock = new TickClock();
    clock.advance(0, 100, 4);
    for (let i = 0; i < 70 * 60; i++) clock.advance(1 / 60, 100, 4, true);
    expect(clock.now).toBeCloseTo(98 + 60 * 4, 0);
  });
});
