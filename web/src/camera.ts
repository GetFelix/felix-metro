import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createCamera(dom: HTMLElement) {
  const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(11.5, 9.6, 13.0);
  const controls = new OrbitControls(camera, dom);
  controls.target.set(0.4, 0, 0.8);
  controls.enableDamping = true;
  controls.minPolarAngle = 0.5;
  controls.maxPolarAngle = 1.15;
  controls.minDistance = 8;
  controls.maxDistance = 40;
  controls.update();
  return { camera, controls };
}
