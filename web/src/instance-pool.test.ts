import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { InstancePool } from './instance-pool';

const at = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const x = (pool: InstancePool, i: number) => (pool.mesh.instanceMatrix.array as Float32Array)[i * 16 + 12];
const pool = (extras = [{ name: 'alpha', size: 1 }]) =>
  new InstancePool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), extras);
const alpha = (p: InstancePool, i: number) => (p.mesh.geometry.getAttribute('alpha').array as Float32Array)[i];

describe('an instance pool', () => {
  it('draws as many instances as it holds, in one mesh', () => {
    const p = pool();
    expect(p.mesh.count).toBe(0);
    for (let i = 0; i < 5; i++) p.add(at(i));
    expect(p.mesh.count).toBe(5);
    expect(p.mesh.frustumCulled).toBe(false);
  });

  it('keeps every instance through growth', () => {
    const p = pool();
    const all = Array.from({ length: 100 }, (_, i) => {
      const inst = p.add(at(i));
      p.set(inst, 'alpha', i / 100);
      return inst;
    });
    all.forEach((inst, i) => {
      expect(x(p, inst.index)).toBe(i);
      expect(alpha(p, inst.index)).toBeCloseTo(i / 100);
    });
  });

  it('fills the hole a removed instance leaves with the last one, matrix and extras together', () => {
    const p = pool();
    const [a, b, c] = [p.add(at(1)), p.add(at(2)), p.add(at(3))];
    p.set(a, 'alpha', 0.1);
    p.set(b, 'alpha', 0.2);
    p.set(c, 'alpha', 0.3);
    p.remove(a);
    expect(p.count).toBe(2);
    expect(p.mesh.count).toBe(2);
    expect(a.index).toBe(-1);
    // `c` moved into `a`'s place and still reads as itself.
    expect(c.index).toBe(0);
    expect(x(p, c.index)).toBe(3);
    expect(alpha(p, c.index)).toBeCloseTo(0.3);
    expect(x(p, b.index)).toBe(2);
    expect(alpha(p, b.index)).toBeCloseTo(0.2);
  });

  it('removes the last instance, and one already removed, without harm', () => {
    const p = pool();
    const a = p.add(at(1));
    const b = p.add(at(2));
    p.remove(b);
    p.remove(b);
    expect(p.count).toBe(1);
    expect(x(p, a.index)).toBe(1);
  });

  it('starts a reused slot from zero, not from what was there', () => {
    const p = pool();
    const a = p.add(at(1));
    p.set(a, 'alpha', 0.9);
    p.remove(a);
    const b = p.add(at(2));
    expect(alpha(p, b.index)).toBe(0);
  });

  it('uploads an extra only when its value changed', () => {
    const p = pool();
    const a = p.add(at(1));
    const attribute = p.mesh.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    const version = attribute.version;
    p.set(a, 'alpha', 0);
    expect(attribute.version).toBe(version);
    p.set(a, 'alpha', 0.5);
    expect(attribute.version).toBeGreaterThan(version);
  });

  it('keeps per-instance colour on the mesh, where three.js reads it', () => {
    const p = pool([{ name: 'instanceColor', size: 3 }]);
    const a = p.add(at(1));
    p.set(a, 'instanceColor', 0.1, 0.2, 0.3);
    expect(Array.from(p.mesh.instanceColor!.array.slice(0, 3))).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it('does not touch the model geometry it shares vertices with', () => {
    const source = new THREE.BoxGeometry(1, 1, 1);
    const p = new InstancePool(source, new THREE.MeshBasicMaterial(), [{ name: 'alpha', size: 1 }]);
    expect(source.getAttribute('alpha')).toBeUndefined();
    expect(p.mesh.geometry.getAttribute('position')).toBe(source.getAttribute('position'));
  });
});
