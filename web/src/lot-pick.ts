// Which lot a pointer is on. The ground under the pointer is the lot for flat ground; a building hides the ground
// behind it, so the lots along the ray down from rooftop height are candidates for the page to test against their
// meshes. Maths only: placement-view.ts does the testing.

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** The ray the pointer makes through the camera. */
export interface Ray {
  origin: Point;
  direction: Point;
}

/** The lot grid of a city: a lot's tile is its map column and row, and tile (x, z) sits at world (x - half, z - half). */
export class LotGrid {
  private readonly at = new Map<number, number>();
  readonly half: number;

  constructor(
    readonly tiles: number,
    lots: readonly { id: number; x: number; z: number }[],
  ) {
    this.half = (tiles - 1) / 2;
    for (const lot of lots) this.at.set(lot.z * tiles + lot.x, lot.id);
  }

  /** The lot whose tile holds the world point, or null for a road, the water or past the map. */
  lotAt(x: number, z: number): number | null {
    const column = Math.round(x + this.half);
    const row = Math.round(z + this.half);
    if (column < 0 || row < 0 || column >= this.tiles || row >= this.tiles) return null;
    return this.at.get(row * this.tiles + column) ?? null;
  }
}

/** Where the ray meets the ground, or null when it points level or up. */
export function groundPoint(ray: Ray): { x: number; z: number } | null {
  const { origin: o, direction: d } = ray;
  if (d.y >= 0) return null;
  const t = -o.y / d.y;
  return { x: o.x + d.x * t, z: o.z + d.z * t };
}

/** Spacing of the samples along the ray, in tiles: closer than a tile, so none is stepped over. */
const STEP = 0.35;

/**
 * The lots the ray passes over between `ceiling` and the ground, nearest the camera first. A building is no taller than
 * the ceiling, so one the ray hits is among them.
 */
export function lotsAlong(ray: Ray, grid: LotGrid, ceiling: number): number[] {
  const { origin: o, direction: d } = ray;
  if (d.y >= 0) return [];
  const top = Math.max(0, (o.y - ceiling) / -d.y);
  const bottom = -o.y / d.y;
  if (bottom <= top) return [];
  const flat = Math.hypot(d.x, d.z) * (bottom - top);
  const steps = Math.min(400, Math.max(1, Math.ceil(flat / STEP)));
  const seen: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = top + ((bottom - top) * i) / steps;
    const lot = grid.lotAt(o.x + d.x * t, o.z + d.z * t);
    if (lot !== null && !seen.includes(lot)) seen.push(lot);
  }
  return seen;
}
