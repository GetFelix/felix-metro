import * as THREE from 'three';
import { createCamera } from './camera';
import { parseParams } from './params';
import { createPost, passesFor } from './post';
import { createRenderer } from './renderer';
import { createCity, move } from './scene';

declare global {
  interface Window {
    /** True once the first frame is drawn with every model loaded. */
    __ready?: boolean;
  }
}

async function main() {
  const { frozenHour, still, tier, ui } = parseParams(location.search);
  if (!ui) document.querySelectorAll('.chip').forEach((e) => e.classList.add('hidden'));

  const renderer = createRenderer(tier);
  const { camera, controls } = createCamera(renderer.domElement);
  const { scene, cars, people, glows, setTime } = await createCity(renderer, tier);
  const { bloom, render, resize } = createPost(renderer, scene, camera, passesFor(tier), glows);

  const slider = document.getElementById('hour') as HTMLInputElement;
  let hour = frozenHour ?? parseFloat(slider.value);
  slider.value = String(hour);
  slider.addEventListener('input', () => {
    hour = parseFloat(slider.value);
    setTime(hour, bloom);
  });
  setTime(hour, bloom);

  const clock = new THREE.Clock();
  function frame() {
    const dt = still ? 0 : Math.min(clock.getDelta(), 0.05);
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    controls.update();
    render(controls.target);
    requestAnimationFrame(frame);
  }
  move(cars, 0, true);
  move(people, 0, false);
  frame();
  document.body.dataset.ready = '1';
  window.__ready = true;

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    resize();
  });
}

main();
