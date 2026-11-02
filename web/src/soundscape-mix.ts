// What the ambient sound is made of at a given hour, as plain numbers, so the mix can be tested without a browser.
import { night } from './daylight';

/** The level of each layer, 0 to 1. */
export interface Mix {
  /** The hum and hiss of cars on the streets. */
  traffic: number;
  /** Crickets calling. */
  crickets: number;
}

/** The streets never go fully quiet: a faint hum stays under the night. */
const NIGHT_TRAFFIC = 0.18;

/**
 * The layers at an hour of the day. It follows the sky's own dusk and dawn curve (`night` in daylight.ts), so the crickets
 * come in as the lamps do and traffic fades over the same hours, with no jump anywhere.
 */
export function mixAt(hour: number): Mix {
  const dark = night(hour);
  return { traffic: NIGHT_TRAFFIC + (1 - NIGHT_TRAFFIC) * (1 - dark), crickets: dark };
}

/** The shortest gap between two whooshes, in milliseconds; a drag along the timeline would otherwise rattle. */
export const WHOOSH_GAP_MS = 1500;

/** Whether a whoosh may play now, given when the last one began (null for none yet). */
export function whooshDue(lastMs: number | null, nowMs: number, gapMs = WHOOSH_GAP_MS): boolean {
  return lastMs === null || nowMs - lastMs >= gapMs;
}

/** Whether a change of rate starts a rewind: it runs backwards now and was not before. */
export function startsRewind(
  before: { rate: number; paused: boolean },
  after: { rate: number; paused: boolean },
): boolean {
  const backwards = (t: { rate: number; paused: boolean }) => !t.paused && t.rate < 0;
  return backwards(after) && !backwards(before);
}

/** Whether moving the view from one tick to another goes into the past. */
export function intoThePast(from: number, to: number): boolean {
  return to < from;
}
