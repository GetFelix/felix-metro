import * as THREE from 'three';
import { SKY } from './palette';

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => THREE.MathUtils.clamp(t, 0, 1);

// A fixed number in [0, 1) for a pair of integers. Ids come from this and never from rand(), so adding a building or a
// lamp does not move the seeded layout.
export function unitHash(a: number, b: number) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Buildings share window materials per light-hour bucket, so the count of materials stays bounded.
export const WINDOW_BUCKETS = 8;
export const windowBucket = (x: number, z: number) => Math.floor(unitHash(x, z) * WINDOW_BUCKETS);

const WINDOW_FADE = 1 / 6; // ten city minutes
const LAMP_FADE = 0.15;
const LAMP_SPREAD = 1 / 3; // twenty city minutes

// Windows come on between 17:30 and 19:30 and go dark between 06:00 and 07:30, at an hour fixed by the bucket.
// This is only whether the building's lights are switched on; darkness still sets how bright they are.
export function windowSwitch(hour: number, bucket: number) {
  const h = wrap(hour);
  const on = 17.5 + (2 * bucket) / (WINDOW_BUCKETS - 1);
  const off = 6 + (1.5 * ((bucket * 3) % WINDOW_BUCKETS)) / (WINDOW_BUCKETS - 1);
  return h >= 12 ? smooth(clamp01((h - on) / WINDOW_FADE)) : 1 - smooth(clamp01((h - off) / WINDOW_FADE));
}

// Each lamp has its own switch-on hour within twenty minutes of dusk, and its own switch-off hour at dawn.
export function lampSwitch(hour: number, id: number) {
  const h = wrap(hour);
  return h >= 12
    ? smooth(clamp01((h - (18.45 + LAMP_SPREAD * id)) / LAMP_FADE))
    : 1 - smooth(clamp01((h - (6.9 + LAMP_SPREAD * id)) / LAMP_FADE));
}

export const lampId = (x: number, z: number) => unitHash(Math.round(x * 100), Math.round(z * 100));

function wrap(hour: number) {
  return ((hour % 24) + 24) % 24;
}

function sky(hour: number) {
  let i = 0;
  while (i < SKY.length - 2 && hour >= SKY[i + 1]![0]) i++;
  const a = SKY[i]!;
  const b = SKY[i + 1]!;
  const t = smooth(clamp01((hour - a[0]) / (b[0] - a[0])));
  const mix = (k: 1 | 2 | 4 | 5) => a[k].clone().lerp(b[k], t);
  const num = (k: 3 | 6 | 7) => a[k] + (b[k] - a[k]) * t;
  return { sky: mix(1), sun: mix(2), sunI: num(3), hs: mix(4), hg: mix(5), hI: num(6), exp: num(7) };
}

// How dark it is, 0 at noon to 1 at night.
function night(h: number) {
  const d = Math.min(Math.abs(h - 13), 24 - Math.abs(h - 13)); // hours from 13:00
  return smooth(clamp01((d - 4.8) / 2.0));
}

// Everything that depends on the hour, and nothing else. The per-building and per-lamp switches are separate
// (windowSwitch, lampSwitch) because they also take an id.
export function daylight(hourIn: number) {
  const hour = wrap(hourIn);
  const s = sky(hour);
  const n = night(hour);
  // The sun travels east to west; at night the same light is the moon, high and cool.
  // The swap eases in over three hours, so the shadows swing slowly instead of jumping.
  const d13 = Math.min(Math.abs(hour - 13), 24 - Math.abs(hour - 13));
  const moon = smooth(clamp01((d13 - 4.8) / 3.2));
  const dayAngle = ((hour - 6) / 12) * Math.PI;
  const elev = THREE.MathUtils.lerp(Math.max(0.12, Math.sin(dayAngle)), 0.9, moon);
  const az = THREE.MathUtils.lerp(dayAngle, 2.2, moon);
  // Headlights follow the darkness, the same curve the lamps used to share.
  const carLights = smooth(clamp01((n - 0.25) / 0.4));
  return {
    night: n,
    sky: s.sky,
    sun: s.sun,
    sunIntensity: s.sunI,
    // West is +x, so the evening sun comes from the camera's side and lights the faces in view.
    sunPosition: [-Math.cos(az) * 20, elev * 22 + 3, 6 + Math.sin(az) * 3] as const,
    hemiSky: s.hs,
    hemiGround: s.hg,
    hemiIntensity: s.hI,
    exposure: s.exp,
    environment: 0.06 + 0.5 * (1 - n),
    groundNight: n * 0.6,
    windowBrightness: n * 0.85,
    poolOpacity: 0.55,
    glowOpacity: 0.9,
    headlight: carLights,
    taillight: carLights * 0.8,
    beam: carLights * 0.35,
    bloom: 0.1 + n * 0.35,
    crown: 0.5 + n * 2.5,
    signEmissive: 0.12 + n * 0.3,
  };
}
