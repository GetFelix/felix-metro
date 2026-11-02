import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cloneModel } from './models';
import { SWING, walker } from './walk-fixture';
import { WALK_FRAMES, bakeWalk, walkMaterial, walkPhase } from './walk';

/** One baked row: the `i`th vertex's xyz at `row`. */
const at = (texels: Float32Array, width: number, row: number, i: number) => {
  const o = (row * width + i) * 4;
  return [texels[o]!, texels[o + 1]!, texels[o + 2]!];
};

describe('bakeWalk', () => {
  const model = walker();
  const { mesh, bake } = bakeWalk(cloneModel(model), model.animations[0]!, 4)[0]!;

  it('bakes every vertex at every frame, positions then normals', () => {
    expect(bake).toMatchObject({ frames: 4, vertices: 3 });
    expect(bake.texels).toHaveLength(3 * 4 * 2 * 4);
    expect(mesh.isSkinnedMesh).toBe(true);
  });

  it('puts each vertex where its bones carry it, in the model’s own space', () => {
    for (let f = 0; f < 4; f++) {
      const a = SWING[f]!;
      // On the hip: stays where it was bound, two up from the model's origin.
      expect(at(bake.texels, 3, f, 0)).toEqual([0, 2, 0].map((v) => expect.closeTo(v, 5)));
      // On the arm: swung about the arm's joint, one above the hip.
      expect(at(bake.texels, 3, f, 1)).toEqual([Math.cos(a), 3 + Math.sin(a), 0].map((v) => expect.closeTo(v, 5)));
    }
  });

  it('turns the normals with the bones', () => {
    for (let f = 0; f < 4; f++) {
      const a = SWING[f]!;
      expect(at(bake.texels, 3, 4 + f, 0)).toEqual([0, 0, 1].map((v) => expect.closeTo(v, 5)));
      expect(at(bake.texels, 3, 4 + f, 1)).toEqual([Math.cos(a), Math.sin(a), 0].map((v) => expect.closeTo(v, 5)));
    }
  });

  it('agrees with three.js skinning, including a vertex shared by two bones', () => {
    const copy = cloneModel(model);
    const mixer = new THREE.AnimationMixer(copy);
    mixer.clipAction(model.animations[0]!).play();
    const skinned = copy.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    for (let f = 0; f < 4; f++) {
      mixer.setTime(f / 4);
      copy.updateMatrixWorld(true);
      for (let v = 0; v < 3; v++) {
        const expected = skinned.getVertexPosition(v, new THREE.Vector3()).applyMatrix4(skinned.matrixWorld);
        expect(at(bake.texels, 3, f, v)).toEqual(expected.toArray().map((n) => expect.closeTo(n, 5)));
      }
    }
  });

  it('bakes into the root’s space wherever the root stands', () => {
    const moved = cloneModel(model);
    moved.position.set(5, 0, -3);
    moved.rotation.y = 1;
    const again = bakeWalk(moved, model.animations[0]!, 4)[0]!.bake;
    expect(Array.from(again.texels)).toEqual(Array.from(bake.texels).map((n) => expect.closeTo(n, 5)));
  });

  it('bakes the clip’s own length of moments by default', () => {
    expect(bakeWalk(cloneModel(model), model.animations[0]!)[0]!.bake.frames).toBe(WALK_FRAMES);
  });
});

describe('walkPhase', () => {
  it('is a fraction of the cycle that is the same for a resident every time', () => {
    for (const r of [0, 1, 7, 522, 20_000]) {
      expect(walkPhase(r)).toBeGreaterThanOrEqual(0);
      expect(walkPhase(r)).toBeLessThan(1);
      expect(walkPhase(r)).toBe(walkPhase(r));
    }
  });

  it('spreads neighbours apart, so a crowd does not step together', () => {
    const phases = Array.from({ length: 100 }, (_, r) => walkPhase(r));
    for (let r = 1; r < phases.length; r++) expect(Math.abs(phases[r]! - phases[r - 1]!)).toBeGreaterThan(0.1);
  });
});

describe('walkMaterial', () => {
  const { bake } = bakeWalk(cloneModel(walker()), walker().animations[0]!, 4)[0]!;
  const source = new THREE.MeshStandardMaterial({ roughness: 0.82 });
  const clock = { value: 0 };
  const { material, texture } = walkMaterial(source, bake, clock);

  it('leaves the material it was given alone', () => {
    expect(material).not.toBe(source);
    expect(material.roughness).toBe(0.82);
    expect(source.onBeforeCompile.toString()).not.toContain('walkTexels');
  });

  it('holds the bake as a texture a vertex id and a frame pick a texel of', () => {
    expect(texture.image).toMatchObject({ width: 3, height: 8 });
    expect(texture.magFilter).toBe(THREE.NearestFilter);
  });

  it('reads vertices and normals from it, with the cycle position every walker shares', () => {
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).not.toContain('#include <begin_vertex>');
    expect(shader.vertexShader).not.toContain('#include <beginnormal_vertex>');
    expect(shader.vertexShader).toContain('vec3 transformed = walkFetch(walking, 0);');
    expect(shader.uniforms.walkAt).toBe(clock);
    expect(shader.uniforms.walkTexels!.value).toBe(texture);
    expect(shader.uniforms.walkFrames!.value).toBe(4);
    // One program for every walker, each with its own texture.
    expect(material.customProgramCacheKey()).toBe('walk');
  });
});
