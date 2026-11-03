// The coast: where the drawn water meets the land, and the one test every piece of scatter asks.
//
// The sim knows water as whole tiles, and that stays the rule for lots and roads. The page draws a smoother edge by
// blurring the tile mask and cutting it at a level that wanders with a noise seeded from the city's seed. The cut is
// above the blur's value at a tile edge, so the drawn water only ever pulls back into water tiles and never covers a
// land one. What it uncovers is the beach. `dry` is the same field read the other way: a tree goes where it is
// clear of the beach, on land, and nowhere else.
import * as THREE from 'three';
import { roll, seedNumber } from './ambient';
import type { City } from './layout';

/** Tiles of map drawn past each edge, so the coast reads right out to where the camera can see. */
export const COAST_PADDING = 10;
/** The blurred mask is 0.5 at a tile edge. The water is drawn where it passes this, which pulls it back into the tile. */
const LEVEL = 0.72;
/** A channel or inlet a tile or two wide would blur away at that level, so the level drops by up to this much there. */
const THIN = 0.25;
/** How far the noise moves the level. */
const WANDER = 0.12;
/** Land clears the shore where the blurred mask is below this: about half a tile from the water's tile edge. */
const DRY_BELOW = 0.14;
/** The field the shaders read is 0.5 at the drawn edge and runs 1 per `1 / FIELD_SLOPE` of the mask. */
const FIELD_SLOPE = 2.5;
const FIELD_LAND_CAP = 0;

export interface Coast {
  /** Texels along a side of the map. */
  readonly size: number;
  /** World x and z of the map's north-west corner, and its width. */
  readonly origin: number;
  readonly extent: number;
  /**
   * RGBA, one texel per 1/`texelsPerTile` of a tile. R is the shore field (0.5 at the drawn edge, more in water),
   * G the blurred water mask (the beach reads it) and B how far out to sea, 0 to 1.
   */
  readonly data: Uint8Array;
  /** The drawn water covers world point (x, z). */
  water(x: number, z: number): boolean;
  /** A tree or other scatter may stand at world point (x, z): on land and clear of the beach. */
  dry(x: number, z: number): boolean;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Whether tile (x, z) of the city is water: the sim's tiles inside the map, and the sea past the shore's edge. */
function tileWater(city: City, wet: Set<number>) {
  const n = city.tiles;
  return (x: number, z: number): boolean => {
    if (x >= 0 && z >= 0 && x < n && z < n) return wet.has(z * n + x);
    switch (city.shore) {
      case 0:
        return z < 0;
      case 1:
        return x >= n;
      case 2:
        return z >= n;
      case 3:
        return x < 0;
      default:
        return false;
    }
  };
}

/** A box blur of `radius` texels along rows and then down columns, twice over, with the edge held. */
function blur(src: Float32Array, size: number, radius: number): Float32Array {
  const pass = (from: Float32Array, to: Float32Array, stride: number, step: number) => {
    const width = 2 * radius + 1;
    for (let line = 0; line < size; line++) {
      const base = line * stride;
      const at = (i: number) => from[base + Math.min(size - 1, Math.max(0, i)) * step]!;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += at(i);
      for (let i = 0; i < size; i++) {
        to[base + i * step] = sum / width;
        sum += at(i + radius + 1) - at(i - radius);
      }
    }
  };
  const a = new Float32Array(src.length);
  const b = new Float32Array(src.length);
  pass(src, a, size, 1);
  pass(a, b, 1, size);
  pass(b, a, size, 1);
  pass(a, b, 1, size);
  return b;
}

/** Smooth value noise in [0, 1) at world point (x, z), for features `scale` tiles across. */
function noise(seed: number, salt: number, x: number, z: number, scale: number): number {
  const fx = x / scale,
    fz = z / scale;
  const ix = Math.floor(fx),
    iz = Math.floor(fz);
  const tx = smooth(fx - ix),
    tz = smooth(fz - iz);
  const corner = (dx: number, dz: number) => roll(seed ^ salt, ix + dx, iz + dz);
  const top = corner(0, 0) * (1 - tx) + corner(1, 0) * tx;
  const bottom = corner(0, 1) * (1 - tx) + corner(1, 1) * tx;
  return top * (1 - tz) + bottom * tz;
}

/** The coast of `city`. The same city always gives the same bytes. */
export function buildCoast(city: City): Coast {
  const tiles = city.tiles;
  const half = (tiles - 1) / 2;
  const across = tiles + 2 * COAST_PADDING;
  // A 16 district city would be too many texels at full detail.
  const per = Math.max(4, Math.min(8, Math.floor(1536 / across)));
  const size = across * per;
  const origin = -half - 0.5 - COAST_PADDING;
  const wet = new Set(city.water.map(([x, z]) => z * tiles + x));
  const isWater = tileWater(city, wet);
  const seed = seedNumber(`${city.seed}/coast`);

  const tileOf = (texel: number) => Math.floor(texel / per) - COAST_PADDING;
  const mask = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) mask[j * size + i] = isWater(tileOf(i), tileOf(j)) ? 1 : 0;

