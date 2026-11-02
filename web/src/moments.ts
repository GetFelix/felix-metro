// A moment is a tick and the view of it, carried in a link: `/?at=<tick>&cam=<x,z,distance,azimuth,polar>#harbor`.
import type { View } from './camera-math';

/** The page parameters that say which city a link opens, as opposed to how this visit is tuned. */
const KEPT = ['districts', 'layout', 'gateway'] as const;

/** A camera view as `x,z,distance,azimuth,polar`, or null when `value` is not five finite numbers. */
export function parseCamera(value: string | null): View | null {
  if (!value) return null;
  const parts = value.split(',');
  if (parts.length !== 5) return null;
  const [x, z, distance, azimuth, polar] = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
  const view = { x, z, distance, azimuth, polar } as View;
  return Object.values(view).every(Number.isFinite) ? view : null;
}

export function formatCamera(v: View): string {
  return [v.x, v.z, v.distance, v.azimuth, v.polar].join(',');
}

/** The link to `tick` seen from `view`, on the page `href` is. It keeps the city (hash, districts, layout, gateway) and drops the rest of the visit. */
export function momentLink(href: string, tick: number, view: View): string {
  const from = new URL(href);
  const link = new URL(from.origin + from.pathname);
  for (const name of KEPT) {
    const value = from.searchParams.get(name);
    if (value !== null) link.searchParams.set(name, value);
  }
  link.searchParams.set('at', String(Math.floor(tick)));
  // Appended by hand: URLSearchParams would write the commas as %2C.
  link.search += `${link.search ? '&' : '?'}cam=${formatCamera(view)}`;
  link.hash = from.hash;
  return link.toString();
}
