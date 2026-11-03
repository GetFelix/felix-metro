import type { AmbientSettings } from './ambient-fx';
import type { Tier } from './params';

export const TIERS: readonly Tier[] = ['high', 'medium', 'low'];

export interface TierSettings {
  ao: boolean;
  tiltShift: boolean;
  shadows: boolean;
  shadowMapSize: number;
  pixelRatioCap: number;
  /** Skinned pedestrian rigs. Nothing reads this yet; the pedestrian work in #6 will. */
  rigs: boolean;
  /** Most cars and walkers drawn at once; the rest of the voyages are left out until one arrives. */
  movers: number;
  /** The ambient life: lit shops, chimney smoke, roosting birds, traffic lights, delivery vans and the garbage truck. */
  ambient: AmbientSettings;
}

// The look degrades before the frame rate does: ambient occlusion goes first, then tilt-shift, shadows and resolution.
export function settingsFor(tier: Tier): TierSettings {
  return {
    ao: tier === 'high',
    tiltShift: tier !== 'low',
    shadows: tier !== 'low',
    shadowMapSize: tier === 'high' ? 4096 : 2048,
    pixelRatioCap: tier === 'low' ? 1 : 2,
    rigs: tier === 'high',
    movers: tier === 'high' ? Infinity : tier === 'medium' ? 160 : 80,
    // Low keeps the shop windows, which cost one draw, and leaves out what moves or adds draws.
    ambient:
      tier === 'high'
        ? { shops: true, smoke: 5, birds: 3, vans: 6, truck: true, signals: true }
        : tier === 'medium'
          ? { shops: true, smoke: 3, birds: 2, vans: 3, truck: true, signals: true }
          : { shops: true, smoke: 0, birds: 0, vans: 0, truck: false, signals: false },
  };
}

/** A tier is stepped down when the median frame is slower than this, or than REFRESH_SLACK times the display's interval. */
export const SLOW_MS = 22;
export const REFRESH_SLACK = 1.3;
/** The display interval is estimated from the fastest tenth of frames, within the range of real displays (30 to 240 Hz). */
export const MIN_INTERVAL_MS = 4;
export const MAX_INTERVAL_MS = 33.4;
/** Frames needed before a window is judged. */
export const MIN_SAMPLES = 15;
/** Frames dropped at the start of each window: shader compiles and the post rebuild stall them. */
export const SETTLE_FRAMES = 5;
/** The first window, from the first frame of a ready city. */
export const FIRST_WINDOW_MS = 3000;
/** Each window after a step down. */
export const NEXT_WINDOW_MS = 1500;

export function median(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function stepDown(tier: Tier): Tier {
  return TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)]!;
}

// The display's frame interval: a display that caps at 30 Hz never beats 33 ms, so that is not a slow tier.
export function displayInterval(frameMs: ArrayLike<number>): number {
  const sorted = Array.from(frameMs).sort((a, b) => a - b);
  const fastest = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 10)));
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, median(fastest)));
}

// The tier to run after judging one window of frame times. Never steps up, and never touches a forced tier.
// `refreshMs` is the display's interval measured apart from the frames: a display at 60 Hz whose frames each take two
// refreshes looks, in the frames alone, like a display at 30 Hz, and would never be stepped down.
export function decideTier(
  tier: Tier,
  frameMs: ArrayLike<number>,
  forced: boolean,
  refreshMs: number | null = null,
): Tier {
  if (forced || frameMs.length < MIN_SAMPLES) return tier;
  const interval = refreshMs === null ? displayInterval(frameMs) : clampInterval(refreshMs);
  const limit = Math.max(SLOW_MS, REFRESH_SLACK * interval);
  return median(frameMs) > limit ? stepDown(tier) : tier;
}

const clampInterval = (ms: number) => Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));

/** A gap between two animation frames longer than this is a stall or a hidden tab, not the display's rhythm. */
export const STALL_MS = 100;
/** Gaps the display probe wants before it says what it saw. */
export const PROBE_GAPS = 12;
/** Frames the probe waits for those gaps before it gives up. */
export const PROBE_FRAMES = 60;

/** The display's frame interval from the gaps between frames that drew nothing: the shortest quarter speak for it. */
export function refreshFromGaps(gaps: ArrayLike<number>): number | null {
  if (gaps.length < PROBE_GAPS) return null;
  const sorted = Array.from(gaps).sort((a, b) => a - b);
  return median(sorted.slice(0, Math.max(1, sorted.length >> 2)));
}

const KEY = 'felix-metro.tier';

export function isTier(v: unknown): v is Tier {
  return v === 'high' || v === 'medium' || v === 'low';
}

function readStored(): Tier | null {
  try {
    const v = localStorage.getItem(KEY);
    return isTier(v) ? v : null;
  } catch {
    return null;
  }
}

