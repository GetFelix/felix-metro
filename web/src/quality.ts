import type { Tier } from './params';

export const TIERS: readonly Tier[] = ['high', 'medium', 'low'];

export interface TierSettings {
  ao: boolean;
  tiltShift: boolean;
  shadows: boolean;
  shadowMapSize: number;
  pixelRatioCap: number;
  /** Skinned pedestrian rigs; read by the pedestrian code. */
  rigs: boolean;
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
  };
}

/** A tier is stepped down when the median frame is slower than this. */
export const SLOW_MS = 22;
/** Frames needed before a window is judged. */
export const MIN_SAMPLES = 30;
/** Frames dropped at the start of each window: shader compiles and the post rebuild stall them. */
export const SETTLE_FRAMES = 10;
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

// The tier to run after judging one window of frame times. Never steps up, and never touches a forced tier.
export function decideTier(tier: Tier, frameMs: ArrayLike<number>, forced: boolean): Tier {
  if (forced || frameMs.length < MIN_SAMPLES) return tier;
  return median(frameMs) > SLOW_MS ? stepDown(tier) : tier;
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

export interface QualityOptions {
  /** The ?tier value. */
  url: Tier | null;
  /** A frozen scene has no meaningful frame times, so it never chooses on its own. */
  still: boolean;
  onChange: (tier: Tier) => void;
}

export interface Quality {
  readonly tier: Tier;
  /** Forced by ?tier, a saved choice or setTier; picked from frame times; or fixed because the scene is frozen. */
  readonly mode: 'auto' | 'forced' | 'still';
  /** Choose a tier by hand. Persists it and stops the automatic choice. */
  setTier(tier: Tier): void;
  /** Feed one frame time in ms after the city is ready. */
  tick(frameMs: number): void;
}

export function createQuality(opts: QualityOptions): Quality {
  const saved = opts.url ? null : readStored();
  let tier: Tier = opts.url ?? saved ?? 'high';
  let forced = opts.url !== null || saved !== null;
  let done = forced || opts.still;

  const samples = new Float32Array(2048);
  let count = 0;
  let skipped = 0;
  let elapsed = 0;
  let window = FIRST_WINDOW_MS;

  function restart(ms: number) {
    count = 0;
    skipped = 0;
    elapsed = 0;
    window = ms;
  }

  return {
    get tier() {
      return tier;
    },
    get mode() {
      return forced ? 'forced' : opts.still ? 'still' : 'auto';
    },
    setTier(next) {
      forced = true;
      done = true;
      writeStored(next);
      if (next === tier) return;
      tier = next;
      opts.onChange(tier);
    },
    tick(frameMs) {
      if (done) return;
      elapsed += frameMs;
      if (skipped < SETTLE_FRAMES) skipped++;
      else if (count < samples.length) samples[count++] = frameMs;
      if (elapsed < window || count < MIN_SAMPLES) return;
      const next = decideTier(tier, samples.subarray(0, count), forced);
      if (next === tier) {
        done = true;
        return;
      }
      tier = next;
      restart(NEXT_WINDOW_MS);
      opts.onChange(tier);
    },
  };
}
