// Who built what. The sim's `author` and `command` events tell the state who put up each building; this turns that into
// the words on the hover card and the tick "See it go up" goes to.
import type { CityState } from './city';
import { NO_BUILDING } from './city';
import { TICKS_PER_DAY, cityTime } from './clock';
import { TREE_FIRST } from './kinds';
import type { City } from './layout';

/**
 * The 64-bit FNV-1a hash of a Felix principal's UTF-8 bytes, as 16 hex digits: what a `command` or `author` event
 * carries in place of the principal, so the log never holds it. The same as `principal_hash` in core/src/record.rs;
 * core.test.ts checks the two give the same digits.
 */
export function principalHash(principal: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(principal)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** What the page can say of the building on a lot. */
export type Provenance =
  | { kind: 'built'; name: string; mine: boolean; tick: number }
  /** The city was generated with it. */
  | { kind: 'start' }
  /** Someone built it, but the log the page read does not say who. */
  | { kind: 'earlier' };

/** Lots already warned about, so a hover does not log the same thing every frame. */
const warned = new Set<number>();

/**
 * Who built the building on `lot`, or `null` when no building stands there. `me` is the signed-in person's principal,
 * when the gateway named it; a building they put up reads as theirs.
 */
export function provenance(lot: number, city: City, state: CityState, me: string | null): Provenance | null {
  const author = state.authors.get(lot);
  const now = state.built.get(lot);
  if (author && now?.kind !== NO_BUILDING) {
    return {
      kind: 'built',
      name: author.name,
      mine: me !== null && author.principal === principalHash(me),
      tick: author.tick,
    };
  }
  if (now) {
    if (now.kind === NO_BUILDING || now.kind >= TREE_FIRST) return null;
    // Anything built since generation should have an author. Say less rather than something wrong.
    if (!warned.has(lot)) {
      warned.add(lot);
      console.warn(`lot ${lot} was built by someone the log does not name`);
    }
    return { kind: 'earlier' };
  }
  const generated = city.lots[lot]?.kind;
  return generated !== undefined && generated < TREE_FIRST ? { kind: 'start' } : null;
}

/** `Day 2, 09:12` for the city's clock at `tick`. */
export function whenText(tick: number): string {
  const { day } = cityTime(tick);
  // In whole numbers, so 09:12 is not 09:11 for the want of a rounding error.
  const minutes = Math.floor(((tick % TICKS_PER_DAY) * 1440) / TICKS_PER_DAY);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `Day ${day}, ${hh}:${mm}`;
}

/** The line on the card, without the link. */
export function cardText(p: Provenance): string {
  switch (p.kind) {
    case 'built':
      return `Built by ${p.mine ? 'you' : p.name} · ${whenText(p.tick)}`;
    case 'start':
      return 'Here since the start';
    case 'earlier':
      return 'Built earlier';
  }
}

/** The link after the line, for a building whose rise the log holds. */
export const GO_UP_TEXT = 'See it go up';

/** Ticks before the `built` event that "See it go up" starts at: the lot is still bare, then the building rises. */
export const LEAD_TICKS = 2;

/** Where "See it go up" takes the page, or `null` when the building has no start the page knows. */
export function goUpTick(p: Provenance): number | null {
  return p.kind === 'built' ? Math.max(0, p.tick - LEAD_TICKS) : null;
}
