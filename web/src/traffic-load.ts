// Dev page for CI and for measuring: a generated city with N cars and walkers going back and forth along its roads,
// drawn through the real post chain, with the draw calls and frame times of the frames it drew. Read by
// scripts/check-traffic.mjs.
//   ?n=200 movers (half cars, half walkers)  ?tier=high|medium|low  ?t=12 hour  ?frames=30  ?shadows=0
//   ?ambient=0 leaves the ambient life out, to measure what it costs; it runs by default, at the hour ?t=
//   ?show=1 draws one car and one walker standing outside the city, close up, once, for a picture to compare;
//   ?walk=0.3 is how many seconds the walkers' clock has run, ?t= the hour
//   ?districts=4 is the districts a side of the city has (2 by default; 4 is the 16 districts of the scale goal)
//   ?run=1 keeps drawing and shows the frame rate on the page, for measuring on a real GPU; ?cap=tier then holds the
//   movers drawn to the tier's cap, as the live page does, instead of drawing every one asked for
import * as THREE from 'three';
import init, { generate } from './core/felix_metro_core.js';
import { parseCity } from './layout';
import { cityBounds } from './camera-math';
import { createCamera } from './camera';
import { createCity } from './scene';
import { createPost, passesFor } from './post';
import { createRenderer } from './renderer';
import { settingsFor } from './quality';
import { TICKS_PER_HOUR } from './clock';
import { Traffic } from './traffic';
import type { Journey, Voyage } from './city';

export interface TrafficLoad {
  movers: number;
  cars: number;
  walkers: number;
  /** Draw calls and triangles of the last frame, the shadow pass and the post chain included. */
  calls: number;
  triangles: number;
  geometries: number;
  /** Median ms of a frame's traffic update and render calls, which is the CPU's share. */
  submitMs: number;
  /** Median ms of the same frame once the GPU (or SwiftShader) has finished it. */
  frameMs: number;
}

declare global {
  interface Window {
    __ready?: boolean;
    __load?: TrafficLoad;
    /** The renderer and scene, and one frame of the post chain, for scripts that count draws pass by pass. */
    __three?: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; frame: () => void };
  }
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;

/** A trip along a line of tiles, back and forth for ever, so the voyage never ends and never jumps. */
function shuttle(x0: number, z0: number, alongX: boolean, reach: number, speed: number): Journey {
  const at = (tick: number) => {
    const p = (tick * speed) % (2 * reach);
    return (p < reach ? p : 2 * reach - p) - reach / 2;
  };
  return {
    arrive: () => 1e9,
    positionAt(tick, out) {
      const p = at(tick);
      out[0] = Math.round((x0 + (alongX ? p : 0)) * 1000);
      out[1] = Math.round((z0 + (alongX ? 0 : p)) * 1000);
    },
    lots(out) {
      out[0] = 0;
      out[1] = 0;
    },
    free() {},
  };
}

/** Walkers' resident numbers start here, a multiple of the number of walker models, so they take every model in turn. */
const WALKER_IDS = 1_200_000;

