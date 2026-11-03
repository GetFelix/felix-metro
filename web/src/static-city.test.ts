import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { StaticCity } from './static-city';

// A 2 by 2 colormap with a canvas that keeps its pixels, so the pack's texture array can be built without a browser.
vi.stubGlobal('document', {
  createElement: () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4), width: 2, height: 2 }),
        putImageData() {},
      }),
    };
    return canvas;
  },
});

/** A model of `meshes` parts, each a box standing `lift` above the model's origin. */
function model(meshes = 1, lift = 0.5): GLTF {
  const map = new THREE.Texture({ width: 2, height: 2 } as unknown as HTMLImageElement);
  const material = new THREE.MeshStandardMaterial({ map });
  const scene = new THREE.Group();
  for (let i = 0; i < meshes; i++) {
    const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    part.position.set(i, lift, 0);
    scene.add(part);
  }
  return { scene } as unknown as GLTF;
}

const placement = (m: GLTF, x: number, z: number) => {
  const o = m.scene.clone(true);
  o.position.set(x, 0, z);
  return o;
};
const city = () => {
  const scene = new THREE.Scene();
  return { scene, statics: new StaticCity(scene) };
};
const look = { variant: -1, lit: 0, bucket: 0 };

describe('the static city', () => {
  it('draws a hundred placements of two models as a handful of meshes', () => {
    const { statics } = city();
    const a = model(1);
    const b = model(3);
    for (let i = 0; i < 100; i++) {
      statics.add(placement(a, i, 0), a, 'commercial', look);
      statics.add(placement(b, i, 1), b, 'commercial', look);
    }
    expect(statics.meshes).toHaveLength(4);
    expect(statics.meshes.reduce((n, m) => n + m.count, 0)).toBe(100 + 300);
  });

  it('keeps the placements out of what is drawn, as objects a page can still measure', () => {
    const { scene, statics } = city();
    const m = model();
    const o = placement(m, 3, 4);
    statics.add(o, m, 'roads', look);
    expect(o.parent).toBe(statics.handles);
    // Outside the scene, so three.js does not walk them every frame.
    expect(scene.children).not.toContain(statics.handles);
    expect(scene.children).toContain(statics.group);
    const box = new THREE.Box3().setFromObject(o);
    expect(box.min.x).toBeCloseTo(2.5);
    expect(box.max.y).toBeCloseTo(1);
    // A ray from above the lot hits the hidden mesh, which is how a click on a building finds its lot.
    const ray = new THREE.Raycaster(new THREE.Vector3(3, 5, 4), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(o, true).length).toBeGreaterThan(0);
  });

  it('puts an instance where the placement is, the part where it sits in the model', () => {
    const { statics } = city();
    const m = model(1, 0.5);
    const o = placement(m, 3, 4);
    o.rotation.y = Math.PI / 2;
    o.scale.setScalar(2);
    statics.add(o, m, 'roads', look);
    const at = new THREE.Matrix4().fromArray(statics.meshes[0]!.instanceMatrix.array);
    const point = new THREE.Vector3().setFromMatrixPosition(at);
    // The part is 0.5 up in its model, so a scale of 2 lifts it to 1.
    expect(point.x).toBeCloseTo(3);
    expect(point.y).toBeCloseTo(1);
    expect(point.z).toBeCloseTo(4);
  });

  it('follows a placement that is scaled, as a building rising out of its lot is', () => {
    const { statics } = city();
    const m = model(1, 0.5);
    const o = placement(m, 0, 0);
    statics.add(o, m, 'commercial', look);
    const height = () => new THREE.Matrix4().fromArray(statics.meshes[0]!.instanceMatrix.array).elements[5];
    expect(height()).toBeCloseTo(1);
    o.scale.y = 0.25;
    expect(height()).toBeCloseTo(1);
    statics.sync(o);
    expect(height()).toBeCloseTo(0.25);
    expect(new THREE.Box3().setFromObject(o).max.y).toBeCloseTo(0.25 * 1);
  });

  it('takes a placement down without disturbing the others', () => {
    const { statics } = city();
    const m = model(1);
    const first = placement(m, 1, 0);
    const second = placement(m, 2, 0);
    const third = placement(m, 3, 0);
    for (const o of [first, second, third]) statics.add(o, m, 'roads', look);
    statics.remove(first);
    expect(statics.has(first)).toBe(false);
    expect(first.parent).toBeNull();
    const mesh = statics.meshes[0]!;
    expect(mesh.count).toBe(2);
    const xs = [0, 1].map((i) => mesh.instanceMatrix.array[i * 16 + 12]).sort();
    expect(xs).toEqual([2, 3]);
    // The survivors are still synced to their own instance.
    third.scale.y = 3;
    statics.sync(third);
    const row = [0, 1].find((i) => mesh.instanceMatrix.array[i * 16 + 12] === 3)!;
    expect(mesh.instanceMatrix.array[row * 16 + 5]).toBeCloseTo(3);
  });

  it('carries the wall and roof choice and the window light in each instance', () => {
    const { statics } = city();
    const m = model();
    statics.add(placement(m, 0, 0), m, 'commercial', { variant: 3, lit: 1.4, bucket: 5 });
    statics.add(placement(m, 1, 0), m, 'commercial', { variant: -1, lit: 0, bucket: 7 });
    const g = statics.meshes[0]!.geometry;
    expect(Array.from(g.getAttribute('variant').array.slice(0, 2))).toEqual([4, 0]);
    // An unlit building keeps bucket 0, so its windows never glow whatever the bucket was.
    expect(Array.from(g.getAttribute('glow').array.slice(0, 4))).toEqual([Math.fround(1.4), 5, 0, 0]);
  });

  it('shares one material between every model of a pack', () => {
    const { statics } = city();
    const a = model();
    const b = model(2);
    statics.add(placement(a, 0, 0), a, 'suburban', look);
    statics.add(placement(b, 0, 0), b, 'suburban', look);
    const [p, q] = statics.meshes;
    expect(p!.material).toBe(q!.material);
    const roads = model();
    statics.add(placement(roads, 0, 0), roads, 'roads', look);
    expect(statics.meshes.at(-1)!.material).not.toBe(p!.material);
  });

  it('draws a flat plot through the same pool however many there are', () => {
    const { statics } = city();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial();
    for (let i = 0; i < 10; i++) {
      const plot = new THREE.Mesh(geometry, material);
      plot.rotation.x = -Math.PI / 2;
      plot.position.set(i, 0.006, 0);
      statics.addMesh(plot);
    }
    expect(statics.meshes).toHaveLength(1);
    expect(statics.meshes[0]!.count).toBe(10);
  });

  it('gives the windows of each bucket the glow the hour sets', () => {
    const { statics } = city();
    statics.setWindows([0, 1, 2, 3, 4, 5, 6, 7]);
    const m = model();
    statics.add(placement(m, 0, 0), m, 'commercial', look);
    const material = statics.meshes[0]!.material as THREE.MeshStandardMaterial;
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '', fragmentShader: '' };
    // The program's text is whatever three.js has for the standard material; only the includes matter here.
    shader.vertexShader = '#include <common>\n#include <uv_vertex>';
    shader.fragmentShader = '#include <common>\n#include <map_fragment>\n#include <emissivemap_fragment>';
    material.onBeforeCompile(shader as never, null as never);
    expect(Array.from(shader.uniforms.windowOn!.value as Float32Array)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(shader.fragmentShader).toContain('sampler2DArray');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance *= vGlow');
    expect(shader.vertexShader).toContain('windowOn[int(glow.y + 0.5)]');
  });

  it('patches chunks the standard material really has', () => {
    // If three.js renames one of these, the patch would silently do nothing and every building would draw plain.
    const { vertexShader, fragmentShader } = THREE.ShaderLib.standard;
    for (const chunk of ['common', 'uv_vertex']) expect(vertexShader).toContain(`#include <${chunk}>`);
    for (const chunk of ['common', 'map_fragment', 'emissivemap_fragment'])
      expect(fragmentShader).toContain(`#include <${chunk}>`);
  });
});
