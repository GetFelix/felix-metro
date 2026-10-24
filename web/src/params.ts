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
  /** Follow the city's log through the gateway; false draws it with no traffic, as when no gateway answers. */
  live: boolean;
  /** The gateway's WebSocket URL, or null for `/ws` on the page's own origin. */
  gateway: string | null;
  /** Show the city at this tick, paused, instead of following it live; null to follow it. */
  at: number | null;
  /** Keep a trace of every record taken, in `window.__trace`, for the CI checks. */
  trace: boolean;
  /** Draw only when `window.__capture.frame` asks, for the clip job. Needs `trace`, so a stray link cannot stop a page. */
  capture: boolean;
}

// ?live=0 skips the gateway and draws the city alone, ?gateway=ws://host:8787/ws names a gateway other than the page's own.
// ?layout=frame draws the style frame's city instead of the generated one, ?districts=3 sets the districts per side
// (2 by default) and the hash picks the seed (/#harbor).
// ?at=1234 shows the city at tick 1234 and stays there, for trying out seeking before the timeline exists.
// ?trace keeps what became of every record in `window.__trace`. ?capture (with ?trace) hands the render clock to the clip script.
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
    live: params.get('live') !== '0',
    gateway: params.get('gateway'),
    at: tickParam(params.get('at')),
    trace: params.has('trace'),
    capture: params.has('trace') && params.has('capture'),
  };
}

function tickParam(value: string | null): number | null {
  const tick = value === null || value === '' ? NaN : Number(value);
  return Number.isInteger(tick) && tick >= 0 ? tick : null;
}
