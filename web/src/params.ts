export type Tier = 'low' | 'medium' | 'high';

export interface Params {
  /** Hour the clock is frozen at, or null to follow the slider. */
  frozenHour: number | null;
  /** Freeze cars and people. */
  still: boolean;
  tier: Tier;
  ui: boolean;
}

// ?t=18.5 freezes the clock at that hour, ?still freezes motion, ?tier=low|medium|high, ?ui=0 hides the overlay.
export function parseParams(search: string): Params {
  const params = new URLSearchParams(search);
  return {
    frozenHour: params.has('t') ? parseFloat(params.get('t')!) : null,
    still: params.has('still'),
    tier: (params.get('tier') || 'high') as Tier,
    ui: params.get('ui') !== '0',
  };
}
