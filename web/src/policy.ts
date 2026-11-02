// How the page shows the mayor's policies: shop hours and a speed limit for each road class, with when each can
// change again.
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';

/** The policy event of a record: shop hours, avenue limit and street limit, in that order. */
export interface PolicyEvent {
  type: 'policy';
  settings: PolicySetting[];
}

export interface PolicySetting {
  value: number;
  /** The tick of the last change, or `null` if it has never changed. */
  changed: number | null;
}

export interface PolicyRow {
  name: string;
  value: string;
  /** When the policy can change again, or `null` if it can change now. */
  again: string | null;
}

/** Ticks a policy stays as set: one city day. */
export const COOLDOWN_TICKS = TICKS_PER_DAY;

/** A tick as the clock shows it: `Day 3, 06:15`. */
export function clockText(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const within = tick % TICKS_PER_DAY;
  const hours = Math.floor(within / TICKS_PER_HOUR);
  const minutes = Math.floor((within % TICKS_PER_HOUR) / 4);
  return `Day ${day}, ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const limit = (v: number) => (v >= 100 ? 'No limit' : `${v}% of their speed`);

/** The settings of a city whose policies have never changed, which writes no `policy` event on a keyframe. */
export const USUAL_POLICY: PolicyEvent = {
  type: 'policy',
  settings: [
    { value: 0, changed: null },
    { value: 100, changed: null },
    { value: 100, changed: null },
  ],
};

/** The rows to show at tick `now`; a policy whose cooldown has ended has nothing to wait for. */
export function policyRows(event: PolicyEvent, now: number): PolicyRow[] {
  const [shops, avenues, streets] = event.settings;
  if (!shops || !avenues || !streets) return [];
  const row = (name: string, s: PolicySetting, value: string): PolicyRow => ({
    name,
    value,
    again: s.changed === null || s.changed + COOLDOWN_TICKS <= now ? null : clockText(s.changed + COOLDOWN_TICKS),
  });
  return [
    row('Shop hours', shops, shops.value === 0 ? 'Usual' : `${shops.value} h later`),
    row('Avenue speed limit', avenues, limit(avenues.value)),
    row('Street speed limit', streets, limit(streets.value)),
  ];
}
