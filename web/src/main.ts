import * as THREE from 'three';
import { createCamera } from './camera';
import { createHud } from './hud';
import { parseParams, type Tier } from './params';
import { createPost, passesFor } from './post';
import { createQuality, settingsFor } from './quality';
import { createRenderer } from './renderer';
import { createCity, move } from './scene';

declare global {
  interface Window {
    /** True once the first frame is drawn with every model loaded. */
    __ready?: boolean;
  }
}

async function main() {
  const { frozenHour, still, tier: urlTier, ui, hud: showHud } = parseParams(location.search);
  if (!ui) document.querySelectorAll('.chip').forEach((e) => e.classList.add('hidden'));

  let post: ReturnType<typeof createPost> | null = null;
  let hour = 18.5;
  let apply: (tier: Tier) => void = () => {};
  const quality = createQuality({ url: urlTier, still, onChange: (t) => apply(t) });

  const renderer = createRenderer(quality.tier);
  const { camera, controls } = createCamera(renderer.domElement);
  const { scene, cars, people, glows, setTime, setShadows } = await createCity(renderer, quality.tier);
  const hud = showHud ? createHud(renderer, quality) : null;

  // A tier change rebuilds the post chain; shadows and resolution follow the same settings.
  apply = (tier) => {
    const s = settingsFor(tier);
    post?.dispose();
    renderer.setPixelRatio(Math.min(devicePixelRatio, s.pixelRatioCap));
    setShadows(s.shadows, s.shadowMapSize);
    post = createPost(renderer, scene, camera, passesFor(tier), glows);
    setTime(hour, post.bloom);
  };

  const slider = document.getElementById('hour') as HTMLInputElement;
  hour = frozenHour ?? parseFloat(slider.value);
  slider.value = String(hour);
  slider.addEventListener('input', () => {
    hour = parseFloat(slider.value);
    setTime(hour, post!.bloom);
  });
  post = createPost(renderer, scene, camera, passesFor(quality.tier), glows);
  setTime(hour, post.bloom);

  const clock = new THREE.Clock();
  let last = performance.now();
  function frame() {
    const now = performance.now();
    const frameMs = now - last;
    last = now;
    quality.tick(frameMs);
    hud?.frame(frameMs);
    const dt = still ? 0 : Math.min(clock.getDelta(), 0.05);
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    controls.update();
    post!.render(controls.target);
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
    post!.resize();
  });
}

main();
