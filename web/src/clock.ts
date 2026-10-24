// The page's clock. Time is a tick, never the wall clock, so the sun, the lamps and the cars all follow what the sim
// has committed.

/** A tick is 15 seconds of city time. */
export const TICKS_PER_HOUR = 240;
export const TICKS_PER_DAY = 5760;

/** Ticks the page keeps between what it draws and the newest tick it has, so motion has both ends to run between. */
const LAG = 1;

/** Further behind than this many seconds of sim time, the clock jumps to the newest tick instead of steering. */
const SNAP_SECONDS = 3;

/** With no records coming, the clock runs on its own for this long, then waits. */
const COAST_SECONDS = 60;

/** The day, counted from 1, and the hour of it as a fraction, for a tick. */
export function cityTime(tick: number): { day: number; hour: number } {
  return { day: Math.floor(tick / TICKS_PER_DAY) + 1, hour: ((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24 };
}

/**
 * The tick being drawn, as a fraction. It runs at the sim's speed and is steered to stay one tick behind the newest
 * one: a late record slows it, a burst speeds it up, and it never passes the newest tick or moves backwards, except to jump forward when far behind.
 */
export class TickClock {
  /** The tick drawn now, or `NaN` before the first record arrives. */
  now = NaN;
  private coasted = 0;

  /**
   * Advance by `dt` seconds. `latest` is the newest tick every district has, `speed` the sim's ticks a second. With
   * `coast` the connection is down: the clock runs on at `speed` past `latest`, for a minute at most, so the city keeps
   * moving until the records catch up. It never moves backwards when they do; it waits for them.
   */
  advance(dt: number, latest: number, speed: number, coast = false): number {
    if (latest < 0) return this.now;
    if (coast) {
      if (this.coasted < COAST_SECONDS) {
        this.coasted += dt;
        this.now += dt * speed;
      }
      return this.now;
    }
    this.coasted = 0;
    if (this.now > latest) return this.now;
    if (Number.isNaN(this.now)) this.now = Math.max(0, latest - LAG);
    let lag = latest - this.now;
    // After a hidden tab or a long stall the page is too far behind to catch up by steering: jump.
    if (lag > Math.max(LAG + 1, speed * SNAP_SECONDS)) {
      this.now = latest - LAG;
      lag = LAG;
    }
    const steer = Math.min(2.5, Math.max(0.5, 1 + (lag - LAG) * 0.5));
    this.now = Math.min(latest, this.now + dt * speed * steer);
    return this.now;
  }
}
