import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIRST_KIND,
  TREE_FIRST,
  buildCommand,
  canBuild,
  canDemolish,
  canPlaceRoad,
  canRemoveRoad,
  clipName,
  demolishCommand,
  families,
  isEmpty,
  kindLabel,
  kindOn,
  nameFrom,
  nextKind,
  placeRoadCommand,
  refusal,
  removeRoadCommand,
  roadOver,
  tilesBetween,
  type Ground,
} from './build';
import { NO_BUILDING, ROAD_ADDED, ROAD_REMOVED, type BuiltRoad } from './city';
import { decodeRecord, initSync } from './core/felix_metro_core.js';
import { KINDS } from './kinds';

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
});

// Lot 0 is a house outside the development area, 1 and 2 are bare ground in it, 3 is a park in it with trees.
const ground = (built: [number, number][] = []): Ground => ({
  city: {
    development: [1, 2, 3],
    lots: [19, NO_BUILDING, NO_BUILDING, TREE_FIRST].map((kind, id) => ({ id, kind })) as never,
  },
  built: new Map(built.map(([lot, kind]) => [lot, { kind, rotation: 0 }])),
});

describe('the rules the sim keeps', () => {
  it('lets bare ground in the development area take a building', () => {
    expect(canBuild(ground(), 1)).toEqual({ ok: true });
  });

  it('counts trees and plaza props as bare, as the sim does', () => {
    expect(canBuild(ground(), 3)).toEqual({ ok: true });
    expect(isEmpty(TREE_FIRST)).toBe(true);
    expect(isEmpty(TREE_FIRST - 1)).toBe(false);
  });

  it('refuses a lot that already has a building, and a lot outside the development area', () => {
    expect(canBuild(ground([[1, 19]]), 1)).toMatchObject({ ok: false, why: 'There is already a building here.' });
    expect(canBuild(ground(), 0)).toMatchObject({ ok: false, why: 'Only the cleared ground can be built on.' });
  });

  it('refuses a lot that is not on the map', () => {
    expect(canBuild(ground(), 9)).toMatchObject({ ok: false });
    expect(canDemolish(ground(), 9)).toMatchObject({ ok: false });
  });

  it('takes down a builder’s building and nothing else', () => {
    expect(canDemolish(ground([[1, 19]]), 1)).toEqual({ ok: true });
    expect(canDemolish(ground(), 2)).toMatchObject({ ok: false, why: 'There is nothing here to take down.' });
    expect(canDemolish(ground(), 0)).toMatchObject({ ok: false });
  });

  it('reads a builder’s demolition as bare ground again', () => {
    const g = ground([[1, 19]]);
    g.built = new Map([[1, { kind: NO_BUILDING, rotation: 0 }]]);
    expect(kindOn(g, 1)).toBe(NO_BUILDING);
    expect(canBuild(g, 1)).toEqual({ ok: true });
  });

  it('knows the same tree boundary as core', () => {
    const rust = readFileSync(new URL('../../core/src/kinds.rs', import.meta.url), 'utf8');
    expect(Number(/TREE_FIRST: u8 = (\d+)/.exec(rust)![1])).toBe(TREE_FIRST);
  });
});

/**
 * A row of four lots between node 0 at (0, 0) and node 1 at (5, 0): lots 0, 1 and 3 are cleared ground, lot 2 filler
 * with trees and no door. Node 2 at (0, 3) is in node 0's column. Lot 4, beside node 2, is a home.
 */
const strip = (
  over: { door?: number | null; built?: [number, number][]; roads?: [number, BuiltRoad][] } = {},
): Ground => ({
  city: {
    development: [0, 1, 3],
    nodes: [
      [0, 0],
      [5, 0],
      [0, 3],
    ],
    lots: [
      { id: 0, x: 1, z: 0, kind: NO_BUILDING, doorSegment: 0 },
      { id: 1, x: 2, z: 0, kind: NO_BUILDING, doorSegment: 0 },
      { id: 2, x: 3, z: 0, kind: TREE_FIRST, doorSegment: over.door === undefined ? null : over.door },
      { id: 3, x: 4, z: 0, kind: TREE_FIRST + 1, doorSegment: 0 },
      { id: 4, x: 0, z: 1, kind: 19, doorSegment: 0 },
    ] as never,
  },
  built: new Map((over.built ?? []).map(([lot, kind]) => [lot, { kind, rotation: 0 }])),
  roads: new Map(over.roads ?? []),
});

