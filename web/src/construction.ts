// Construction and demolition as a function of ticks. A `built` or `demolished` event is instantaneous in the log; the
// page spreads it over the next few ticks of city time, so the picture depends only on the event's tick and the tick
// drawn, and rewinding plays it backwards.

/** Ticks a building takes to rise or to come down. */
export const WINDOW = 8;

/** How far along the window `tick` is: 0 before the event and at it, 1 from the end of the window on. */
export function progress(eventTick: number, tick: number): number {
  return Math.min(1, Math.max(0, (tick - eventTick) / WINDOW));
}

/** The height of a rising building as a share of its full height. */
export function riseScale(eventTick: number, tick: number): number {
  return progress(eventTick, tick);
}

/**
 * The height of a building coming down. `from` is the share it stood at when it was demolished: 1, or less when the
 * demolition came while it was still going up, so it comes down from where it was instead of jumping to full height.
 */
export function fallScale(eventTick: number, tick: number, from = 1): number {
  return from * (1 - progress(eventTick, tick));
}
