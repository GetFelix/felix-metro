// Draws construction and demolition for the lots a CityState says are inside their window: a building scaled to its
// progress, a scaffold round a rising one, a puff of dust over a falling one. Nothing here keeps a clock; every frame is
// worked out from the tick drawn, so a frozen tick draws the same picture and scrubbing plays it either way.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { unitHash } from './daylight';
import { fallScale, progress, riseScale } from './construction';
import type { Falling, Rising } from './city';

/**
 * Scaffolds, dust puffs and stand-in buildings that can be on screen at once. A lot that finds a pool full is drawn
 * without that effect for its whole window, so nothing pops in late.
 */
const CAGES = 24;
const PUFFS = 8;
const GHOSTS = 24;
const SPECKS = 12;
/** Half the width of the scaffold in tiles: a building fits 0.9 of its lot. */
const HALF = 0.47;
const POST = 0.03;
const MIN_HEIGHT = 0.02;

/** Timber, from the warm end of the palette. */
const TIMBER = 0xd9a05b;
const DUST = 'rgba(184,176,164,1)';

type Mode = 'rise' | 'fall';

interface Slot {
  mode: Mode;
  cage: number;
  puff: number;
  /** The lot found a pool full and does without it until its window ends. */
  noCage: boolean;
  noPuff: boolean;
  ghost: boolean;
  seen: boolean;
}

/** What the scene lets this reach: a lot's drawn objects, and a stand-in for a building that was demolished. */
export interface LotAccess {
  /** The objects drawn on the lot now, loaded so far. */
  objects(lot: number): readonly THREE.Object3D[];
  /** The objects of the building coming down on the lot, loaded so far. */
  ghosts(lot: number): readonly THREE.Object3D[];
  /** Draw the building that stood on the lot, or take it away with `null`. */
  setGhost(lot: number, building: { kind: number; rotation: number } | null): void;
  /** The lot's centre in world units. */
  centre(lot: number): readonly [number, number];
}

function cageGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  // Four posts and, on every side, a rail at each level. The height is one so a scale in Y fits any building.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(POST, 1, POST, sx * HALF, 0.5, sz * HALF);
  for (const y of [0.25, 0.5, 0.75, 1]) {
    box(HALF * 2, 0.012, POST, 0, y, -HALF);
    box(HALF * 2, 0.012, POST, 0, y, HALF);
    box(POST, 0.012, HALF * 2, -HALF, y, 0);
    box(POST, 0.012, HALF * 2, HALF, y, 0);
  }
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
  parts.forEach((g) => g.dispose());
  return merged;
}

export class ConstructionFx {
  private readonly slots = new Map<number, Slot>();
  private readonly cages: THREE.Mesh[] = [];
  private readonly cageFree: boolean[] = Array<boolean>(CAGES).fill(true);
  private readonly specks: THREE.Sprite[] = [];
  private readonly puffFree: boolean[] = Array<boolean>(PUFFS).fill(true);
  private readonly cageGeometry: THREE.BufferGeometry;
  private readonly cageMaterial: THREE.MeshStandardMaterial;
  private readonly dustTexture: THREE.CanvasTexture;
  private tick = 0;
  private ghosts = 0;
  private readonly gone: number[] = [];
  private readonly rise = (r: Rising, lot: number) => this.show(lot, 'rise', r.tick, 1, r);
  private readonly fall = (f: Falling, lot: number) => this.show(lot, 'fall', f.tick, f.from, f);

