// The page's clock. Time is a tick, never the wall clock, so the sun, the lamps and the cars all follow what the sim
// has committed.

/** A tick is 15 seconds of city time. */
export const TICKS_PER_HOUR = 240;
export const TICKS_PER_DAY = 5760;

/**
 * Seconds the page keeps between what it draws and the newest tick it has. Ticks arrive about every 1/speed seconds,
 * give or take a few tens of ms, and a late one stalls the clock at the newest tick. Half a second absorbs that
 * jitter and is the same time at every speed, where a fixed count of ticks shrinks to 62 ms at 16 ticks a second.
 */
const PLAYOUT_SECONDS = 0.5;

/** The ticks of lag the clock steers to: the playout delay at this speed, and never less than one tick. */
export function playoutLag(speed: number): number {
  return Math.max(1, speed * PLAYOUT_SECONDS);
}

/** Further behind than this many seconds of sim time, the clock jumps to the newest tick instead of steering. */
const SNAP_SECONDS = 3;

/** With no records coming, the clock runs on its own for this long, then waits. */
const COAST_SECONDS = 60;

/** The day, counted from 1, and the hour of it as a fraction, for a tick. */
export function cityTime(tick: number): { day: number; hour: number } {
  return { day: Math.floor(tick / TICKS_PER_DAY) + 1, hour: ((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24 };
}

/**
 * The tick being drawn, as a fraction. It runs at the sim's speed and is steered to stay {@link playoutLag} behind the
 * newest tick: a late record slows it, a burst speeds it up. It never passes the newest tick or moves backwards,
 * except to jump forward when far behind. Positions are a function of this tick alone, so a given tick always draws
 * the same picture; only which tick is on screen depends on when records arrive.
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
    const aim = playoutLag(speed);
    if (Number.isNaN(this.now)) this.now = Math.max(0, latest - aim);
    let lag = latest - this.now;
    // After a hidden tab or a long stall the page is too far behind to catch up by steering: jump.
    if (lag > Math.max(aim + 1, speed * SNAP_SECONDS)) {
      this.now = latest - aim;
      lag = aim;
    }
    const steer = Math.min(2.5, Math.max(0.5, 1 + (lag - aim) * 0.5));
    this.now = Math.min(latest, this.now + dt * speed * steer);
    return this.now;
  }
}
