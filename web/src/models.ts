import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { modelUrl, type Pack } from './assets';

const LOT = 0.9;
const loader = new GLTFLoader();
const loaded = new Map<string, Promise<GLTF>>();

// One load per file, however many times it is placed.
export async function loadModel(pack: Pack, name: string): Promise<GLTF> {
  const url = await modelUrl(pack, name);
  let gltf = loaded.get(url);
  if (!gltf) {
    gltf = loader.loadAsync(url);
    loaded.set(url, gltf);
  }
  return gltf;
}

// A rigged model needs its skeleton rebuilt for the copy, or every copy would share one pose.
export function cloneModel(gltf: GLTF): THREE.Object3D {
  let rigged = false;
  gltf.scene.traverse((n) => {
    if ((n as THREE.SkinnedMesh).isSkinnedMesh) rigged = true;
  });
  return rigged ? SkeletonUtils.clone(gltf.scene) : gltf.scene.clone(true);
}

// Some Kenney buildings are wider than a tile; shrink those to fit their lot. Call once position, rotation and scale
// are set.
export function fitToLot(pack: Pack, o: THREE.Object3D) {
  if (pack !== 'commercial' && pack !== 'suburban' && pack !== 'industrial') return;
  const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
  const widest = Math.max(size.x, size.z);
  if (widest > LOT) o.scale.multiplyScalar(LOT / widest);
}

// A lot's front turns toward a neighbouring road. Kenney fronts face +Z.
export function facing(x: number, z: number, isRoad: (v: number) => boolean, pick: <T>(a: readonly T[]) => T): number {
  const options: number[] = [];
  if (isRoad(x + 1)) options.push(Math.PI / 2);
  if (isRoad(x - 1)) options.push(-Math.PI / 2);
  if (isRoad(z + 1)) options.push(0);
  if (isRoad(z - 1)) options.push(Math.PI);
  return options.length ? pick(options) : pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
}
