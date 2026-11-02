// A small rigged walker for tests: a body skinned to two bones, the upper one swinging a quarter turn and back.
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** The upper bone's angle about Z (radians) at 0, 1/4, 1/2 and 3/4 of the clip. */
export const SWING = [0, Math.PI / 4, Math.PI / 2, Math.PI / 4];

export function walker(): GLTF {
  const scene = new THREE.Group();
  const hip = new THREE.Bone();
  const arm = new THREE.Bone();
  arm.name = 'arm';
  arm.position.set(0, 1, 0);
  hip.add(arm);
  // Three vertices: one on the hip, one on the arm, and one between them, half on each.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 0.5, 0.5, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(0, 2, 0);
  mesh.add(hip);
  mesh.bind(new THREE.Skeleton([hip, arm]));
  scene.add(mesh);
  const turn = (angle: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, angle)).toArray();
  const clip = new THREE.AnimationClip('walk', 1, [
    new THREE.QuaternionKeyframeTrack(
      'arm.quaternion',
      [0, 0.25, 0.5, 0.75, 1],
      [...turn(0), ...turn(SWING[1]!), ...turn(SWING[2]!), ...turn(SWING[3]!), ...turn(0)].flat(),
    ),
  ]);
  return { scene, animations: [clip] } as unknown as GLTF;
}
