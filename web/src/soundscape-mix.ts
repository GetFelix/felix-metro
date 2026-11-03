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

/** Seconds between changes to the crickets' level, and the range it moves in (1 is the recording as it is). */
export const SWELL = { minGap: 4, maxGap: 11, lowest: 0.55, highest: 1 };

/** When the crickets' level next changes and where it goes, drawn from `random` (0 up to 1, as `Math.random`). */
export function nextSwell(random: () => number): { gap: number; level: number } {
  return {
    gap: SWELL.minGap + random() * (SWELL.maxGap - SWELL.minGap),
    level: SWELL.lowest + random() * (SWELL.highest - SWELL.lowest),
  };
}

/** Where in a recording of `duration` seconds to start looping, so each visit hears the night from somewhere new. */
export function startOffset(random: () => number, duration: number): number {
  return random() * duration;
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
