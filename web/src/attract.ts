// Attract mode: after a while with no one at the page the camera turns slowly, so a screen left on a wall shows the city.

/** How long the page waits for a touch before it starts turning, unless `?attract` says otherwise. */
export const ATTRACT_SECONDS = 60;

/** Radians a second: a full turn in about two minutes. */
export const ATTRACT_RATE = 0.05;

export interface Attract {
  /** Someone is here: restart the wait. */
  poke(now: number): void;
  /** Whether the wait is over at `now`. */
  active(now: number): boolean;
}

/** `seconds` of quiet before it starts; zero turns it off. Times are in ms, from the same clock. */
export function createAttract(now: number, seconds = ATTRACT_SECONDS): Attract {
  let last = now;
  return {
    poke(t) {
      last = t;
    },
    active(t) {
      return seconds > 0 && t - last >= seconds * 1000;
    },
  };
}
