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
    /** Tier history and GPU memory per tier, for the CI step-down check. Only set under ?slow or ?hud. */
    __quality?: {
      history: readonly Tier[];
      memory: { tier: Tier; textures: number; geometries: number }[];
    };
  }
}

async function main() {
  const { frozenHour, still, tier: urlTier, ui, hud: showHud, slow } = parseParams(location.search);
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

  addEventListener('visibilitychange', () => quality.restartWindow());

  // Memory is read once per tier, after that tier has rendered, so freed passes show up as lower counts.
  const memory: NonNullable<Window['__quality']>['memory'] = [];
  if (slow || showHud) window.__quality = { history: quality.history, memory };

  const clock = new THREE.Clock();
  let last = performance.now();
  function frame() {
    const now = performance.now();
    const frameMs = now - last;
    last = now;
    quality.tick(frameMs);
    hud?.frame(frameMs);
    if (slow) for (const end = performance.now() + slow; performance.now() < end; );
    const dt = still ? 0 : Math.min(clock.getDelta(), 0.05);
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    controls.update();
    post!.render(controls.target);
    if (window.__quality && memory[memory.length - 1]?.tier !== quality.tier) {
      const { textures, geometries } = renderer.info.memory;
      memory.push({ tier: quality.tier, textures, geometries });
    }
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