  /** `effects` false (the low tier) leaves out the scaffold and the dust; buildings still rise and fall. */
  constructor(
    private readonly scene: THREE.Scene,
    private readonly lots: LotAccess,
    private effects: boolean,
  ) {
    this.cageGeometry = cageGeometry();
    this.cageMaterial = new THREE.MeshStandardMaterial({ color: TIMBER, roughness: 0.9, metalness: 0 });
    for (let i = 0; i < CAGES; i++) {
      const cage = new THREE.Mesh(this.cageGeometry, this.cageMaterial);
      cage.visible = false;
      cage.castShadow = true;
      scene.add(cage);
      this.cages.push(cage);
    }
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, DUST);
    grad.addColorStop(0.75, DUST);
    grad.addColorStop(1, 'rgba(184,176,164,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.dustTexture = new THREE.CanvasTexture(c);
    this.dustTexture.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < PUFFS * SPECKS; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.dustTexture,
          transparent: true,
          depthWrite: false,
          opacity: 0,
          fog: false,
        }),
      );
      s.visible = false;
      scene.add(s);
      this.specks.push(s);
    }
  }

  /** Turn the scaffold and the dust on or off, as the quality tier changes. */
  setEffects(on: boolean): void {
    this.effects = on;
    if (on) return;
    this.cages.forEach((c) => (c.visible = false));
    this.specks.forEach((s) => (s.visible = false));
  }

  /** Draw the lots inside their window at `tick`, and put back any that have left it. */
  update(tick: number, rising: ReadonlyMap<number, Rising>, falling: ReadonlyMap<number, Falling>): void {
    this.tick = tick;
    for (const slot of this.slots.values()) slot.seen = false;
    rising.forEach(this.rise);
    falling.forEach(this.fall);
    this.gone.length = 0;
    for (const [lot, slot] of this.slots) if (!slot.seen) this.gone.push(lot);
    for (const lot of this.gone) this.release(lot);
  }

  /** Whether any lot is being drawn mid-way; for the CI check. */
  get active(): number {
    return this.slots.size;
  }

  dispose(): void {
    for (const lot of [...this.slots.keys()]) this.release(lot);
    this.cages.forEach((c) => this.scene.remove(c));
    this.specks.forEach((s) => {
      this.scene.remove(s);
      s.material.dispose();
    });
    this.cageGeometry.dispose();
    this.cageMaterial.dispose();
    this.dustTexture.dispose();
  }

  private show(lot: number, mode: Mode, at: number, from: number, building: Rising | Falling): void {
    const p = progress(at, this.tick);
    if (p >= 1) return;
    const scale = mode === 'rise' ? riseScale(at, this.tick) : fallScale(at, this.tick, from);
    let slot = this.slots.get(lot);
    if (slot && slot.mode !== mode) {
      this.release(lot);
      slot = undefined;
    }
    if (!slot) {
      slot = { mode, cage: -1, puff: -1, noCage: false, noPuff: false, ghost: false, seen: true };
      this.slots.set(lot, slot);
      if (mode === 'fall' && this.ghosts < GHOSTS) {
        slot.ghost = true;
        this.ghosts++;
        this.lots.setGhost(lot, building);
      }
    }
    slot.seen = true;
    const objects = mode === 'rise' ? this.lots.objects(lot) : this.lots.ghosts(lot);
    let height = 0;
    for (const o of objects) {
      const u = o.userData as { baseY?: number; fullH?: number };
      if (u.baseY === undefined) {
        u.baseY = o.scale.y;
        u.fullH = new THREE.Box3().setFromObject(o).max.y;
      }
      o.scale.y = u.baseY * Math.max(scale, MIN_HEIGHT);
      height = Math.max(height, u.fullH!);
    }
    if (!this.effects) return;
    this.scaffold(lot, slot, height, scale);
    if (mode === 'fall') this.dust(lot, slot, p);
  }

  private scaffold(lot: number, slot: Slot, fullHeight: number, scale: number): void {
    if (slot.noCage) return;
    if (slot.cage < 0) {
      slot.cage = this.cageFree.indexOf(true);
      if (slot.cage < 0) {
        slot.noCage = true;
        return;
      }
      this.cageFree[slot.cage] = false;
      const [x, z] = this.lots.centre(lot);
      this.cages[slot.cage]!.position.set(x, 0, z);
    }
    const cage = this.cages[slot.cage]!;
    // The frame stands a little over the wall as it climbs and settles to its height as the building tops out.
    cage.scale.set(1, Math.max(fullHeight * (scale + 0.12 * (1 - scale)), MIN_HEIGHT), 1);
    cage.visible = fullHeight > 0;
  }

  private dust(lot: number, slot: Slot, p: number): void {
    if (slot.noPuff) return;
    if (slot.puff < 0) {
      slot.puff = this.puffFree.indexOf(true);
      if (slot.puff < 0) {
        slot.noPuff = true;
        return;
      }
      this.puffFree[slot.puff] = false;
    }
    const [cx, cz] = this.lots.centre(lot);
    // The cloud swells to full strength mid-window and thins out again, so it reads against the falling walls.
    const strength = Math.sin(Math.PI * p);
    for (let i = 0; i < SPECKS; i++) {
      const s = this.specks[slot.puff * SPECKS + i]!;
      const angle = unitHash(lot, i * 4) * Math.PI * 2;
      // A ring round the walls, so the shrinking building stays in view inside it.
      const reach = 0.6 + unitHash(lot, i * 4 + 1) * 0.25 + Math.sqrt(p) * 0.15;
      const lift = 0.04 + unitHash(lot, i * 4 + 2) * 0.16 * (0.4 + p);
      s.position.set(cx + Math.cos(angle) * reach, 0.1 + lift, cz + Math.sin(angle) * reach);
      const size = (0.6 + unitHash(lot, i * 4 + 3) * 0.4) * (0.55 + 0.45 * strength);
      s.scale.set(size, size, 1);
      s.material.opacity = strength;
      s.visible = true;
    }
  }

  private release(lot: number): void {
    const slot = this.slots.get(lot)!;
    this.slots.delete(lot);
    if (slot.mode === 'rise') {
      for (const o of this.lots.objects(lot)) this.restore(o);
    } else if (slot.ghost) {
      this.lots.setGhost(lot, null);
      this.ghosts--;
    }
    if (slot.cage >= 0) {
      this.cages[slot.cage]!.visible = false;
      this.cageFree[slot.cage] = true;
    }
    if (slot.puff >= 0) {
      for (let i = 0; i < SPECKS; i++) this.specks[slot.puff * SPECKS + i]!.visible = false;
      this.puffFree[slot.puff] = true;
    }
  }

  private restore(o: THREE.Object3D): void {
    const u = o.userData as { baseY?: number };
    if (u.baseY !== undefined) o.scale.y = u.baseY;
  }
}
