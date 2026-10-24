// The page's clock. Time is a tick, never the wall clock, so the sun, the lamps and the cars all follow what the sim
// has committed.

/** A tick is 15 seconds of city time. */
export const TICKS_PER_HOUR = 240;
export const TICKS_PER_DAY = 5760;

/** Ticks the page keeps between what it draws and the newest tick it has, so motion has both ends to run between. */
const LAG = 1;

/** The day, counted from 1, and the hour of it as a fraction, for a tick. */
export function cityTime(tick: number): { day: number; hour: number } {
  return { day: Math.floor(tick / TICKS_PER_DAY) + 1, hour: ((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24 };
}

/**
 * The tick being drawn, as a fraction. It runs at the sim's speed and is steered to stay one tick behind the newest
 * one: a late record slows it, a burst speeds it up, and it never passes the newest tick or moves backwards.
 */
export class TickClock {
  /** The tick drawn now, or `NaN` before the first record arrives. */
  now = NaN;

  /** Advance by `dt` seconds. `latest` is the newest tick every district has, `speed` the sim's ticks a second. */
  advance(dt: number, latest: number, speed: number): number {
    if (latest < 0) return this.now;
    if (Number.isNaN(this.now)) this.now = Math.max(0, latest - LAG);
    const lag = latest - this.now;
    const steer = Math.min(2.5, Math.max(0.5, 1 + (lag - LAG) * 0.5));
    this.now = Math.min(latest, this.now + dt * speed * steer);
    return this.now;
  }
}
