import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';
import { Ambient, type AmbientAccess, type AmbientSettings } from './ambient-fx';
import { TRUCK_KIND, VAN_KIND } from './ambient';
import { NO_BUILDING } from './city';
import { KINDS } from './kinds';
import type { City } from './layout';
import type { Fleet } from './traffic';

// Any drawing call is accepted; the textures are never looked at.
const context = new Proxy(
  {},
  {
    get: (_t, name) =>
      name === 'createRadialGradient' || name === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {},
    set: () => true,
  },
);
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });

const FULL: AmbientSettings = { shops: true, smoke: 4, birds: 3, vans: 6, truck: true, signals: true };
const LOW: AmbientSettings = { shops: true, smoke: 0, birds: 0, vans: 0, truck: false, signals: false };
const at = (hour: number) => hour * TICKS_PER_HOUR;

const kindOf = (pack: string, model: string) => KINDS.findIndex((k) => k.pack === pack && k.model === model);
const SHOP = kindOf('commercial', 'building-a');
const FACTORY = kindOf('industrial', 'building-a');
const HOUSE = kindOf('suburban', 'building-type-a');

/** A 12-tile city: a street along z = 4, a crossing at (6, 4) and a side road, with a shop, a factory and a house. */
function world() {
  const roads: City['roads'] = [];
  for (let x = 0; x < 12; x++) roads.push({ x, z: 4, piece: x === 6 ? 3 : 0, rot: 0, mask: 5, avenue: false });
  for (let z = 0; z < 4; z++) roads.push({ x: 6, z, piece: 0, rot: 0, mask: 5, avenue: false });
  const lots: City['lots'] = [];
  const kinds = [SHOP, SHOP, FACTORY, HOUSE, SHOP, HOUSE, FACTORY, SHOP];
  for (let i = 0; i < 12; i++) {
    const x = i;
    if (x === 6) continue;
    lots.push({
      id: lots.length,
      x,
      z: 3,
      district: 0,
      zone: x < 5 ? 'commercial' : 'industrial',
      kind: kinds[i % kinds.length]!,
      facing: 0,
      doorSegment: 0,
    });
  }
  const city: City = {
    seed: 'harbor',
    tiles: 12,
    shore: null,
    tower: -1,
    development: [],
    lots,
    roads,
    water: [],
    nodes: [],
    segments: [],
  };
  const half = 5.5;
  const kind = new Map(lots.map((l) => [l.id, l.kind]));
  const built = new Map<number, THREE.Object3D>();
  const busy = new Set<number>();
  for (const l of lots) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1, 0.9));
    o.position.set(l.x - half, 0.5, l.z - half);
    built.set(l.id, o);
  }
  const access: AmbientAccess = {
    kind: (id) => kind.get(id) ?? NO_BUILDING,
    building: (id) => built.get(id) ?? null,
    busy: (id) => busy.has(id),
  };
  const scene = new THREE.Scene();
  const glows: THREE.Object3D[] = [];
  const ambient = new Ambient(scene, city, access, FULL, glows);
  for (const l of lots) ambient.refresh(l.id);
  return { ambient, scene, glows, busy, city, kind, built };
}

/** A fleet that remembers what it was asked to place. */
function fleet() {
  const cars: { kind: number; x: number; z: number; size: number }[] = [];
  const f: Fleet = {
    view() {},
    begin() {},
    car: (kind, x, _y, z, _h, size) => void cars.push({ kind, x, z, size }),
    person() {},
    end() {},
  };
  return { f, cars };
}

const counted = (a: Ambient) => ({ ...a.counts() });

