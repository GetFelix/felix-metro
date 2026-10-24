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
    // Tangents by central difference; zero at the two ends.
    const ma = i === 0 ? 0 : (b.v[k]! - keys[i - 1]!.v[k]!) / (b.t - keys[i - 1]!.t);
    const mb = i + 2 >= keys.length ? 0 : (keys[i + 2]!.v[k]! - a.v[k]!) / (keys[i + 2]!.t - a.t);
    return (
      (2 * s3 - 3 * s2 + 1) * a.v[k]! + (s3 - 2 * s2 + s) * h * ma + (-2 * s3 + 3 * s2) * b.v[k]! + (s3 - s2) * h * mb
    );
  });
}

/** What the script gives the page: where the camera stands and looks, and how many ticks past the first frame's the city is. */
export interface Path {
  position: Key[];
  target: Key[];
  ticks: Key[];
}