describe('roads', () => {
  it('finds the tiles strictly between two crossings in one row or column', () => {
    expect(tilesBetween([0, 0], [3, 0])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(tilesBetween([0, 3], [0, 1])).toEqual([[0, 2]]);
    expect(tilesBetween([0, 0], [2, 2])).toEqual([]);
  });

  it('lays a road over cleared ground and filler nobody visits', () => {
    expect(canPlaceRoad(strip(), 0, 1, 0)).toEqual({ ok: true });
  });

  it('says why core turned the land down, in words', () => {
    expect(canPlaceRoad(strip(), 0, 1, 22)).toMatchObject({ ok: false, why: expect.stringMatching(/straight/) });
    expect(canPlaceRoad(strip(), 0, 1, 23)).toMatchObject({ why: expect.stringMatching(/12 tiles/) });
    expect(canPlaceRoad(strip(), 0, 1, 24)).toMatchObject({ why: expect.stringMatching(/already joins/) });
    expect(canPlaceRoad(strip(), 0, 1, 25)).toMatchObject({ why: expect.stringMatching(/not clear/) });
    expect(canPlaceRoad(strip(), 0, 0, 22)).toMatchObject({ why: expect.stringMatching(/different crossing/) });
  });

  it('refuses ground with a building on it, or that residents may use', () => {
    expect(canPlaceRoad(strip({ built: [[1, 19]] }), 0, 1, 0)).toMatchObject({
      ok: false,
      why: 'A building is in the way.',
    });
    // Lot 2 has a door and is not cleared ground: the page cannot tell if anyone goes there, so it says no.
    expect(canPlaceRoad(strip({ door: 7 }), 0, 1, 0)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/People live, work or play/),
    });
  });

  it('knows which lots a builder’s road runs over, and keeps a building off them', () => {
    const laid = strip({ roads: [[104, { change: ROAD_ADDED, a: 0, b: 1 }]] });
    expect([0, 1, 2, 3, 4].map((lot) => roadOver(laid, lot))).toEqual([104, 104, 104, 104, null]);
    expect(canBuild(laid, 1)).toMatchObject({ ok: false, why: expect.stringMatching(/road runs over/) });
    const gone = strip({ roads: [[104, { change: ROAD_REMOVED, a: 0, b: 1 }]] });
    expect(roadOver(gone, 1)).toBeNull();
    expect(canBuild(gone, 1)).toEqual({ ok: true });
  });

  it('notices a road laid in the same map, which the state changes in place', () => {
    const g = strip();
    expect(roadOver(g, 1)).toBeNull();
    (g.roads as Map<number, BuiltRoad>).set(104, { change: ROAD_ADDED, a: 0, b: 1 });
    expect(roadOver(g, 1)).toBe(104);
  });

  it('takes away only a road a builder laid and that is still there', () => {
    const g = strip({
      roads: [
        [104, { change: ROAD_ADDED, a: 0, b: 1 }],
        [105, { change: ROAD_REMOVED, a: 0, b: 2 }],
      ],
    });
    expect(canRemoveRoad(g, 104)).toEqual({ ok: true });
    expect(canRemoveRoad(g, 105)).toMatchObject({ ok: false, why: expect.stringMatching(/city’s own streets stay/) });
    expect(canRemoveRoad(g, 3)).toMatchObject({ ok: false });
    expect(canRemoveRoad(g, null)).toMatchObject({ ok: false });
  });
});

describe('what a refusal says', () => {
  it('has plain words for every result the sim records', () => {
    const codes = [1, 2, 3, 4, 5, 7, 8, 9, 10, 22, 23, 24, 25, 26];
    for (const code of [...codes, 99]) expect(refusal(code)).toMatch(/^[A-Z].*\.$/);
    expect(new Set(codes.map((code) => refusal(code))).size).toBe(codes.length);
    expect(refusal(25, 'build')).toMatch(/road runs over/);
  });

  it('knows the result codes core records', () => {
    const rust = readFileSync(new URL('../../core/src/record.rs', import.meta.url), 'utf8');
    const code = (name: string) => Number(new RegExp(`${name}: u8 = (\\d+)`).exec(rust)![1]);
    expect(refusal(code('REFUSED_NO_FUNDS'))).toMatch(/afford/);
    expect(refusal(code('REFUSED_NOT_STRAIGHT'))).toMatch(/straight/);
    expect(refusal(code('REFUSED_TOO_LONG'))).toMatch(/12 tiles/);
    expect(refusal(code('REFUSED_ROAD_EXISTS'))).toMatch(/already joins/);
    expect(refusal(code('REFUSED_ROAD_BLOCKED'))).toMatch(/in the way/);
    expect(refusal(code('REFUSED_NOT_BUILT'))).toMatch(/builder laid/);
  });
});

