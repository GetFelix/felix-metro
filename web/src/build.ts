// What a builder may do to a lot, and the bytes that ask the sim for it. The rules mirror sim/src/world.rs: the page
// refuses what the sim would refuse, so a person is told at once instead of after a round trip.
import { NO_BUILDING, type Building } from './city';
import { KINDS } from './kinds';
import type { City } from './layout';

/** Kinds from here are trees and plaza props: nothing a builder counts as a building. Mirrors core's `TREE_FIRST`. */
export const TREE_FIRST = 38;

/** The longest display name a command record carries, in bytes. */
const MAX_NAME_BYTES = 64;

/** The result codes of a `command` event, from core/src/record.rs. */
export const RESULT_APPLIED = 0;

/** Whether `kind` counts as bare ground: nothing, or only trees and plaza props. */
export const isEmpty = (kind: number): boolean => kind === NO_BUILDING || kind >= TREE_FIRST;

/** Either fine, or the plain-words reason a lot is refused. */
export type Check = { ok: true } | { ok: false; why: string };

const OK: Check = { ok: true };
const no = (why: string): Check => ({ ok: false, why });

/** What the page can see of a city: its generated lots and development area, and what builders have changed. */
export interface Ground {
  city: Pick<City, 'lots' | 'development'>;
  built: ReadonlyMap<number, Building>;
}

/** The kind standing on `lot` now: a builder's change, else the generated city's. */
export function kindOn(ground: Ground, lot: number): number | null {
  const generated = ground.city.lots[lot];
  if (!generated) return null;
  return ground.built.get(lot)?.kind ?? generated.kind;
}

/** The lots a builder may change are the development area, where no resident goes. */
function isDevelopment(ground: Ground, lot: number): boolean {
  return ground.city.development.includes(lot);
}

/**
 * Whether a building may go up on `lot`. The sim also refuses a lot residents go to, but the development area is the
 * only ground set aside that none do, and the page offers nothing else.
 */
export function canBuild(ground: Ground, lot: number): Check {
  const kind = kindOn(ground, lot);
  if (kind === null) return no('That spot is not on the map.');
  if (!isDevelopment(ground, lot)) return no('Only the cleared ground can be built on.');
  if (!isEmpty(kind)) return no('There is already a building here.');
  return OK;
}

/**
 * Whether the building on `lot` may come down. The sim refuses homes, workplaces and parks, which are the generated
 * city's, so only the cleared ground is offered: a building there is a builder's own.
 */
export function canDemolish(ground: Ground, lot: number): Check {
  const kind = kindOn(ground, lot);
  if (kind === null) return no('That spot is not on the map.');
  if (isEmpty(kind)) return no('There is nothing here to take down.');
  if (!isDevelopment(ground, lot)) return no('Only buildings on the cleared ground can be taken down.');
  return OK;
}

/** What a refused command is told to the person as, by the result code of its `command` event. */
export function refusal(result: number): string {
  switch (result) {
    case 1:
      return 'The city could not read that.';
    case 2:
      return 'That spot is not on the map.';
    case 3:
      return 'Someone built there first.';
    case 4:
      return 'There was nothing left there to take down.';
    case 5:
      return 'The city has no such building.';
    case 7:
      return 'The city cannot do that yet.';
    case 8:
      return 'People live or work there, so it stays.';
    case 9:
      return 'The city is busy. Try again.';
    default:
      return 'The city turned that down.';
  }
}

// ---------- the buildings on offer ----------

export interface Choice {
  kind: number;
  /** "House C", "Water tower". */
  label: string;
}

export interface Family {
  title: string;
  choices: Choice[];
}

const upper = (letter: string) => letter.toUpperCase();

/** A building kind in words, from its model's name. */
export function kindLabel(kind: number): string {
  const entry = KINDS[kind];
  if (!entry) return 'Unknown';
  const { pack, model } = entry;
  if (model === 'water-tower') return 'Water tower';
  if (model === 'chimney-large') return 'Chimney';
  if (model === 'detail-tank-large') return 'Storage tank';
  const letter = upper(model.slice(model.lastIndexOf('-') + 1));
  if (model.startsWith('building-skyscraper')) return `Skyscraper ${letter}`;
  if (pack === 'suburban') return `House ${letter}`;
  if (pack === 'industrial') return `Factory ${letter}`;
  return `Commercial ${letter}`;
}

/** Every kind a builder may place, grouped as the page lists them. */
export function families(): Family[] {
  const groups: Family[] = [
    { title: 'Commercial', choices: [] },
    { title: 'Skyscrapers', choices: [] },
    { title: 'Houses', choices: [] },
    { title: 'Factories', choices: [] },
  ];
  for (let kind = 0; kind < TREE_FIRST; kind++) {
    const { pack, model } = KINDS[kind]!;
    const group = model.startsWith('building-skyscraper')
      ? groups[1]!
      : pack === 'suburban'
        ? groups[2]!
        : pack === 'industrial'
          ? groups[3]!
          : groups[0]!;
    group.choices.push({ kind, label: kindLabel(kind) });
  }
  return groups;
}

/** The kind after `kind`, `step` places on, wrapping round the buildings on offer. */
export function nextKind(kind: number, step: number): number {
  return (((kind + step) % TREE_FIRST) + TREE_FIRST) % TREE_FIRST;
}

/** The kind a first tool starts on: a house, which reads well on any lot. */
export const FIRST_KIND = 19;

// ---------- the bytes ----------

/** The name an ID token gives its holder, which commands carry; `fallback` when it has none. */
export function nameFrom(token: string, fallback = 'Builder'): string {
  try {
    const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    const name = claims.name ?? claims.preferred_username;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : fallback;
  } catch {
    return fallback;
  }
}

const CMD_BUILD = 3;
const CMD_DEMOLISH = 4;
const RECORD_COMMAND = 2;

/** `text` cut to at most `max` bytes of UTF-8 without splitting a character. */
export function clipName(text: string, max = MAX_NAME_BYTES): Uint8Array {
  const encoder = new TextEncoder();
  let out = '';
  let used = 0;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return encoder.encode(out);
}

function record(id: number, name: string, body: number[]): Uint8Array {
  const display = clipName(name);
  const out = new Uint8Array(1 + 4 + 1 + display.length + body.length);
  const view = new DataView(out.buffer);
  out[0] = RECORD_COMMAND;
  view.setUint32(1, id, true);
  out[5] = display.length;
  out.set(display, 6);
  out.set(body, 6 + display.length);
  return out;
}

const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A `build` command record, as published to the city's command stream. */
export function buildCommand(id: number, name: string, lot: number, kind: number, rotation: number): Uint8Array {
  return record(id, name, [CMD_BUILD, ...u32(lot), kind & 0xff, kind >>> 8, rotation]);
}

/** A `demolish` command record. */
export function demolishCommand(id: number, name: string, lot: number): Uint8Array {
  return record(id, name, [CMD_DEMOLISH, ...u32(lot)]);
}

/** A random command id; two builders drawing the same one in the few seconds a command is waiting is a one in four billion. */
export function newId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
