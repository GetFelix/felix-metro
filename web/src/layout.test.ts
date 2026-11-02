import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { generate, initSync } from './core/felix_metro_core.js';
import { ROAD_COLUMNS, parseCity, roadModel, seedFromHash } from './layout';

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
});

describe('the generated city', () => {
  it('reads rows by column name', () => {
    const city = parseCity(generate('harbor', 2));
    expect(city.seed).toBe('harbor');
    expect(city.tiles).toBe(25);
    expect(city.lots[city.tower]).toMatchObject({ id: city.tower, kind: 18 });
    expect(city.roads.length).toBeGreaterThan(100);
    expect(city.roads.every((r) => r.piece >= 0 && r.piece <= 4 && r.rot >= 0 && r.rot <= 3)).toBe(true);
  });

  it('reads the road graph, and which lots have no door', () => {
    const city = parseCity(generate('harbor', 2));
    expect(city.nodes).toHaveLength(84);
    expect(city.nodes[6]).toEqual([16, 0]);
    expect(city.segments).toHaveLength(104);
    expect(city.segments[0]).toMatchObject({ id: 0, built: false, removed: false });
    expect(city.segments.every((g) => city.nodes[g.a] && city.nodes[g.b])).toBe(true);
    expect(city.lots[10]!.doorSegment).toBe(6);
    expect(city.lots.some((l) => l.doorSegment === null)).toBe(true);
    expect(city.lots.some((l) => l.doorSegment !== null)).toBe(true);
  });

  it('knows the road columns core writes, which roadsJson rows come in', () => {
    expect(JSON.parse(generate('harbor', 2)).roadColumns).toEqual([...ROAD_COLUMNS]);
  });

  it('takes the seed from the hash', () => {
    expect(seedFromHash('#pinecrest')).toBe('pinecrest');
    expect(seedFromHash('#a~b')).toBe('a~b');
    expect(seedFromHash('')).toBe('harbor');
    expect(seedFromHash('#Not Valid')).toBe('harbor');
  });

  it('turns the corner and end models onto the piece bases', () => {
    expect(roadModel(0, 1, false)).toEqual({ name: 'road-straight', turns: 1 });
    expect(roadModel(1, 0, false)).toEqual({ name: 'road-bend', turns: -1 });
    expect(roadModel(1, 0, true).name).toBe('road-bend-square');
    expect(roadModel(4, 0, false)).toEqual({ name: 'road-end', turns: 1 });
  });
});
