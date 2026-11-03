import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LampLights } from './lamp-lights';

const maps = () => ({ glow: new THREE.Texture(), pool: new THREE.Texture() });
const make = () => {
  const scene = new THREE.Scene();
  const hidden: THREE.Object3D[] = [];
  return { scene, hidden, lights: new LampLights(scene, hidden, maps()) };
};
const arm = (x: number) => new THREE.Vector3(x, 0.58, 0);
const alphas = (mesh: THREE.InstancedMesh) =>
  Array.from(mesh.geometry.getAttribute('alpha').array.slice(0, mesh.count));

describe('lamp lights', () => {
  it('draws every lamp of a city with three meshes, and hides the additive two from the occlusion pass', () => {
    const { scene, hidden, lights } = make();
    for (let i = 0; i < 50; i++) lights.add(i, arm(i));
    expect(scene.children).toHaveLength(3);
    expect(hidden).toHaveLength(2);
    expect(hidden.every((m) => (m as THREE.InstancedMesh).count === 50)).toBe(true);
  });

  it('switches each lamp alone, from its own on value and the hour', () => {
    const { hidden, lights } = make();
    const a = lights.add(1, arm(0));
    const b = lights.add(2, arm(1));
    lights.set(a, 1, 0.9, 0.55);
    lights.set(b, 0.5, 0.9, 0.55);
    const [glow, pool] = hidden as THREE.InstancedMesh[];
    expect(alphas(glow!)[0]).toBeCloseTo(0.9);
    expect(alphas(glow!)[1]).toBeCloseTo(0.45);
    expect(alphas(pool!)[0]).toBeCloseTo(0.55);
    expect(alphas(pool!)[1]).toBeCloseTo(0.275);
  });

  it('starts a new lamp switched off', () => {
    const { hidden, lights } = make();
    lights.add(1, arm(0));
    expect(alphas(hidden[0] as THREE.InstancedMesh)).toEqual([0]);
  });

  it('takes a lamp down without switching on or off the others', () => {
    const { hidden, lights } = make();
    const a = lights.add(1, arm(0));
    const b = lights.add(2, arm(1));
    lights.set(a, 1, 1, 1);
    lights.set(b, 0.5, 1, 1);
    lights.remove(a);
    const glow = hidden[0] as THREE.InstancedMesh;
    expect(glow.count).toBe(1);
    expect(alphas(glow)[0]).toBeCloseTo(0.5);
    lights.set(b, 1, 1, 1);
    expect(alphas(glow)[0]).toBeCloseTo(1);
  });

  it('puts the lights at the arm: the pool on the ground under it, lying flat', () => {
    const { hidden, lights } = make();
    lights.add(1, new THREE.Vector3(3, 0.58, 4));
    const pool = hidden[1] as THREE.InstancedMesh;
    const m = new THREE.Matrix4().fromArray(pool.instanceMatrix.array);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    expect(at.toArray()).toEqual([3, Math.fround(0.03), 4]);
    // A plane faces +Z; lying flat it faces up.
    expect(new THREE.Vector3(0, 0, 1).applyMatrix4(m.clone().setPosition(0, 0, 0)).y).toBeGreaterThan(0.9);
  });
});
