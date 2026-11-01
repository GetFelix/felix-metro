// The camera's maths, with no DOM or renderer in it. A view is a point on the ground the camera looks at, how far it
// stands from that point and the two angles it stands at. Everything the person does moves one of those five numbers.

/** Where the camera looks and from where. `azimuth` and `polar` are Three.js's spherical angles about the ground point. */
export interface View {
  x: number;
  z: number;
  distance: number;
  azimuth: number;
  polar: number;
}

/** The rectangle on the ground that the look-at point may not leave. */
export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Limits {
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
  bounds: Bounds;
}

/** The lens, for turning a spot on the screen into a ray. `fov` is the vertical field of view in degrees. */
export interface Lens {
  fov: number;
  aspect: number;
}

/** A spot on the screen in normalised device coordinates: -1 to 1, with +y up. */
export interface Ndc {
  x: number;
  y: number;
}

/** A city `tiles` across is centred on the origin, so it spans half its size either way. */
export function cityBounds(tiles: number): Bounds {
  const half = tiles / 2;
  return { minX: -half, maxX: half, minZ: -half, maxZ: half };
}

/** The closest point of `bounds` to (x, z). */
export function clampTarget(x: number, z: number, bounds: Bounds): { x: number; z: number } {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, x)),
    z: Math.min(bounds.maxZ, Math.max(bounds.minZ, z)),
  };
}

/** `v` with every number held inside the limits. A number that is not finite falls back to the nearest limit. */
export function clampView(v: View, limits: Limits): View {
  const fit = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
  return {
    ...clampTarget(Number.isFinite(v.x) ? v.x : 0, Number.isFinite(v.z) ? v.z : 0, limits.bounds),
    distance: fit(v.distance, limits.minDistance, limits.maxDistance),
    azimuth: Number.isFinite(v.azimuth) ? v.azimuth : 0,
    polar: fit(v.polar, limits.minPolar, limits.maxPolar),
  };
}

/** The view that stands at `offset` from (x, z) on the ground, so a camera position can be turned back into a view. */
export function viewFromOffset(x: number, z: number, offset: { x: number; y: number; z: number }): View {
  const distance = Math.hypot(offset.x, offset.y, offset.z);
  return {
    x,
    z,
    distance,
    azimuth: Math.atan2(offset.x, offset.z),
    polar: distance === 0 ? 0 : Math.acos(Math.min(1, Math.max(-1, offset.y / distance))),
  };
}

/** Where the camera stands, relative to the look-at point. */
export function offsetOf(v: View): { x: number; y: number; z: number } {
  const [sp, cp] = [Math.sin(v.polar), Math.cos(v.polar)];
  return { x: v.distance * sp * Math.sin(v.azimuth), y: v.distance * cp, z: v.distance * sp * Math.cos(v.azimuth) };
}

/** The ground-plane directions that read as forward and right on screen. */
export function groundAxes(azimuth: number) {
  const [s, c] = [Math.sin(azimuth), Math.cos(azimuth)];
  return { forward: { x: -s, z: -c }, right: { x: c, z: -s } };
}

/**
 * The ground point (x, z) under a spot on the screen, or null when the ray from there does not come down to the
 * ground. The tilt limit keeps the whole screen below the horizon, so null only guards a changed limit.
 */
export function groundPoint(v: View, at: Ndc, lens: Lens): { x: number; z: number } | null {
  const ray = rayAt(v, at, lens);
  if (ray.y >= -1e-6) return null;
  const up = offsetOf(v);
  const s = up.y / -ray.y;
  return { x: v.x + up.x + ray.x * s, z: v.z + up.z + ray.z * s };
}