/** Draws frames until the page is closed and writes the frame rate over the city twice a second. */
function run(
  tier: string,
  districts: number,
  asked: number,
  traffic: Traffic,
  step: () => void,
  post: ReturnType<typeof createPost>,
  target: THREE.Vector3,
  renderer: THREE.WebGLRenderer,
) {
  const out = document.createElement('pre');
  out.style.cssText =
    'position:fixed;top:12px;left:12px;margin:0;padding:8px 12px;border-radius:8px;background:#000b;color:#fff;font:13px/1.5 monospace';
  document.body.append(out);
  renderer.info.autoReset = false;
  const ring: number[] = [];
  let last = performance.now();
  let shown = last;
  const frame = (now: number) => {
    ring.push(now - last);
    if (ring.length > 120) ring.shift();
    last = now;
    renderer.info.reset();
    step();
    post.render(target);
    if (now - shown >= 500 && ring.length > 4) {
      shown = now;
      const sorted = [...ring].sort((a, b) => a - b);
      const mid = sorted[sorted.length >> 1]!;
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
      const { calls, triangles } = renderer.info.render;
      out.textContent =
        `${(1000 / mid).toFixed(0)} fps  ${mid.toFixed(1)} ms median  ${p95.toFixed(1)} ms p95\n` +
        `${calls} draws  ${triangles} tris\n` +
        `${traffic.drawn} of ${asked} movers placed  ${districts * districts} districts  tier ${tier}`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__ready = true;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get('n') ?? '100');
  const tier = (['high', 'medium', 'low'] as const).find((t) => t === params.get('tier')) ?? 'high';
  const frames = Number(params.get('frames') ?? '30');
  await init();
  const districts = Math.min(16, Math.max(1, Math.floor(Number(params.get('districts') ?? '2')) || 2));
  const city = parseCity(generate('harbor', districts));
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
    // The close-up picture is of a car and a walker alone.
    params.get('ambient') !== '0' && !params.has('show'),
  );
  const s = settingsFor(tier);
  setShadows(s.shadows && params.get('shadows') !== '0', s.shadowMapSize);
  const post = createPost(renderer, scene, camera, passesFor(tier), glows);
  const hour = Number(params.get('t') ?? '12');
  setTime(hour, post.bloom);
  const half = (city.tiles - 1) / 2;
  const traffic = new Traffic(fleet!, half, city.lots);
  // The tier's cap is what this page measures the cost of, so it does not apply unless asked for.
  traffic.cap = params.get('cap') === 'tier' ? s.movers : Infinity;
  if (ambient) traffic.extras = (f) => ambient.place(f);

  // Trips along the roads, a seeded few tiles each way.
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const roads = city.roads;
  const voyages: Voyage[] = [];
  // Cars cycle through every kind, and walkers through every model: a resident gets the model its number picks.
  let cars = 0;
  let walkers = 0;
  for (let i = 0; i < n; i++) {
    const road = roads[Math.floor(rand() * roads.length)]!;
    const walker = i % 2 === 1;
    voyages.push({
      resident: walker ? WALKER_IDS + walkers++ : i,
      vehicle: walker ? 0 : 1 + (cars++ % 6),
      depart: 0,
      journey: shuttle(road.x, road.z, rand() < 0.5, 6, walker ? 0.15 : 0.35),
    });
  }

  const target = controls.target;
  window.__three = { renderer, scene, frame: () => post.render(target) };
  camera.lookAt(target);
  // The ambient life depends on the hour, so the run starts at it.
  let tick = Math.round(hour * TICKS_PER_HOUR);
  const step = () => {
    tick += 0.25;
    ambient?.update(tick);
    traffic.update(tick, 1 / 60, voyages);
  };

  if (params.has('show')) {
    // A car and a walker side by side on the grass past the city's east edge, still, for a picture.
    const [sx, sz] = (params.get('show') || '1').includes(',')
      ? params.get('show')!.split(',').map(Number)
      : [city.tiles + 1, city.tiles / 2];
    const at = sz!;
    const stand = (resident: number, vehicle: number, x: number): Voyage => ({
      resident,
      vehicle,
      depart: 0,
      journey: { ...shuttle(x, at, true, 1, 0), positionAt: (_t, out) => ((out[0] = x * 1000), (out[1] = at * 1000)) },
    });
    const here = [stand(1, 2, sx! - 0.25), stand(WALKER_IDS + 5, 0, sx! + 0.3)];
    traffic.update(100, Number(params.get('walk') ?? '0'), here);
    const where = traffic.where();
    const middle = (where[0]!.x + where[1]!.x) / 2;
    target.set(middle, 0.12, where[0]!.z);
    camera.position.set(middle + 0.6, 0.5, where[0]!.z + 1.7);
    camera.lookAt(target);
    fleet!.view(camera);
    traffic.update(100, 0, here);
    post.render(target);
    window.__ready = true;
    return;
  }
  fleet!.view(camera);
  step();

  if (params.has('run')) return run(tier, districts, n, traffic, step, post, target, renderer);

  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  renderer.info.autoReset = false;
  const submit: number[] = [];
  const total: number[] = [];
  let calls = 0;
  let triangles = 0;
  for (let i = -3; i < frames; i++) {
    renderer.info.reset();
    const a = performance.now();
    step();
    post.render(target);
    const b = performance.now();
    // Reading a pixel waits for the frame to finish.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const c = performance.now();
    if (i < 0) continue;
    submit.push(b - a);
    total.push(c - a);
    calls = renderer.info.render.calls;
    triangles = renderer.info.render.triangles;
  }
  const where = traffic.where();
  window.__load = {
    movers: traffic.drawn,
    cars: where.filter((w) => w.car).length,
    walkers: where.filter((w) => !w.car).length,
    calls,
    triangles,
    geometries: renderer.info.memory.geometries,
    submitMs: median(submit),
    frameMs: median(total),
  };
  window.__ready = true;
}

main().catch((e) => {
  console.error('the traffic page could not start', e);
  document.body.dataset.error = String(e);
});