describe('the buildings on offer', () => {
  it('lists every building kind once and no tree', () => {
    const kinds = families().flatMap((f) => f.choices.map((c) => c.kind));
    expect(kinds).toEqual(Array.from({ length: TREE_FIRST }, (_, i) => i));
  });

  it('names them in words a person would use', () => {
    expect(kindLabel(0)).toBe('Commercial A');
    expect(kindLabel(14)).toBe('Skyscraper A');
    expect(kindLabel(19)).toBe('House A');
    expect(kindLabel(29)).toBe('Factory A');
    expect(kindLabel(35)).toBe('Water tower');
    expect(kindLabel(36)).toBe('Chimney');
    expect(kindLabel(37)).toBe('Storage tank');
    const labels = families().flatMap((f) => f.choices.map((c) => c.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('starts on a house', () => {
    expect(KINDS[FIRST_KIND]!.pack).toBe('suburban');
  });

  it('steps round the list in both directions', () => {
    expect(nextKind(0, -1)).toBe(TREE_FIRST - 1);
    expect(nextKind(TREE_FIRST - 1, 1)).toBe(0);
    expect(nextKind(5, 1)).toBe(6);
  });
});

describe('the command records', () => {
  it('build decodes in core as the command that was meant', () => {
    const json = JSON.parse(decodeRecord(buildCommand(0xdeadbeef, 'Ana', 4_000_000_000, 1000 + 7, 3)));
    expect(json).toEqual({
      kind: 'command',
      id: 0xdeadbeef,
      name: 'Ana',
      command: { type: 'build', lot: 4_000_000_000, kind: 1007, rotation: 3 },
    });
  });

  it('demolish decodes in core as the command that was meant', () => {
    const json = JSON.parse(decodeRecord(demolishCommand(7, 'Zoë', 42)));
    expect(json).toMatchObject({ kind: 'command', id: 7, name: 'Zoë', command: { type: 'demolish', lot: 42 } });
  });

  it('place road and remove road decode in core as the commands that were meant', () => {
    expect(JSON.parse(decodeRecord(placeRoadCommand(9, 'Ana', 6, 7)))).toMatchObject({
      kind: 'command',
      id: 9,
      command: { type: 'placeRoad', a: 6, b: 7 },
    });
    expect(JSON.parse(decodeRecord(removeRoadCommand(10, 'Ana', 300)))).toMatchObject({
      kind: 'command',
      id: 10,
      command: { type: 'removeRoad', segment: 300 },
    });
  });

  it('writes the bytes core pins for the road commands', () => {
    // core/src/record/tests.rs: remove road is tag 8 and the segment, little-endian.
    expect([...removeRoadCommand(1, 'A', 300).slice(-5)]).toEqual([8, 44, 1, 0, 0]);
    expect([...placeRoadCommand(1, 'A', 6, 0x01020304).slice(-9)]).toEqual([1, 6, 0, 0, 0, 4, 3, 2, 1]);
  });

  it('cuts a long name to 64 bytes without splitting a character', () => {
    const name = 'é'.repeat(40);
    expect(clipName(name).length).toBe(64);
    expect(new TextDecoder().decode(clipName(name))).toBe('é'.repeat(32));
    const json = JSON.parse(decodeRecord(buildCommand(1, name, 0, 0, 0)));
    expect(json.name).toBe('é'.repeat(32));
  });
});

describe('nameFrom', () => {
  /** A token's claims as base64url of their UTF-8 bytes, as an identity provider writes them. */
  const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  it('reads the name claim', () => {
    expect(nameFrom(token({ name: ' Ana ', sub: 'a' }))).toBe('Ana');
  });
  it('reads a name with accents as written', () => {
    expect(nameFrom(token({ name: 'José Müller' }))).toBe('José Müller');
  });
  it('falls back to the preferred username, then to a plain word', () => {
    expect(nameFrom(token({ preferred_username: 'ana' }))).toBe('ana');
    expect(nameFrom(token({ sub: 'a' }))).toBe('Builder');
    expect(nameFrom('not a token')).toBe('Builder');
  });
});
