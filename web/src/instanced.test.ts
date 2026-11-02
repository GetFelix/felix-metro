import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Batch, glowGeometry, glowMaterial } from './instanced';

const batch = (extra?: { name: string; size: number }) =>
  new Batch(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), extra);

describe('Batch', () => {
  it('draws nothing until instances are handed out and finished', () => {
    const b = batch();
    expect(b.mesh.count).toBe(0);
    b.next();
    b.next();
    expect(b.count).toBe(2);
    b.finish();
    expect(b.mesh.count).toBe(2);
  });

  it('starts over from empty', () => {
    const b = batch();
    b.next();
    b.finish();
    b.clear();
    b.finish();
    expect(b.mesh.count).toBe(0);
    expect(b.next()).toBe(0);
  });

  it('uploads only the instances in use', () => {
    const b = batch();
    b.next();
    b.next();
    b.finish();
    expect(b.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 32 }]);
    b.clear();
    b.next();
    b.finish();
    expect(b.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]);
  });

  it('is never culled, since the caller places only what it wants drawn', () => {
    expect(batch().mesh.frustumCulled).toBe(false);
  });

  it('grows past what it first held without losing an instance, and stays the same mesh', () => {
    const b = batch({ name: 'phase', size: 1 });
    const mesh = b.mesh;
    for (let i = 0; i < 300; i++) {
      const at = b.next();
      new THREE.Matrix4().makeTranslation(i, 0, 0).toArray(b.matrices, at * 16);
      b.values[at] = i / 1000;
    }
    b.finish();
    expect(b.mesh).toBe(mesh);
    expect(b.mesh.count).toBe(300);
    expect(b.matrices.length).toBeGreaterThanOrEqual(300 * 16);
    expect(b.matrices[299 * 16 + 12]).toBe(299);
    expect(b.values[299]).toBeCloseTo(0.299);
    for (const i of [10, 100, 250]) {
      expect(b.matrices[i * 16 + 12]).toBe(i);
      expect(b.values[i]).toBeCloseTo(i / 1000);
    }
  });

  it('keeps the per-instance values on the geometry as an instanced attribute', () => {
    const b = batch({ name: 'phase', size: 1 });
    expect(b.mesh.geometry.getAttribute('phase')).toBeInstanceOf(THREE.InstancedBufferAttribute);
  });
});

describe('glows', () => {
  it('are additive, unlit by default, and take their brightness from a uniform', () => {
    const m = glowMaterial(new THREE.Texture());
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(m.transparent).toBe(true);
    expect(m.fog).toBe(true);
    expect(m.uniforms.opacity!.value).toBe(0);
  });

  it('are drawn on the quad a THREE.Sprite is', () => {
    const g = glowGeometry();
    g.computeBoundingBox();
    expect(g.boundingBox!.min.toArray()).toEqual([-0.5, -0.5, 0]);
    expect(g.boundingBox!.max.toArray()).toEqual([0.5, 0.5, 0]);
  });
});
