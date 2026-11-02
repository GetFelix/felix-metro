import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIRST_KIND,
  TREE_FIRST,
  buildCommand,
  canBuild,
  canDemolish,
  clipName,
  demolishCommand,
  families,
  isEmpty,
  kindLabel,
  kindOn,
  nameFrom,
  nextKind,
  refusal,
  type Ground,
} from './build';
import { NO_BUILDING } from './city';
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

describe('what a refusal says', () => {
  it('has plain words for every result the sim records', () => {
    for (const code of [1, 2, 3, 4, 5, 7, 8, 9, 99]) expect(refusal(code)).toMatch(/^[A-Z].*\.$/);
    expect(new Set([1, 2, 3, 4, 5, 7, 8, 9].map(refusal)).size).toBe(8);
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
