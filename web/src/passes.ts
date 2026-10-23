import type { Tier } from './params';

export const PASS_ORDER = ['render', 'ao', 'bloom', 'tilt-shift', 'output', 'grade'] as const;
export type PassName = (typeof PASS_ORDER)[number];

// Which passes a tier runs, always in PASS_ORDER.
export function passesFor(tier: Tier): PassName[] {
  return PASS_ORDER.filter((n) => !(n === 'ao' && tier !== 'high') && !(n === 'tilt-shift' && tier === 'low'));
}

// Drops the named passes and keeps the rest in order.
export function without(passes: readonly PassName[], ...drop: PassName[]): PassName[] {
  return passes.filter((n) => !drop.includes(n));
}
