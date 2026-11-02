import { describe, expect, it } from 'vitest';
import { LotGrid, groundPoint, lotsAlong } from './lot-pick';

// A 5 by 5 map, tile (x, z) at world (x - 2, z - 2). Lots stand on the odd rows and columns, roads on the rest.
const lots = [
  { id: 10, x: 1, z: 1 },
  { id: 11, x: 3, z: 1 },
  { id: 12, x: 1, z: 3 },
  { id: 13, x: 3, z: 3 },
];
const grid = new LotGrid(5, lots);

describe('LotGrid', () => {
  it('finds the lot whose tile holds a point', () => {
    expect(grid.lotAt(-1, -1)).toBe(10);
    expect(grid.lotAt(1.4, -0.6)).toBe(11);
    expect(grid.lotAt(-1.49, 1.49)).toBe(12);
    expect(grid.lotAt(1, 1)).toBe(13);
  });

  it('finds none on a road or past the map', () => {
    expect(grid.lotAt(0, 0)).toBeNull();
    expect(grid.lotAt(-2, -1)).toBeNull();
    expect(grid.lotAt(-3.2, -1)).toBeNull();
    expect(grid.lotAt(1, 2.6)).toBeNull();
  });
});

describe('groundPoint', () => {
  it('meets the ground below a ray that points down', () => {
    const p = groundPoint({ origin: { x: 0, y: 4, z: 0 }, direction: { x: 0.5, y: -1, z: 0.25 } });
    expect(p).toEqual({ x: 2, z: 1 });
  });

  it('meets nothing when the ray is level or points up', () => {
    expect(groundPoint({ origin: { x: 0, y: 4, z: 0 }, direction: { x: 1, y: 0, z: 0 } })).toBeNull();
    expect(groundPoint({ origin: { x: 0, y: 4, z: 0 }, direction: { x: 1, y: 1, z: 0 } })).toBeNull();
  });
});

describe('lotsAlong', () => {
  it('names the lots under a slanted ray, the nearest first', () => {
    // From the west at roof height down to the ground two tiles east: over lot 10, then ends over lot 11's tile.
    const ray = { origin: { x: -4, y: 4, z: -1 }, direction: { x: 1, y: -0.5, z: 0 } };
    expect(groundPoint(ray)).toEqual({ x: 4, z: -1 });
    expect(lotsAlong(ray, grid, 4)).toEqual([10, 11]);
  });

  it('finds a lot a building hides the ground of', () => {
    // Looking down at a slant, the ground the pointer meets is behind lot 10, but at roof height the ray is over it.
    const ray = { origin: { x: -1, y: 6, z: -5 }, direction: { x: 0, y: -1, z: 1 } };
    expect(groundPoint(ray)).toEqual({ x: -1, z: 1 });
    expect(grid.lotAt(-1, 1)).toBe(12);
    expect(lotsAlong(ray, grid, 3)).toEqual([10, 12]);
  });

  it('finds none for a ray that points level or up, or never comes within the ceiling', () => {
    expect(lotsAlong({ origin: { x: 0, y: 4, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, grid, 4)).toEqual([]);
    expect(lotsAlong({ origin: { x: 0, y: 4, z: 0 }, direction: { x: 1, y: 1, z: 0 } }, grid, 4)).toEqual([]);
  });

  it('does not step over a lot on a shallow ray', () => {
    const ray = { origin: { x: -2.4, y: 1, z: -1 }, direction: { x: 1, y: -0.02, z: 0 } };
    expect(lotsAlong(ray, grid, 1)).toEqual([10, 11]);
  });
});