describe('Ambient', () => {
  it('lights shops by day, not at night', () => {
    const { ambient } = world();
    ambient.update(at(12));
    expect(ambient.counts().shops).toBeGreaterThan(0);
    ambient.update(at(3));
    expect(ambient.counts().shops).toBe(0);
  });

  it('smokes factory stacks on work hours only', () => {
    const { ambient } = world();
    ambient.update(at(11));
    expect(ambient.counts().puffs).toBeGreaterThan(0);
    // Two stacks, four puffs each.
    expect(ambient.counts().puffs % 4).toBe(0);
    ambient.update(at(21));
    expect(ambient.counts().puffs).toBe(0);
    ambient.update(at(2));
    expect(ambient.counts().puffs).toBe(0);
  });

  it('puts birds on roofs at dawn and none at noon or at night', () => {
    const { ambient } = world();
    let most = 0;
    for (let h = 4.5; h < 9; h += 0.05) {
      ambient.update(at(h));
      most = Math.max(most, ambient.counts().birds);
    }
    expect(most).toBeGreaterThan(0);
    expect(most % 3).toBe(0);
    for (const h of [12, 20, 2]) {
      ambient.update(at(h));
      expect(ambient.counts().birds).toBe(0);
    }
  });

  it('shows the traffic lights of a crossing, one road red while the other goes', () => {
    const { ambient } = world();
    for (let t = 0; t < 40; t += 3) {
      ambient.update(t);
      const c = ambient.counts();
      expect(c.green + c.amber + c.red).toBe(4);
      expect(c.red).toBeGreaterThanOrEqual(2);
    }
  });

  it('sends the truck out in the morning and the vans through the day, and not at night', () => {
    const { ambient } = world();
    const trucks = new Set<number>();
    const vans = new Set<number>();
    for (let day = 0; day < 3; day++) {
      for (let h = 0; h < 24; h += 0.25) {
        ambient.update(day * TICKS_PER_DAY + at(h));
        trucks.add(ambient.counts().truck);
        if (ambient.counts().vans > 0) vans.add(Math.floor(h));
        if (h < 5.9 || h > 20) expect(ambient.counts().truck + ambient.counts().vans).toBe(0);
        if (h > 12) expect(ambient.counts().truck).toBe(0);
      }
    }
    expect(trucks.has(1)).toBe(true);
    expect([...vans].some((h) => h >= 9 && h <= 15)).toBe(true);
  });

  it('hands the vehicles to the fleet, a van as kind 6 and the truck as kind 7', () => {
    const { ambient } = world();
    const seen = new Set<number>();
    for (let t = 0; t < TICKS_PER_DAY; t += 12) {
      ambient.update(t);
      const { f, cars } = fleet();
      ambient.place(f);
      expect(cars.length).toBe(ambient.counts().vans + ambient.counts().truck);
      for (const c of cars) seen.add(c.kind);
    }
    expect([...seen].sort()).toEqual([VAN_KIND, TRUCK_KIND]);
  });

  it('draws the same picture at a tick however it was reached: forward, back, or a jump', () => {
    const { ambient } = world();
    const ticks = [at(6.45), at(11), at(12.3), at(18.7), at(7.2), at(23)];
    const snapshot = () => ({
      counts: counted(ambient),
      cars: (() => {
        const { f, cars } = fleet();
        ambient.place(f);
        return cars;
      })(),
    });
    const forward = ticks.map((t) => (ambient.update(t), snapshot()));
    const back = [...ticks]
      .reverse()
      .map((t) => (ambient.update(t), snapshot()))
      .reverse();
    expect(back).toEqual(forward);
    // A jump from somewhere else entirely.
    ambient.update(at(3));
    ambient.update(ticks[2]!);
    expect(snapshot()).toEqual(forward[2]);
  });

  it('draws the same pixels data at a tick after a rewind', () => {
    const { ambient, scene } = world();
    const batches = () =>
      scene.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    const state = () =>
      batches().map((m) => ({
        count: m.count,
        matrices: Array.from((m.instanceMatrix.array as Float32Array).subarray(0, m.count * 16)),
        alpha: m.geometry.getAttribute('alpha')
          ? Array.from((m.geometry.getAttribute('alpha').array as Float32Array).subarray(0, m.count))
          : [],
      }));
    ambient.update(at(11.4));
    const first = state();
    ambient.update(at(9));
    ambient.update(at(14));
    ambient.update(at(11.4));
    expect(state()).toEqual(first);
  });

  it('plans each day afresh: a day later and back again draws what a fresh page draws', () => {
    const state = (a: Ambient) => {
      const { f, cars } = fleet();
      a.place(f);
      return { counts: counted(a), cars };
    };
    const fresh = world().ambient;
    const t = at(8.5);
    fresh.update(t);
    const first = state(fresh);
    const { ambient } = world();
    ambient.update(TICKS_PER_DAY + t);
    ambient.update(t);
    expect(state(ambient)).toEqual(first);
    // Several round trips through other days still land on the same picture.
    for (const day of [3, 7, 1]) ambient.update(day * TICKS_PER_DAY + t);
    ambient.update(t);
    expect(state(ambient)).toEqual(first);
  });

  it('skips a lot the construction update has just marked busy, when what hangs on buildings is drawn after it', () => {
    const { ambient, busy } = world();
    ambient.drive(at(11));
    ambient.decorate(at(11));
    const before = ambient.counts().puffs;
    expect(before).toBeGreaterThan(0);
    // A seek lands on a tick where lots are mid-rise: busy changes between the vans and the decoration.
    ambient.drive(at(11));
    for (let id = 0; id < 20; id++) busy.add(id);
    ambient.decorate(at(11));
    expect(ambient.counts().puffs).toBe(0);
    expect(ambient.counts().shops).toBe(0);
  });

  it('draws the same whether the vans and the decoration are updated together or apart', () => {
    const a = world().ambient;
    const b = world().ambient;
    for (const t of [at(7.2), at(11), at(15.5)]) {
      a.update(t);
      b.drive(t);
      b.decorate(t);
      expect(counted(b)).toEqual(counted(a));
    }
  });

  it('leaves a lot alone while it is going up or coming down', () => {
    const { ambient, busy } = world();
    ambient.update(at(11));
    const all = ambient.counts().puffs;
    expect(all).toBeGreaterThan(0);
    for (let id = 0; id < 20; id++) busy.add(id);
    ambient.update(at(11));
    expect(ambient.counts().puffs).toBe(0);
    expect(ambient.counts().shops).toBe(0);
  });

  it('takes a lot’s effects down when its building goes, and gives them back for a new one', () => {
    const { ambient, kind } = world();
    ambient.update(at(11));
    const before = counted(ambient);
    for (let id = 0; id < 20; id++) ambient.clearLot(id);
    ambient.update(at(11));
    expect(ambient.counts().puffs).toBe(0);
    for (let id = 0; id < 20; id++) {
      kind.set(id, kind.get(id)!);
      ambient.refresh(id);
    }
    ambient.update(at(11));
    expect(counted(ambient)).toEqual(before);
  });

  it('draws less on a low tier: shops only', () => {
    const { ambient } = world();
    ambient.update(at(11));
    expect(ambient.counts().puffs).toBeGreaterThan(0);
    ambient.setTier(LOW);
    const c = ambient.counts();
    expect(c.puffs + c.birds + c.vans + c.truck + c.green + c.amber + c.red).toBe(0);
    expect(c.shops).toBeGreaterThan(0);
    ambient.update(at(6.4));
    expect(ambient.counts().birds + ambient.counts().truck).toBe(0);
  });

  it('adds nothing to the scene past what it made at the start, however long it runs', () => {
    const { ambient, scene } = world();
    const before = scene.children.length;
    for (let t = 0; t < TICKS_PER_DAY; t += 37) ambient.update(t);
    expect(scene.children.length).toBe(before);
  });

  it('hides its blended sprites from the passes that draw the scene with one material', () => {
    const { glows, scene } = world();
    expect(glows.length).toBeGreaterThanOrEqual(4);
    for (const g of glows) expect(scene.children).toContain(g);
  });
});