  const near = blur(mask, size, Math.round(per * 0.6));
  const far = blur(mask, size, Math.round(per * 1.5));
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const x = origin + (i + 0.5) / per,
        z = origin + (j + 0.5) / per;
      const wander = (noise(seed, 1, x, z, 3.1) * 0.65 + noise(seed, 2, x, z, 1.3) * 0.35 - 0.5) * 2 * WANDER;
      const open = smooth(Math.min(1, Math.max(0, (far[k]! - 0.15) / 0.3)));
      let f = 0.5 + (near[k]! + wander - (LEVEL - THIN * (1 - open))) * FIELD_SLOPE;
      // Land stays land whatever the noise says.
      if (!isWater(tileOf(i), tileOf(j))) f = Math.min(f, FIELD_LAND_CAP);
      field[k] = f;
      data[k * 4] = byte(f);
      data[k * 4 + 1] = byte(near[k]!);
      data[k * 4 + 2] = byte(far[k]!);
      data[k * 4 + 3] = 255;
    }
  }

  // Bilinear, like the texture the shaders sample: texel centres are at (i + 0.5) / per from the origin.
  const sample = (source: ArrayLike<number>, x: number, z: number): number => {
    const u = Math.min(size - 1.001, Math.max(0, (x - origin) * per - 0.5));
    const v = Math.min(size - 1.001, Math.max(0, (z - origin) * per - 0.5));
    const i = Math.floor(u),
      j = Math.floor(v);
    const tu = u - i,
      tv = v - j;
    const at = (a: number, b: number) => source[(j + b) * size + i + a]!;
    return (at(0, 0) * (1 - tu) + at(1, 0) * tu) * (1 - tv) + (at(0, 1) * (1 - tu) + at(1, 1) * tu) * tv;
  };

  return {
    size,
    origin,
    extent: across,
    data,
    water: (x, z) => sample(field, x, z) > 0.5,
    dry: (x, z) => sample(near, x, z) < DRY_BELOW,
  };
}

/**
 * The water's mesh: a quad for each water tile and the open sea past the shore's edge, one draw call in all. The
 * shaders cut the coast out of it from the coast texture, so it only has to cover where water can be.
 */
export function waterGeometry(city: City, reach: number): THREE.BufferGeometry {
  const half = (city.tiles - 1) / 2;
  const y = 0.005;
  const positions: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number) => {
    positions.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
  };
  for (const [x, z] of city.water) quad(x - half - 0.5, z - half - 0.5, x - half + 0.5, z - half + 0.5);
  if (city.shore !== null) {
    const edge = half + 0.5;
    const w = reach / 2;
    if (city.shore === 0) quad(-w, -edge - reach, w, -edge);
    if (city.shore === 1) quad(edge, -w, edge + reach, w);
    if (city.shore === 2) quad(-w, edge, w, edge + reach);
    if (city.shore === 3) quad(-edge - reach, -w, -edge, w);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Where the trees past the map stand: along the three dry sides, and not on the sea that runs past the shore's edge. */
export function outerTrees(city: City, coast: Coast, rand: () => number): [number, number][] {
  const half = (city.tiles - 1) / 2;
  const spots: [number, number][] = [];
  for (let i = 0; i < 140; i++) {
    const out = half + 1.5 + rand() * 8;
    const along = (rand() * 2 - 1) * (half + 6);
    const [x, z] = [
      [along, -out],
      [out, along],
      [along, out],
      [-out, along],
    ][Math.floor(rand() * 4)]!;
    if (coast.dry(x!, z!)) spots.push([x!, z!]);
  }
  return spots;
}