function writeStored(tier: Tier) {
  try {
    localStorage.setItem(KEY, tier);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}

function clearStored() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing was saved if storage is blocked.
  }
}

export interface QualityOptions {
  /** The ?tier value. */
  url: Tier | null;
  /** A frozen scene has no meaningful frame times, so it never chooses on its own. */
  still: boolean;
  /** True while the page is hidden; its frames are not measured. Defaults to document.hidden. */
  hidden?: () => boolean;
  onChange: (tier: Tier) => void;
}

export interface Quality {
  readonly tier: Tier;
  /** Forced by ?tier, a saved choice or setTier; picked from frame times; or fixed because the scene is frozen. */
  readonly mode: 'auto' | 'forced' | 'still';
  /** Choose a tier by hand. Persists it and stops the automatic choice. */
  setTier(tier: Tier): void;
  /** Go back to choosing from frame times: forget the saved tier and judge again from high, as on a first visit. */
  setAutomatic(): void;
  /** The display's frame interval in ms, once `skipFrame` has measured it. */
  readonly refreshMs: number | null;
  /**
   * Call at the start of every animation frame with its time. While it returns true the page is measuring its display
   * and must draw nothing and not call `tick`. The measure starts when a window ends with frames too slow for a 60 Hz
   * display but fit for a 30 Hz one: from the frames alone those look the same, and only the display can say.
   */
  skipFrame(now: number): boolean;
  /** Every tier the page has run, first to last. */
  readonly history: readonly Tier[];
  /** Feed one frame time in ms after the city is ready. */
  tick(frameMs: number): void;
  /** Throw away the current window, e.g. after the tab was hidden. */
  restartWindow(): void;
}

export function createQuality(opts: QualityOptions): Quality {
  // A frozen scene ignores a saved tier too, so frame runs do not depend on the browser profile.
  const saved = opts.url || opts.still ? null : readStored();
  let tier: Tier = opts.url ?? saved ?? 'high';
  let forced = opts.url !== null || saved !== null;
  let done = forced || opts.still;

  const samples = new Float32Array(2048);
  let count = 0;
  let skipped = 0;
  let elapsed = 0;
  let windowMs = FIRST_WINDOW_MS;
  const history: Tier[] = [tier];
  const hidden = opts.hidden ?? (() => typeof document !== 'undefined' && document.hidden);

  let refreshMs: number | null = null;
  let probe: { last: number; gaps: number[]; frames: number } | null = null;

  // Judge the window just ended, with the display's interval if it is known.
  function judge(refresh: number | null) {
    const next = decideTier(tier, samples.subarray(0, count), forced, refresh);
    if (next === tier) {
      done = true;
      return;
    }
    tier = next;
    history.push(tier);
    restart(NEXT_WINDOW_MS);
    opts.onChange(tier);
  }

  function restart(ms: number) {
    probe = null;
    count = 0;
    skipped = 0;
    elapsed = 0;
    windowMs = ms;
  }

  return {
    get tier() {
      return tier;
    },
    get refreshMs() {
      return refreshMs;
    },
    skipFrame(now) {
      if (!probe) return false;
      const gap = now - probe.last;
      if (gap > 0 && gap < STALL_MS) probe.gaps.push(gap);
      probe.last = now;
      if (probe.gaps.length < PROBE_GAPS && ++probe.frames < PROBE_FRAMES) return true;
      refreshMs = refreshFromGaps(probe.gaps);
      probe = null;
      judge(refreshMs);
      return true;
    },
    get history() {
      return history;
    },
    get mode() {
      return forced ? 'forced' : opts.still ? 'still' : 'auto';
    },
    setTier(next) {
      probe = null;
      forced = true;
      done = true;
      writeStored(next);
      if (next === tier) return;
      tier = next;
      history.push(tier);
      opts.onChange(tier);
    },
    setAutomatic() {
      clearStored();
      forced = false;
      // A frozen scene still never chooses on its own.
      done = opts.still;
      restart(FIRST_WINDOW_MS);
      if (tier === 'high') return;
      tier = 'high';
      history.push(tier);
      opts.onChange(tier);
    },
    restartWindow() {
      restart(windowMs);
    },
    tick(frameMs) {
      if (done || hidden()) return;
      elapsed += frameMs;
      if (skipped < SETTLE_FRAMES) skipped++;
      else if (count < samples.length) samples[count++] = frameMs;
      if (elapsed < windowMs || count < MIN_SAMPLES) return;
      const window = samples.subarray(0, count);
      // Slow, yet no slower than a 30 Hz display would make it: measure the display before believing it.
      if (refreshMs === null && median(window) > SLOW_MS && decideTier(tier, window, forced) === tier) {
        probe = { last: NaN, gaps: [], frames: 0 };
        return;
      }
      judge(refreshMs);
    },
  };
}
