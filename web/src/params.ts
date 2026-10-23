import { seedFromHash, type Layout } from './layout';
import { isTier } from './quality';

export type Tier = 'low' | 'medium' | 'high';

export interface Params {
  /** Hour the clock is frozen at, or null to follow the slider. */
  frozenHour: number | null;
  /** Freeze cars and people. */
  still: boolean;
  /** The tier asked for in the URL, or null to use the saved or automatic choice. */
  tier: Tier | null;
  ui: boolean;
  hud: boolean;
  /** Busy-wait this many ms every frame, to exercise the automatic step-down. Zero for none. */
  slow: number;
  layout: Layout;
  /** The seed, from the hash. */
  seed: string;
  districts: number;
}

// ?layout=frame draws the style frame's city instead of the generated one, ?districts=3 sets the districts per side
// (2 by default) and the hash picks the seed (/#harbor).
// ?t=18.5 freezes the clock at that hour, ?still freezes motion, ?tier=low|medium|high forces a tier, ?ui=0 hides the
// overlay, ?hud shows frame statistics, ?slow=40 adds 40 ms to every frame.
export function parseParams(search: string, hash = ''): Params {
  const params = new URLSearchParams(search);
  const tier = params.get('tier');
  return {
    frozenHour: params.has('t') ? parseFloat(params.get('t')!) : null,
    still: params.has('still'),
    tier: isTier(tier) ? tier : null,
    ui: params.get('ui') !== '0',
    hud: params.has('hud'),
    slow: Math.max(0, parseFloat(params.get('slow') ?? '') || 0),
    layout: params.get('layout') === 'frame' ? 'frame' : 'city',
    seed: seedFromHash(hash),
    districts: Math.min(16, Math.max(1, parseInt(params.get('districts') ?? '2', 10) || 2)),
  };
}
