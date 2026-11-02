// What a builder may do to a lot, and the bytes that ask the sim for it. The rules mirror sim/src/world.rs: the page
// refuses what the sim would refuse, so a person is told at once instead of after a round trip.
import { NO_BUILDING, ROAD_ADDED, type Building, type BuiltRoad } from './city';
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
  city: Pick<City, 'lots' | 'development'> & Partial<Pick<City, 'nodes'>>;
  built: ReadonlyMap<number, Building>;
  /** The roads builders added, live and taken away, as `CityState.roads` keeps them. */
  roads?: ReadonlyMap<number, BuiltRoad>;
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
  if (roadOver(ground, lot) !== null) return no(ROAD_HERE);
  if (!isEmpty(kind)) return no('There is already a building here.');
  return OK;
}

const ROAD_HERE = 'A road runs over this lot. Take the road away first.';

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

// ---------- roads ----------

/** The tiles strictly between two map tiles in one row or column, as `[x, z]`; none for tiles not in line. */
export function tilesBetween(from: readonly [number, number], to: readonly [number, number]): [number, number][] {
  const [ax, az] = from;
  const [bx, bz] = to;
  if (ax !== bx && az !== bz) return [];
  const dx = Math.sign(bx - ax);
  const dz = Math.sign(bz - az);
  const out: [number, number][] = [];
  for (let k = 1; k < Math.abs(bx - ax) + Math.abs(bz - az); k++) out.push([ax + dx * k, az + dz * k]);
  return out;
}

const tileIndex = new WeakMap<readonly unknown[], Map<number, number>>();
/** The lot on map tile `(x, z)`, or null for a road, the water or past the map. */
export function lotAtTile(city: Pick<City, 'lots'>, x: number, z: number): number | null {
  let index = tileIndex.get(city.lots);
  if (!index) {
    index = new Map(city.lots.map((l) => [l.z * 65536 + l.x, l.id]));
    tileIndex.set(city.lots, index);
  }
  return index.get(z * 65536 + x) ?? null;
}

const covering = new WeakMap<ReadonlyMap<number, BuiltRoad>, { size: string; by: Map<number, number> }>();
/** The live builder's road over each lot it covers, by lot. A road keeps its lots in the city's list underneath it. */
export function roadLots(ground: Ground): ReadonlyMap<number, number> {
  const { roads } = ground;
  const nodes = ground.city.nodes;
  if (!roads || !nodes || roads.size === 0) return new Map();
  // Keyed on the map's contents too: the state changes it in place.
  const size = [...roads].map(([id, r]) => `${id}:${r.change}`).join(',');
  const cached = covering.get(roads);
  if (cached?.size === size) return cached.by;
  const by = new Map<number, number>();
  for (const [segment, road] of roads) {
    const [a, b] = [nodes[road.a], nodes[road.b]];
    if (road.change !== ROAD_ADDED || !a || !b) continue;
    for (const [x, z] of tilesBetween(a, b)) {
      const lot = lotAtTile(ground.city, x, z);
      if (lot !== null) by.set(lot, segment);
    }
  }
  covering.set(roads, { size, by });
  return by;
}

/** The builder's road over `lot`, or null. */
export function roadOver(ground: Ground, lot: number): number | null {
  return roadLots(ground).get(lot) ?? null;
}

/** Why the land and roads refuse a road, by the code core's `Metro.roadCheck` gives, in the sim's own result codes. */
export function roadRefusal(code: number): string {
  switch (code) {
    case 2:
      return 'That crossing is not on the map.';
    case 22:
      return 'A road runs straight: pick two crossings in one row or column.';
    case 23:
      return 'A road can be at most 12 tiles long.';
    case 24:
      return 'A road already joins these two crossings.';
    case 25:
      return 'The ground between is not clear: another road, the water or the edge of the map is in the way, or a road runs beside it.';
    default:
      return refusal(code);
  }
}

/**
 * Whether a road may join nodes `a` and `b`. `code` is what core's `Metro.roadCheck` says of the land and the roads;
 * this adds the lots under it, which the page knows. The sim also refuses land residents use, which it finds by running
 * their days, so the page offers only the cleared ground and filler with no door, which nobody visits.
 */
export function canPlaceRoad(ground: Ground, a: number, b: number, code: number): Check {
  if (a === b) return no('Pick a different crossing for the other end.');
  if (code !== 0) return no(roadRefusal(code));
  const nodes = ground.city.nodes;
  const [from, to] = [nodes?.[a], nodes?.[b]];
  if (!from || !to) return no(roadRefusal(2));
  for (const [x, z] of tilesBetween(from, to)) {
    const lot = lotAtTile(ground.city, x, z);
    if (lot === null) return no(roadRefusal(23));
    const kind = kindOn(ground, lot);
    if (kind === null || !isEmpty(kind)) return no('A building is in the way.');
    const generated = ground.city.lots[lot]!;
    if (!isDevelopment(ground, lot) && generated.doorSegment !== null) {
      return no('People live, work or play along there. A road can only cross the cleared ground and empty plots.');
    }
  }
  return OK;
}

/** Whether the road `segment` may be taken away: only a road a builder added and that is still there. */
export function canRemoveRoad(ground: Ground, segment: number | null): Check {
  if (segment === null) return no(GENERATED_ROAD);
  if (ground.roads?.get(segment)?.change !== ROAD_ADDED) return no(GENERATED_ROAD);
  return OK;
}

const GENERATED_ROAD =
  'Only a road a builder laid can be taken away. The city’s own streets stay: homes and work are on them.';

/** What a refused command is told to the person as, by the result code of its `command` event. */
export function refusal(result: number, tool: 'build' | 'demolish' | 'road' | null = null): string {
  if (result === 25 && tool === 'build') return 'A road runs over that lot now.';
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
    case 10:
      return 'The city cannot afford that right now.';
    case 22:
      return 'A road has to run straight, along one row or column.';
    case 23:
      return 'That road is longer than 12 tiles.';
    case 24:
      return 'A road already joins those two crossings.';
    case 25:
      return 'Something is in the way: a road, the water or a building.';
    case 26:
      return 'Only a road a builder laid can be taken away, and only once.';
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
    const bytes = Uint8Array.from(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    const name = claims.name ?? claims.preferred_username;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : fallback;
  } catch {
    return fallback;
  }
}

const CMD_PLACE_ROAD = 1;
const CMD_BUILD = 3;
const CMD_DEMOLISH = 4;
const CMD_REMOVE_ROAD = 8;
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

/** A `place road` command record: a street between nodes `a` and `b`. */
export function placeRoadCommand(id: number, name: string, a: number, b: number): Uint8Array {
  return record(id, name, [CMD_PLACE_ROAD, ...u32(a), ...u32(b)]);
}

/** A `remove road` command record. */
export function removeRoadCommand(id: number, name: string, segment: number): Uint8Array {
  return record(id, name, [CMD_REMOVE_ROAD, ...u32(segment)]);
}

/** A random command id; two builders drawing the same one in the few seconds a command is waiting is a one in four billion. */
export function newId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
