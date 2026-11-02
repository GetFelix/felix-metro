// Instanced meshes that fill from empty each frame, and the billboard sprites that car lights are drawn with.
import * as THREE from 'three';

const FIRST_CAPACITY = 64;

/**
 * One geometry and material drawn many times as a single call. `next` hands out the next free instance, and `finish`
 * says how many were used and what to upload. The buffer doubles when it fills; the mesh itself stays the same object,
 * so a list that holds it (the glows the ambient occlusion pass hides) never goes stale.
 */
export class Batch {
  readonly mesh: THREE.InstancedMesh;
  private capacity = FIRST_CAPACITY;
  private used = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    /** A per-instance attribute next to the matrix, such as a walk phase, with its number of floats. */
    private readonly extra?: { name: string; size: number },
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, FIRST_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Every instance is placed by the caller, which knows what is in view.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    if (extra) geometry.setAttribute(extra.name, this.makeExtra());
  }

  get count(): number {
    return this.used;
  }

  /** The instance matrices, `16` floats an instance. */
  get matrices(): Float32Array {
    return this.mesh.instanceMatrix.array as Float32Array;
  }

  /** The per-instance values `extra` named. */
  get values(): Float32Array {
    return this.mesh.geometry.getAttribute(this.extra!.name).array as Float32Array;
  }

  clear(): void {
    this.used = 0;
  }

  /** The index of a new instance. */
  next(): number {
    if (this.used === this.capacity) this.grow();
    return this.used++;
  }

  /** Draw the instances handed out since `clear`, and upload only those. */
  finish(): void {
    this.mesh.count = this.used;
    const upload = (a: THREE.BufferAttribute, size: number) => {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.used * size);
      a.needsUpdate = true;
    };
    upload(this.mesh.instanceMatrix, 16);
    if (this.extra) upload(this.mesh.geometry.getAttribute(this.extra.name) as THREE.BufferAttribute, this.extra.size);
  }

  private makeExtra(from?: Float32Array) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * this.extra!.size), this.extra!.size);
    if (from) a.array.set(from);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }

  private grow(): void {
    const matrices = this.matrices;
    const values = this.extra ? this.values : undefined;
    this.capacity *= 2;
    // Frees the buffers the old arrays were uploaded as; the new ones are made on the next draw.
    this.mesh.dispose();
    if (this.extra) this.mesh.geometry.dispose();
    const bigger = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 16), 16);
    bigger.array.set(matrices);
    bigger.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix = bigger;
    if (this.extra) this.mesh.geometry.setAttribute(this.extra.name, this.makeExtra(values));
  }
}

// A sprite that faces the camera and keeps its size in the world, as THREE.Sprite does, but placed by an instance
// matrix: the matrix's translation is where it hangs and the length of its first two columns is its width and height.
const SPRITE_VERTEX = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 size = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  mvPosition.xy += position.xy * size;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 texel = texture2D(map, vUv);
  gl_FragColor = vec4(texel.rgb, texel.a * opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** An additive glow drawn from `map`. Its brightness is `opacity`, a uniform, so setting it needs no recompile. */
export function glowMaterial(map: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: map }, opacity: { value: 0 } }]),
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** A unit square for {@link glowMaterial}, the same quad THREE.Sprite draws. */
export function glowGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1);
}
