// A walk cycle baked into a texture, so walkers can be instanced. A skinned mesh cannot be: each one carries its own
// bones. Instead the cycle is skinned once per model at evenly spaced moments of the loop and kept as vertex positions
// and normals; the vertex shader picks the moment from one shared clock and a phase for each walker.
import * as THREE from 'three';

/** Moments of the loop that are baked. The clip has 20 keys, so this keeps its motion. */
export const WALK_FRAMES = 20;

export interface WalkBake {
  frames: number;
  vertices: number;
  /** RGBA floats `vertices` wide. Rows 0 to frames - 1 hold positions, rows frames to 2 * frames - 1 normals. */
  texels: Float32Array;
}

/**
 * Skin every skinned mesh under `root` at `frames` evenly spaced moments of `clip`, in `root`'s own space so one
 * instance matrix places the whole walker. `root` is posed by this, so pass a copy.
 */
export function bakeWalk(
  root: THREE.Object3D,
  clip: THREE.AnimationClip,
  frames = WALK_FRAMES,
): { mesh: THREE.SkinnedMesh; bake: WalkBake }[] {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((n) => {
    if ((n as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(n as THREE.SkinnedMesh);
  });
  const out = meshes.map((mesh) => {
    const vertices = mesh.geometry.getAttribute('position').count;
    return { mesh, bake: { frames, vertices, texels: new Float32Array(vertices * frames * 2 * 4) } };
  });
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const rootInverse = new THREE.Matrix4();
  const bone = new THREE.Matrix4();
  const skin = new THREE.Matrix4();
  const place = new THREE.Matrix4();
  const full = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    mixer.setTime((f * clip.duration) / frames);
    root.updateMatrixWorld(true);
    rootInverse.copy(root.matrixWorld).invert();
    for (const { mesh, bake } of out) {
      const g = mesh.geometry;
      const position = g.getAttribute('position');
      const normals = g.getAttribute('normal');
      const index = g.getAttribute('skinIndex');
      const weight = g.getAttribute('skinWeight');
      const bones = mesh.skeleton.bones.map((b, i) =>
        bone.multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i]!).clone(),
      );
      // The mesh's skinning, as three.js's own shader does it: into the bind pose, through the bones, back out.
      place.multiplyMatrices(rootInverse, mesh.matrixWorld).multiply(mesh.bindMatrixInverse);
      const e = skin.elements;
      for (let v = 0; v < bake.vertices; v++) {
        e.fill(0);
        for (let k = 0; k < 4; k++) {
          const w = weight.getComponent(v, k);
          if (w === 0) continue;
          const m = bones[index.getComponent(v, k)]!.elements;
          for (let i = 0; i < 16; i++) e[i]! += w * m[i]!;
        }
        full.multiplyMatrices(place, skin).multiply(mesh.bindMatrix);
        point.fromBufferAttribute(position, v).applyMatrix4(full);
        normal.fromBufferAttribute(normals, v).transformDirection(full);
        bake.texels.set([point.x, point.y, point.z, 1], (f * bake.vertices + v) * 4);
        bake.texels.set([normal.x, normal.y, normal.z, 0], ((frames + f) * bake.vertices + v) * 4);
      }
    }
  }
  return out;
}

/** Where in its cycle (0 to 1) the walker `resident` starts, spread so a crowd does not step together. */
export function walkPhase(resident: number): number {
  return (resident * 0.6180339887498949) % 1;
}

/** The shared clock walkers read: how far through the cycle, 0 to 1. */
export interface WalkClock {
  value: number;
}

// Positions and normals come from the baked texture instead of the bones. The two frames either side of the moment
// are blended, so the loop is smooth between the baked ones.
const VERTEX_PARS = /* glsl */ `
attribute float vertexId;
attribute float phase;
uniform highp sampler2D walkTexels;
uniform float walkFrames;
uniform float walkAt;
float walkFrame;
ivec3 walkPick() {
  float at = fract(walkAt + phase) * walkFrames;
  float whole = floor(at);
  walkFrame = at - whole;
  return ivec3(int(vertexId + 0.5), int(whole), int(mod(whole + 1.0, walkFrames)));
}
vec3 walkFetch(ivec3 pick, int rowBase) {
  vec3 a = texelFetch(walkTexels, ivec2(pick.x, rowBase + pick.y), 0).xyz;
  vec3 b = texelFetch(walkTexels, ivec2(pick.x, rowBase + pick.z), 0).xyz;
  return mix(a, b, walkFrame);
}`;

/**
 * `source` with its vertices and normals read from `bake`, at the cycle position `clock` holds plus each instance's
 * `phase`. Every walker's material shares one shader, and holds its own texture.
 */
export function walkMaterial(source: THREE.MeshStandardMaterial, bake: WalkBake, clock: WalkClock) {
  const texture = new THREE.DataTexture(bake.texels, bake.vertices, bake.frames * 2, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  const material = source.clone();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.walkTexels = { value: texture };
    shader.uniforms.walkFrames = { value: bake.frames };
    shader.uniforms.walkAt = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace(
        '#include <beginnormal_vertex>',
        'ivec3 walking = walkPick();\nvec3 objectNormal = walkFetch(walking, int(walkFrames));',
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = walkFetch(walking, 0);');
  };
  material.customProgramCacheKey = () => 'walk';
  return { material, texture };
}
