// Which lot is under the pointer. Lots are tall, so the ground point under the pointer is behind the building the
// pointer is on. Instead the ray is followed from the height of the tallest building down to the ground, and the lots
// near that stretch are the only ones worth testing against their meshes.

interface Point {
  x: number;
  y: number;
  z: number;
}

/** The ray the pointer makes through the camera. */
export interface Ray {
  origin: Point;
  direction: Point;
}

/** A lot's centre on the ground, in world units. */
export interface LotCentre {
  id: number;
  x: number;
  z: number;
}

/**
 * The ids of the lots whose centre is within `reach` of the part of `ray` between `ceiling` and the ground, seen from
 * above, nearest the camera first. A ray that does not point down reaches none.
 */
export function lotsAlong(ray: Ray, lots: readonly LotCentre[], reach: number, ceiling: number): number[] {
  const { origin: o, direction: d } = ray;
  if (d.y >= 0) return [];
  const down = (y: number) => Math.max(0, (y - o.y) / d.y);
  const from = down(ceiling);
  const to = down(0);
  const ax = o.x + d.x * from;
  const az = o.z + d.z * from;
  const dx = o.x + d.x * to - ax;
  const dz = o.z + d.z * to - az;
  const length2 = dx * dx + dz * dz;
  const near: { id: number; s: number }[] = [];
  for (const lot of lots) {
    const s = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((lot.x - ax) * dx + (lot.z - az) * dz) / length2));
    const ex = lot.x - (ax + dx * s);
    const ez = lot.z - (az + dz * s);
    if (ex * ex + ez * ez <= reach * reach) near.push({ id: lot.id, s });
  }
  return near.sort((a, b) => a.s - b.s).map((n) => n.id);
}
