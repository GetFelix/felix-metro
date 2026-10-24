import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Falling, Rising } from './city';
import { ConstructionFx, type LotAccess } from './construction-fx';

vi.stubGlobal('document', {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      set fillStyle(_v: unknown) {},
    }),
  }),
});

function access() {
  const objects = new Map<number, THREE.Object3D[]>();
  const ghosts = new Map<number, THREE.Object3D[]>();
  const ghostSet = new Set<number>();
  const box = () => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    o.position.y = 0.5;
    return o;
  };
  const lots: LotAccess = {
    objects: (l) => objects.get(l) ?? [],
    ghosts: (l) => ghosts.get(l) ?? [],
    setGhost(l, b) {
      if (b) {
        ghostSet.add(l);
        ghosts.set(l, [box()]);
      } else {
        ghostSet.delete(l);
        ghosts.delete(l);
      }
    },
    centre: (l) => [l, 0],
  };
  return { lots, objects, ghostSet, box };
}

const fx = (effects = true) => {
  const a = access();
  const scene = new THREE.Scene();
  return { ...a, scene, fx: new ConstructionFx(scene, a.lots, effects) };
};
const shown = (scene: THREE.Scene, kind: 'Mesh' | 'Sprite') =>
  scene.children.filter((c) => c.visible && (c as { type: string }).type === kind).length;

describe('many builds at once', () => {
  it('draws 30 rises with 24 scaffolds, and a lot that found the pool full stays without for its window', () => {
    const { fx: f, objects, box, scene } = fx();
    const rising = new Map<number, Rising>();
    for (let l = 0; l < 30; l++) {
      objects.set(l, [box()]);
      rising.set(l, { kind: 1, rotation: 0, tick: 100 });
    }
    expect(() => f.update(101, rising, new Map())).not.toThrow();
    expect(shown(scene, 'Mesh')).toBe(24);
    // One lot is gone and frees a scaffold; the six that were refused must not pick it up half way through.
    rising.delete(0);
    f.update(103, rising, new Map());
    f.update(104, rising, new Map());
    expect(shown(scene, 'Mesh')).toBe(23);
  });

  it('draws 30 demolitions with at most 24 stand-in buildings, 8 puffs, and no late arrivals', () => {
    const { fx: f, ghostSet, scene } = fx();
    const falling = new Map<number, Falling>();
    for (let l = 0; l < 30; l++) falling.set(l, { kind: 1, rotation: 0, tick: 100, from: 1 });
    expect(() => f.update(103, new Map(), falling)).not.toThrow();
    expect(ghostSet.size).toBe(24);
    expect(shown(scene, 'Sprite')).toBe(8 * 14);
    falling.delete(0);
    f.update(104, new Map(), falling);
    expect(ghostSet.size).toBe(23);
    expect(ghostSet.has(29)).toBe(false);
    expect(shown(scene, 'Sprite')).toBe(7 * 14);
  });

  it('shows a scaffold and fully opaque dust at the middle of a demolition', () => {
    const { fx: f, scene } = fx();
    const falling = new Map([[3, { kind: 1, rotation: 0, tick: 100, from: 1 } as Falling]]);
    f.update(104, new Map(), falling);
    // The stand-in loads a frame later in the page; a second update sees its height.
    f.update(104, new Map(), falling);
    expect(shown(scene, 'Mesh')).toBe(1);
    const opacity = scene.children
      .filter((c) => c.visible && c.type === 'Sprite')
      .map((c) => (c as THREE.Sprite).material.opacity);
    expect(opacity.length).toBe(14);
    expect(Math.min(...opacity)).toBeCloseTo(1, 5);
  });
});
