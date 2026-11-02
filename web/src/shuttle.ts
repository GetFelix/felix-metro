// The J, K and L keys. They move along one ladder of rates, the way an editing suite's shuttle does: L goes faster
// forward, J goes slower or backward, K stops. A negative rate plays the past backwards.

import { isTypingTarget } from './ui/keys';

/** Playback rates, in multiples of the city's own speed; negative rewinds, 0 is stopped. */
export const RATES = [-8, -4, -2, -1, 0, 0.5, 1, 2, 4, 8] as const;

export type ShuttleKey = 'j' | 'k' | 'l';

export interface Transport {
  /** Multiples of the city's speed; the sign is the direction. Kept while paused. */
  rate: number;
  paused: boolean;
}

/**
 * What a key does to the transport. From a stop, J rewinds at 1x and L plays at 1x. Moving, each press goes one rung
 * along {@link RATES}: L towards faster forward (a rewind slows to a stop first), J towards faster backward.
 */
export function shuttle(now: Transport, key: ShuttleKey): Transport {
  if (key === 'k') return { rate: now.rate, paused: true };
  const rate = now.paused ? 0 : now.rate;
  if (rate === 0) return { rate: key === 'l' ? 1 : -1, paused: false };
  const at = Math.max(
    0,
    RATES.findIndex((r) => r >= rate),
  );
  const to = RATES[Math.min(RATES.length - 1, Math.max(0, at + (key === 'l' ? 1 : -1)))]!;
  return to === 0 ? { rate, paused: true } : { rate: to, paused: false };
}

/** The key in a keyboard event, or null when it is another key, a browser shortcut, or text being typed. */
export function shuttleKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}): ShuttleKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target as Parameters<typeof isTypingTarget>[0])) return null;
  const key = e.key.toLowerCase();
  return key === 'j' || key === 'k' || key === 'l' ? key : null;
}

/** The rate in words for the status line: `4x`, `0.5x`, `Rewind 2x`. */
export function rateText(rate: number): string {
  return rate < 0 ? `Rewind ${-rate}x` : `${rate}x`;
}
