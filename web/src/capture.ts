// Frame-by-frame rendering for the clip job (?capture&trace). The script owns the clock: it asks for one frame at a time
// at a video time, and the camera and the city's tick follow tracks keyed by that time, so the clip does not depend on
// how fast the machine draws.

/** A value at a time in milliseconds. */
export interface Key {
  t: number;
  v: number[];
}

/**
 * The track's value at `t`: a cubic through the keys that moves smoothly past each one and eases to a stop at the first
 * and the last, so a path of a few keys reads as a camera move rather than a series of stops.
 */
export function sample(keys: readonly Key[], t: number): number[] {
  if (keys.length === 0) return [];
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) return [...first.v];
  if (t >= last.t) return [...last.v];
  let i = 0;
  while (keys[i + 1]!.t < t) i++;
  const [a, b] = [keys[i]!, keys[i + 1]!];
  const h = b.t - a.t;
  const s = (t - a.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return a.v.map((_, k) => {
    const ma = i === 0 ? 0 : tangent(keys[i - 1]!, a, b, k);
    const mb = i + 2 >= keys.length ? 0 : tangent(a, b, keys[i + 2]!, k);
    return (
      (2 * s3 - 3 * s2 + 1) * a.v[k]! + (s3 - 2 * s2 + s) * h * ma + (-2 * s3 + 3 * s2) * b.v[k]! + (s3 - s2) * h * mb
    );
  });
}

/**
 * The slope through `mid` of component `k`: zero where the track turns around and the harmonic mean of the two slopes
 * otherwise, so the curve never overshoots a key. A camera that swings past its mark dips under the ground.
 */
function tangent(before: Key, mid: Key, after: Key, k: number): number {
  const d0 = (mid.v[k]! - before.v[k]!) / (mid.t - before.t);
  const d1 = (after.v[k]! - mid.v[k]!) / (after.t - mid.t);
  return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
}

/** What the script gives the page: where the camera stands and looks, and how many ticks past the first frame's the city is. */
export interface Path {
  position: Key[];
  target: Key[];
  ticks: Key[];
  /**
   * Hold the camera behind a car instead of on the keyed path until `until`, then hand over to the path over `blend` ms.
   * `back` (closing to `backEnd` by `until`), `up` and `side` are tiles behind the car, above the road and to its right; `ahead` is how far in front the
   * camera looks. The car handed over to is the nearest one when its own trip ends.
   */
  follow?: {
    resident: number;
    back: number;
    backEnd: number;
    up: number;
    side: number;
    ahead: number;
    until: number;
    blend: number;
  };
}
