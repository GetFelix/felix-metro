// The generated city's buildings, road tiles, trees and props, drawn as instances. Each model part has one pool, and a
// placement is an instance in it, so the draw calls follow the number of different parts and not the size of the city.
//
// The look of a placement is per instance, not per material: the pack's colormap is a texture array with the original
// in layer 0 and a recolouring for each wall and roof choice after it, and a window's lit level and light-hour bucket
// are instance attributes. One material per pack therefore covers every building of the pack.
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Pack } from './assets';
import { WINDOW_BUCKETS } from './daylight';
import { InstancePool, type Instance } from './instance-pool';
import { colormapPixels, variantPixels, windowMask, VARIANTS } from './materials';
import { PALETTE } from './palette';
import { parts } from './fleet';

/** What a placement looks like beyond its model: the wall and roof choice, and how its windows light. */
export interface Look {
  /** The wall and roof choice, or -1 for the model's own colours. */
  variant: number;
  /** How strongly the windows glow at night; 0 for a model with none lit. */
  lit: number;
  /** Which light-hour bucket the windows follow. */
  bucket: number;
}

interface Placed {
  pool: InstancePool;
  instance: Instance;
  /** Where the part sits in its model. */
  local: THREE.Matrix4;
}

/** The meshes of a model, found once. */
const partsOf = new WeakMap<GLTF, ReturnType<typeof parts>>();

const scratch = new THREE.Matrix4();

// A texture array of the colormap and its recolourings, and the mask of its window swatches, for one pack.
interface PackTextures {
  colors: THREE.DataArrayTexture;
  mask: THREE.Texture;
}

// The recolourings are only for packs whose models are told apart by them: buildings.
function arrayTexture(source: THREE.Texture, recoloured: boolean): THREE.DataArrayTexture {
  const first = colormapPixels(source);
  const { width, height } = first;
  const layers = recoloured ? 1 + VARIANTS : 1;
  const data = new Uint8Array(width * height * 4 * layers);
  data.set(first.data, 0);
  for (let v = 0; v < layers - 1; v++) data.set(variantPixels(source, v).data, width * height * 4 * (v + 1));
  const t = new THREE.DataArrayTexture(data, width, height, layers);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// The standard material with its colour read from the texture array and its window glow scaled per instance.
function packMaterial(source: THREE.Texture, textures: PackTextures, windowOn: Float32Array, windows: boolean) {
  const m = new THREE.MeshStandardMaterial({
    // Only so the shader defines the colour map's uv; the colour itself comes from the array.
    map: source,
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.45,
  });
  if (windows) {
    m.emissiveMap = textures.mask;
    m.emissive = PALETTE.window.clone();
  }
  m.customProgramCacheKey = () => `static-city:${windows}`;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.mapArray = { value: textures.colors };
    shader.uniforms.windowOn = { value: windowOn };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float variant;
attribute vec2 glow;
uniform float windowOn[${WINDOW_BUCKETS}];
varying float vVariant;
varying float vGlow;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vVariant = variant;
vGlow = glow.x * windowOn[int(glow.y + 0.5)];`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform highp sampler2DArray mapArray;
varying float vVariant;
varying float vGlow;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec4 sampledDiffuseColor = texture(mapArray, vec3(vMapUv, floor(vVariant + 0.5)));
diffuseColor *= sampledDiffuseColor;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance *= vGlow;`,
      );
  };
  return m;
}

/** Packs whose models have lit windows. */
const WITH_WINDOWS: ReadonlySet<Pack> = new Set(['commercial', 'suburban', 'industrial']);

export class StaticCity {
  /** The pools' meshes. */
  readonly group = new THREE.Group();
  /**
   * The placements as ordinary objects, outside the scene: a lot's objects are still what the page measures, scales
   * for construction and picks with a ray. Nothing in here is ever drawn.
   */
  readonly handles = new THREE.Group();
  private readonly packs = new Map<Pack, { textures: PackTextures; material: THREE.MeshStandardMaterial }>();
  private readonly pools = new Map<string, InstancePool>();
  private readonly placed = new Map<THREE.Object3D, Placed[]>();
  private readonly windowOn = new Float32Array(WINDOW_BUCKETS);

