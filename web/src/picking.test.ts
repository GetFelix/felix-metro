import { describe, expect, it } from 'vitest';
import { lotsAlong, type LotCentre } from './picking';

// A row of lots along x at z = 0, one unit apart.
const row: LotCentre[] = Array.from({ length: 10 }, (_, i) => ({ id: i, x: i, z: 0 }));

describe('lotsAlong', () => {
  it('finds the lot under a ray that comes straight down', () => {
    const ray = { origin: { x: 4, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } };
    expect(lotsAlong(ray, row, 0.6, 6)).toEqual([4]);
  });

  it('finds the lots between the roof and the ground, nearest the camera first', () => {
    // From the west at 45 degrees: at the ceiling (y = 4) the ray is over x = 2, at the ground over x = 6.
    const ray = { origin: { x: -4, y: 10, z: 0 }, direction: { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 } };
    expect(lotsAlong(ray, row, 0.6, 4)).toEqual([2, 3, 4, 5, 6]);
  });

  it('leaves out lots to the side of the ray', () => {
    const ray = { origin: { x: 4, y: 10, z: 3 }, direction: { x: 0, y: -1, z: 0 } };
    expect(lotsAlong(ray, row, 0.6, 6)).toEqual([]);
  });

  it('reaches nothing with a ray that points level or up', () => {
    expect(lotsAlong({ origin: { x: 4, y: 1, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, row, 5, 6)).toEqual([]);
    expect(lotsAlong({ origin: { x: 4, y: 1, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, row, 5, 6)).toEqual([]);
  });

  it('starts at the camera when it is below the ceiling', () => {
    const ray = { origin: { x: 0, y: 2, z: 0 }, direction: { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 } };
    expect(lotsAlong(ray, row, 0.6, 6)).toEqual([0, 1, 2]);
  });
});
