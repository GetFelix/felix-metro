import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** `span` widens the view for a city bigger than the style frame's map; `centre` is the point it looks at. */
export function createCamera(dom: HTMLElement, span = 1, centre = new THREE.Vector3(0.4, 0, 0.8)) {
  const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(11.1 * span, 9.6 * span, 12.2 * span).add(centre);
  const controls = new OrbitControls(camera, dom);
  controls.target.copy(centre);
  controls.enableDamping = true;
  controls.minPolarAngle = 0.5;
  controls.maxPolarAngle = 1.15;
  controls.minDistance = 8;
  controls.maxDistance = 40 * span;
  controls.update();
  return { camera, controls };
}
