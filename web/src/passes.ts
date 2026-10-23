import type { Tier } from './params';
import { settingsFor } from './quality';

export const PASS_ORDER = ['render', 'ao', 'bloom', 'tilt-shift', 'output', 'grade'] as const;
export type PassName = (typeof PASS_ORDER)[number];

// Which passes a tier runs, always in PASS_ORDER.
export function passesFor(tier: Tier): PassName[] {
  const s = settingsFor(tier);
  return PASS_ORDER.filter((n) => !(n === 'ao' && !s.ao) && !(n === 'tilt-shift' && !s.tiltShift));
}

// Drops the named passes and keeps the rest in order.
export function without(passes: readonly PassName[], ...drop: PassName[]): PassName[] {
  return passes.filter((n) => !drop.includes(n));
}
