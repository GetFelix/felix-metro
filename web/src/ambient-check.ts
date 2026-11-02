// Dev page for CI and for looking at the ambient life: a generated city drawn at the ticks given in the URL, one after
// another in this page, with what each frame held and a hash of its pixels. scripts/check-ambient.mjs asks for a tick,
// other ticks, and the first tick again, and wants the first and last frames to match.
//   ?ticks=2640,3000,2640  ?tier=high|medium|low  ?look=city|shop|stack|roost|crossing|vehicle  ?ambient=0
//   ?draw=0 only counts what each tick holds, which is quick enough to sweep a day.
import * as THREE from 'three';
import init, { generate } from './core/felix_metro_core.js';
import { parseCity } from './layout';
import { cityBounds } from './camera-math';
import { createCamera } from './camera';
import { createCity } from './scene';
import { createPost, passesFor } from './post';
import { createRenderer } from './renderer';
import { settingsFor } from './quality';
import { Traffic } from './traffic';
import { hourOf } from './ambient';
import type { AmbientCounts } from './ambient-fx';

export interface AmbientFrame {
  tick: number;
  counts: AmbientCounts | null;
  /** A hash of the frame's pixels. */
  hash: number;
  /** The share of pixels that differ from the first frame drawn at this tick. */
  differs: number;
}

declare global {
  interface Window {
    __ready?: boolean;
    __ambient?: { frames: AmbientFrame[]; focus: unknown; updateMs: number };
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  const ticks = (params.get('ticks') ?? '2640').split(',').map(Number);
  const tier = (['high', 'medium', 'low'] as const).find((t) => t === params.get('tier')) ?? 'medium';
  const look = params.get('look') ?? 'city';
  const draw = params.get('draw') !== '0';
  await init();
  const city = parseCity(generate('harbor', 2));
  const renderer = createRenderer(tier);
  const span = Math.max(1, city.tiles / 17);
  const { camera, controls } = createCamera(
    renderer.domElement,
    span * 1.2,
    new THREE.Vector3(),
    cityBounds(city.tiles),
  );
  const { scene, glows, setTime, setShadows, fleet, ambient } = await createCity(
    renderer,
    tier,
    city,
    true,
    new Map(),
    params.get('ambient') !== '0',
  );
  const s = settingsFor(tier);
  setShadows(s.shadows, s.shadowMapSize);
  const post = createPost(renderer, scene, camera, passesFor(tier), glows);
  const traffic = new Traffic(fleet!, (city.tiles - 1) / 2, city.lots);
  if (ambient) traffic.extras = (f) => ambient.place(f);

  const target = controls.target;
  // The first tick's update first, so a vehicle is on the road to look at.
  ambient?.update(ticks[0]!);
  const focus = ambient?.focus() ?? {};
  const at = look === 'city' ? null : (focus as Record<string, [number, number, number] | undefined>)[look];
  if (at) {
    target.set(at[0], at[1], at[2]);
    camera.position.set(at[0] + 1.8, at[1] + 1.8, at[2] + 2.4);
  }
  camera.lookAt(target);
  fleet!.view(camera);

  const gl = renderer.getContext();
  const size = gl.drawingBufferWidth * gl.drawingBufferHeight * 4;
  const first = new Map<number, Uint8Array>();
  const frames: AmbientFrame[] = [];
  for (const tick of ticks) {
    setTime(hourOf(tick), post.bloom);
    ambient?.update(tick);
    traffic.update(tick, 0, []);
    if (!draw) {
      frames.push({ tick, counts: ambient ? { ...ambient.counts() } : null, hash: 0, differs: 0 });
      continue;
    }
    post.render(target);
    const pixels = new Uint8Array(size);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 5381;
    for (let i = 0; i < size; i += 7) hash = (Math.imul(hash, 33) ^ pixels[i]!) >>> 0;
    const before = first.get(tick);
    let differs = 0;
    if (before) {
      let n = 0;
      for (let i = 0; i < size; i += 4)
        if (before[i] !== pixels[i] || before[i + 1] !== pixels[i + 1] || before[i + 2] !== pixels[i + 2]) n++;
      differs = n / (size / 4);
    } else first.set(tick, pixels);
    frames.push({ tick, counts: ambient ? { ...ambient.counts() } : null, hash, differs });
  }
  // What a frame's update costs the page, in ms, from a few hundred updates a fraction of a tick apart.
  let updateMs = 0;
  if (ambient) {
    const runs = 300;
    const began = performance.now();
    for (let i = 0; i < runs; i++) {
      ambient.update(ticks[0]! + i * 0.07);
      traffic.update(ticks[0]! + i * 0.07, 0, []);
    }
    updateMs = (performance.now() - began) / runs;
  }
  window.__ambient = { frames, focus, updateMs };
  window.__ready = true;
}

main().catch((e) => {
  console.error('the ambient page could not start', e);
  document.body.dataset.error = String(e);
});