  constructor(
    scene: THREE.Scene,
    private readonly shadows = true,
  ) {
    // The handles group is never added to the scene: three.js walks every child of a scene each frame to update world
    // matrices, which would cost thousands of nodes. A handle's world matrix is worked out when it is placed or
    // changed, and the group's own is the identity.
    scene.add(this.group);
  }

  /** The glow of the windows of each bucket, from `daylight` and `windowSwitch`. */
  setWindows(on: ArrayLike<number>): void {
    this.windowOn.set(on);
  }

  /** Every pool's mesh, for the lists that hide meshes or count them. */
  get meshes(): THREE.InstancedMesh[] {
    return [...this.pools.values()].map((p) => p.mesh);
  }

  /** Draw the model `handle` is a clone of, at the handle's transform. */
  add(handle: THREE.Object3D, model: GLTF, pack: Pack, look: Look): void {
    let found = partsOf.get(model);
    if (!found) partsOf.set(model, (found = parts(model)));
    const entry = this.pack(pack, found[0]!.mesh.material as THREE.MeshStandardMaterial);
    const placed: Placed[] = [];
    handle.updateMatrix();
    for (const { mesh, local } of found) {
      const key = `${pack}/${mesh.geometry.uuid}`;
      let pool = this.pools.get(key);
      if (!pool) {
        pool = new InstancePool(mesh.geometry, entry.material, [
          { name: 'variant', size: 1 },
          { name: 'glow', size: 2 },
        ]);
        pool.mesh.castShadow = this.shadows;
        pool.mesh.receiveShadow = true;
        this.pools.set(key, pool);
        this.group.add(pool.mesh);
      }
      const instance = pool.add(scratch.multiplyMatrices(handle.matrix, local));
      // Layer 0 is the model's own colours; a variant's layer follows it.
      pool.set(instance, 'variant', look.variant + 1);
      pool.set(instance, 'glow', look.lit, look.lit > 0 ? look.bucket : 0);
      placed.push({ pool, instance, local });
    }
    this.placed.set(handle, placed);
    this.handles.add(handle);
    handle.updateMatrixWorld(true);
  }

  /** Draw a plain mesh's geometry and material at the mesh's transform: a flat plot, say. */
  addMesh(mesh: THREE.Mesh, castShadow = false): void {
    const key = `mesh/${mesh.geometry.uuid}/${(mesh.material as THREE.Material).uuid}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new InstancePool(mesh.geometry, mesh.material);
      pool.mesh.castShadow = castShadow;
      pool.mesh.receiveShadow = mesh.receiveShadow;
      this.pools.set(key, pool);
      this.group.add(pool.mesh);
    }
    mesh.updateMatrix();
    const local = new THREE.Matrix4();
    this.placed.set(mesh, [{ pool, instance: pool.add(mesh.matrix), local }]);
    this.handles.add(mesh);
    mesh.updateMatrixWorld(true);
  }

  /** Redraw `handle` after its position, rotation or scale changed. */
  sync(handle: THREE.Object3D): void {
    const placed = this.placed.get(handle);
    if (!placed) return;
    handle.updateMatrix();
    handle.updateMatrixWorld(true);
    for (const p of placed) {
      p.pool.setMatrix(p.instance, scratch.multiplyMatrices(handle.matrix, p.local));
    }
  }

  /** Whether `handle` is drawn by this. */
  has(handle: THREE.Object3D): boolean {
    return this.placed.has(handle);
  }

  remove(handle: THREE.Object3D): void {
    const placed = this.placed.get(handle);
    if (!placed) return;
    this.placed.delete(handle);
    for (const p of placed) p.pool.remove(p.instance);
    this.handles.remove(handle);
  }

  dispose(): void {
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
    for (const { textures, material } of this.packs.values()) {
      textures.colors.dispose();
      textures.mask.dispose();
      material.dispose();
    }
    this.packs.clear();
  }

  private pack(pack: Pack, source: THREE.MeshStandardMaterial) {
    let entry = this.packs.get(pack);
    if (!entry) {
      const map = source.map!;
      map.magFilter = THREE.NearestFilter;
      map.anisotropy = 8;
      const textures = {
        colors: arrayTexture(map, WITH_WINDOWS.has(pack)),
        mask: WITH_WINDOWS.has(pack) ? windowMask(map) : map,
      };
      entry = { textures, material: packMaterial(map, textures, this.windowOn, WITH_WINDOWS.has(pack)) };
      this.packs.set(pack, entry);
    }
    return entry;
  }
}
