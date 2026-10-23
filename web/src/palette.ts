import * as THREE from 'three';

export const PALETTE = {
  grass: 0x79a85f,
  grassFar: 0x4d8a4a,
  water: 0x3f8fb0,
  lamp: 0xffc46b,
  window: new THREE.Color(1.0, 0.66, 0.32),
  headlight: 0xfff1d0,
  taillight: 0xff3b2a,
};

export const FOG = 0x9fb7c8;
export const HEMI = { sky: 0xcfe6ff, ground: 0x5a6b4a };
export const GROUND_NIGHT = 0x1d2a2a;
export const BULB_OFF = 0x8a90a0;
export const TOWER = { crown: 0x1b2430, mast: 0x3d434c };

// Kenney's default colormap has white walls and green roofs; each variant tints the wall swatches and the roof swatches.
export const WALLS = [0xf1e3cb, 0xe8a77c, 0xd9785c, 0xc9d6e2, 0xf4f1ea, 0xe7c48f];
export const ROOFS = [0xc65a40, 0x4f6a8c, 0x3d434c, 0x8a5a44, 0x3f8f6a];

export const CYAN = new THREE.Color().setHSL(192 / 360, 0.9, 0.46);

const C = (h: number) => new THREE.Color(h);

export type SkyKey = [
  hour: number,
  sky: THREE.Color,
  sun: THREE.Color,
  sunIntensity: number,
  hemiSky: THREE.Color,
  hemiGround: THREE.Color,
  hemiIntensity: number,
  exposure: number,
];

// Keyframes of the sky through a day.
export const SKY: SkyKey[] = [
  [0, C(0x0b1630), C(0x6f86c9), 0.22, C(0x2c3a66), C(0x0e1018), 0.3, 1.0],
  [5, C(0x1a2648), C(0x7f8fd0), 0.3, C(0x3b4c80), C(0x14161f), 0.4, 1.0],
  [6.5, C(0xf0a27a), C(0xffb070), 1.6, C(0xffd2b0), C(0x5a4a4a), 0.7, 1.0],
  [9, C(0xb8d8ee), C(0xfff2dc), 2.8, C(0xd8ecff), C(0x5a6b4a), 0.85, 1.0],
  [16, C(0xb4d2ea), C(0xffeccc), 2.7, C(0xd6e8ff), C(0x5a6b4a), 0.85, 1.0],
  [17.6, C(0xf2b080), C(0xffb060), 2.2, C(0xffd6b0), C(0x5a4a40), 0.65, 1.0],
  [18.8, C(0xe0805a), C(0xff7a40), 1.2, C(0xc89a9a), C(0x3a3040), 0.45, 1.0],
  [19.6, C(0x4a4a80), C(0xff6a50), 0.35, C(0x6a6aa0), C(0x1e1c2a), 0.35, 1.0],
  [20.5, C(0x141c3a), C(0x7d8ccc), 0.25, C(0x2c3a66), C(0x0e1018), 0.3, 1.0],
  [24, C(0x0b1630), C(0x6f86c9), 0.22, C(0x2c3a66), C(0x0e1018), 0.3, 1.0],
];
