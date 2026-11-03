import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCoast, outerTrees, waterGeometry } from './coast';
import { generate, initSync } from './core/felix_metro_core.js';
import { parseCity, type City } from './layout';

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
});

// One city on each edge of the map, and a dry one.
const SEEDS = ['lake', 'f', 'harbor', 'x', 'a'];
const city = (seed: string, districts = 2) => parseCity(generate(seed, districts));
const half = (c: City) => (c.tiles - 1) / 2;
const tileOf = (c: City, v: number) => Math.floor(v + half(c) + 0.5);

/** Whether the sim calls the tile under world point (x, z) water: its own tiles, or the sea past the shore's edge. */
function simWater(c: City, wet: Set<number>, x: number, z: number): boolean {
  const [i, j] = [tileOf(c, x), tileOf(c, z)];
  if (i >= 0 && j >= 0 && i < c.tiles && j < c.tiles) return wet.has(j * c.tiles + i);
  return [j < 0, i >= c.tiles, j >= c.tiles, i < 0][c.shore ?? 4] ?? false;
}

/** Distance in tiles from (x, z) to the nearest sim water tile, or `cap` if none is nearer. */
function distanceToWater(c: City, wet: Set<number>, x: number, z: number, cap: number): number {
  let best = cap;
  const reach = Math.ceil(cap) + 1;
  const [ci, cj] = [tileOf(c, x), tileOf(c, z)];
  for (let j = cj - reach; j <= cj + reach; j++) {
    for (let i = ci - reach; i <= ci + reach; i++) {
      const inside = i >= 0 && j >= 0 && i < c.tiles && j < c.tiles;
      const water = inside ? wet.has(j * c.tiles + i) : [j < 0, i >= c.tiles, j >= c.tiles, i < 0][c.shore ?? 4];
      if (!water) continue;
      const dx = Math.max(Math.abs(x - (i - half(c))) - 0.5, 0);
      const dz = Math.max(Math.abs(z - (j - half(c))) - 0.5, 0);
      best = Math.min(best, Math.hypot(dx, dz));
    }
  }
  return best;
}

describe('the coast', () => {
  it('is the same for the same city and different for another', () => {
    const a = buildCoast(city('harbor')),
      b = buildCoast(city('harbor')),
      other = buildCoast(city('f'));
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(other.data))).toBe(false);
  });

  it('draws water only on what the sim calls water, and most of it', () => {
    for (const seed of SEEDS) {
      const c = city(seed);
      const coast = buildCoast(c);
      const wet = new Set(c.water.map(([x, z]) => z * c.tiles + x));
      let drawn = 0,
        simmed = 0,
        overhang = 0;
      for (let z = -half(c) - 4; z <= half(c) + 4; z += 0.05) {
        for (let x = -half(c) - 4; x <= half(c) + 4; x += 0.05) {
          const sim = simWater(c, wet, x, z);
          if (sim) simmed++;
          if (coast.water(x, z)) {
            drawn++;
            // The coast's texture is sampled between texels, so a hair of edge can reach over a tile's border.
            expect(distanceToWater(c, wet, x, z, 1), `${seed}: water drawn on land at ${x}, ${z}`).toBeLessThan(0.05);
            if (!sim) overhang++;
          }
        }
      }
      expect(overhang / Math.max(drawn, 1)).toBeLessThan(0.001);
      if (c.shore === null) expect(drawn).toBe(0);
      else expect(drawn / simmed).toBeGreaterThan(0.6);
    }
  });

  it('leaves every land texel dry in the texture the shaders read', () => {
    for (const seed of SEEDS) {
      const c = city(seed);
      const coast = buildCoast(c);
      const wet = new Set(c.water.map(([x, z]) => z * c.tiles + x));
      const per = coast.size / coast.extent;
      for (let j = 0; j < coast.size; j++) {
        for (let i = 0; i < coast.size; i++) {
          const [x, z] = [coast.origin + (i + 0.5) / per, coast.origin + (j + 0.5) / per];
          if (!simWater(c, wet, x, z))
            expect(coast.data[(j * coast.size + i) * 4]!, `${seed} ${x}, ${z}`).toBeLessThan(128);
        }
      }
    }
  });

  it('is not squared off: the edge pulls back into the water by a different amount along the coast', () => {
    const c = city('harbor');
    const coast = buildCoast(c);
    const wet = new Set(c.water.map(([x, z]) => z * c.tiles + x));
    const retreats = new Set<number>();
    for (const [i, j] of c.water) {
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const [ni, nj] = [i + di, j + dj];
        if (ni < 0 || nj < 0 || ni >= c.tiles || nj >= c.tiles || wet.has(nj * c.tiles + ni)) continue;
        // From the middle of the shared edge into the water tile, to where the water is drawn.
        const [ex, ez] = [i - half(c) + di / 2, j - half(c) + dj / 2];
        let depth = 0;
        while (depth < 1 && !coast.water(ex - di * depth, ez - dj * depth)) depth += 0.02;
        // A tile the sim flooded on its own, away from the sea, is too small to draw and stays bare ground.
        if (depth >= 1) continue;
        retreats.add(Math.round(depth * 20));
        expect(depth, 'a strip of beach is always left').toBeGreaterThan(0.05);
      }
    }
    expect(retreats.size).toBeGreaterThan(3);
  });
});

describe('scatter', () => {
  it('keeps trees off the water and the beach, for several seeds', () => {
    for (const seed of SEEDS) {
      for (const districts of [2, 3]) {
        const c = city(seed, districts);
        const coast = buildCoast(c);
        const wet = new Set(c.water.map(([x, z]) => z * c.tiles + x));
        let dry = 0;
        // The page tries a tree wherever a lot's jitter or the landscape puts one, and `dry` is its only gate.
        for (let z = -half(c) - 10; z <= half(c) + 10; z += 0.13) {
          for (let x = -half(c) - 10; x <= half(c) + 10; x += 0.13) {
            if (!coast.dry(x, z)) continue;
            dry++;
            expect(simWater(c, wet, x, z), `${seed}: dry point ${x}, ${z} is a water tile`).toBe(false);
            expect(distanceToWater(c, wet, x, z, 1), `${seed}: dry point ${x}, ${z} is on the beach`).toBeGreaterThan(
              0.25,
            );
          }
        }
        expect(dry).toBeGreaterThan(300);
      }
    }
  });

  it('puts the trees past the map only on dry land, and some of them there', () => {
    for (const seed of SEEDS) {
      const c = city(seed);
      const coast = buildCoast(c);
      const wet = new Set(c.water.map(([x, z]) => z * c.tiles + x));
      let state = 7;
      const rand = () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646;
      const spots = outerTrees(c, coast, rand);
      expect(spots.length).toBeGreaterThan(20);
      for (const [x, z] of spots) {
        expect(simWater(c, wet, x, z)).toBe(false);
        expect(distanceToWater(c, wet, x, z, 1)).toBeGreaterThan(0.25);
      }
    }
  });
});

describe('the water mesh', () => {
  it('is a quad for each water tile, plus the sea on the shore side', () => {
    const c = city('harbor');
    const quads = waterGeometry(c, 60).getAttribute('position').count / 6;
    expect(quads).toBe(c.water.length + 1);
    const dry = city('a');
    expect(waterGeometry(dry, 60).getAttribute('position').count).toBe(0);
  });
});