/** The direction, in the world, of the ray through a spot on the screen. Not normalised. */
function rayAt(v: View, at: Ndc, lens: Lens): { x: number; y: number; z: number } {
  const half = Math.tan((lens.fov * Math.PI) / 360);
  const [cx, cy] = [at.x * half * lens.aspect, at.y * half];
  const o = offsetOf(v);
  const len = v.distance;
  // forward looks at the target; right is forward x world-up; up is right x forward.
  const f = { x: -o.x / len, y: -o.y / len, z: -o.z / len };
  const r = { x: Math.cos(v.azimuth), y: 0, z: -Math.sin(v.azimuth) };
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  return { x: r.x * cx + u.x * cy + f.x, y: r.y * cx + u.y * cy + f.y, z: r.z * cx + u.z * cy + f.z };
}

/**
 * Scale the distance by `factor` and slide the look-at point so the ground under `at` stays under it. With the cursor at
 * the centre this is a plain dolly. The point is held inside the bounds afterwards, so at the edge the ground under the
 * cursor can slip a little instead of letting the view leave the city.
 */
export function zoomToward(v: View, at: Ndc, factor: number, lens: Lens, limits: Limits): View {
  const distance = Math.min(limits.maxDistance, Math.max(limits.minDistance, v.distance * factor));
  const ground = groundPoint(v, at, lens);
  if (!ground || distance === v.distance) return clampView({ ...v, distance }, limits);
  // The camera stays on the line from the ground point back along its ray, at the height the new distance needs.
  const ray = rayAt(v, at, lens);
  const k = (distance * Math.cos(v.polar)) / -ray.y;
  const next = { ...v, distance };
  const o = offsetOf(next);
  next.x = ground.x - ray.x * k - o.x;
  next.z = ground.z - ray.z * k - o.z;
  return clampView(next, limits);
}

/** Drag the ground: move the look-at point so the ground that was under `from` is under `to`. */
export function panGrab(v: View, from: Ndc, to: Ndc, lens: Lens, limits: Limits): View {
  const [a, b] = [groundPoint(v, from, lens), groundPoint(v, to, lens)];
  if (!a || !b) return v;
  return clampView({ ...v, x: v.x + a.x - b.x, z: v.z + a.z - b.z }, limits);
}

/** Move the look-at point `forward` and `right` ground units along the way the camera faces. */
export function panBy(v: View, forward: number, right: number, limits: Limits): View {
  const axes = groundAxes(v.azimuth);
  return clampView(
    {
      ...v,
      x: v.x + axes.forward.x * forward + axes.right.x * right,
      z: v.z + axes.forward.z * forward + axes.right.z * right,
    },
    limits,
  );
}

/** Turn by `azimuth` and tilt by `polar` radians, the tilt held inside its limits. */
export function orbitBy(v: View, azimuth: number, polar: number, limits: Limits): View {
  return clampView({ ...v, azimuth: v.azimuth + azimuth, polar: v.polar + polar }, limits);
}

/** The same angle, turned the short way round to land within half a turn of `from`. */
export function nearestAngle(from: number, to: number): number {
  const turn = Math.PI * 2;
  return to - Math.round((to - from) / turn) * turn;
}

/** An angle in (-pi, pi]. */
export function wrapAngle(a: number): number {
  return nearestAngle(0, a);
}

/** One number chasing a goal on a critically damped spring: it arrives without overshooting. */
export interface Spring {
  value: number;
  velocity: number;
}

/** Advance `s` toward `goal` by `dt` seconds. `omega` is the stiffness; the move is about 96% done in 5 / omega s. */
export function stepSpring(s: Spring, goal: number, omega: number, dt: number): void {
  const x = s.value - goal;
  const t = s.velocity + omega * x;
  const e = Math.exp(-omega * dt);
  s.value = goal + (x + t * dt) * e;
  s.velocity = (s.velocity - omega * t * dt) * e;
}

/** A spring this close to its goal and this slow is there; snapping it keeps a settled camera from drawing again. */
export function settled(s: Spring, goal: number, tolerance: number): boolean {
  return Math.abs(s.value - goal) < tolerance && Math.abs(s.velocity) < tolerance;
}
