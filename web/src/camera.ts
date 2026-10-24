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

/** How long the opening drift from above takes. */
const INTRO_MS = 2000;

/**
 * Start the camera high and pulled back and let it settle onto the framing it has now, ending early when the person
 * takes the controls. Call `step` every frame with the time; it returns false once the drift is over.
 */
export function startIntro(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  now: number,
): { step(now: number): boolean } {
  const target = controls.target.clone();
  const final = camera.position.clone().sub(target);
  const start = new THREE.Vector3(final.x * 1.5, final.y * 2.4, final.z * 1.5);
  let over = false;
  controls.addEventListener('start', () => (over = true));
  const place = (e: number) => camera.position.copy(target).add(start.clone().lerp(final, e));
  place(0);
  return {
    step(t) {
      if (over) return false;
      const p = Math.min(1, (t - now) / INTRO_MS);
      place(1 - (1 - p) ** 3);
      return p < 1;
    },
  };
}
