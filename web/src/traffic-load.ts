// Dev page for CI and for measuring: a generated city with N cars and walkers going back and forth along its roads,
// drawn through the real post chain, with the draw calls and frame times of the frames it drew. Read by
// scripts/check-traffic.mjs.
//   ?n=200 movers (half cars, half walkers)  ?tier=high|medium|low  ?t=12 hour  ?frames=30  ?shadows=0
//   ?close=car|walker puts the camera beside one, to look at it
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

async function main() {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get('n') ?? '100');
  const tier = (['high', 'medium', 'low'] as const).find((t) => t === params.get('tier')) ?? 'high';
  const frames = Number(params.get('frames') ?? '30');
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
  const { scene, glows, setTime, setShadows, fleet } = await createCity(renderer, tier, city, true);
  const s = settingsFor(tier);
  setShadows(s.shadows && params.get('shadows') !== '0', s.shadowMapSize);
  const post = createPost(renderer, scene, camera, passesFor(tier), glows);
  setTime(Number(params.get('t') ?? '12'), post.bloom);
  const half = (city.tiles - 1) / 2;
  const traffic = new Traffic(fleet!, half, city.lots);
  // The tier's cap is what this page measures the cost of, so it does not apply here.
  traffic.cap = Infinity;

  // Trips along the roads, a seeded few tiles each way.
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const roads = city.roads;
  const voyages: Voyage[] = [];
  for (let i = 0; i < n; i++) {
    const road = roads[Math.floor(rand() * roads.length)]!;
    const walker = i % 2 === 1;
    voyages.push({
      resident: i,
      vehicle: walker ? 0 : 1 + (i % 6),
      depart: 0,
      journey: shuttle(road.x, road.z, rand() < 0.5, 6, walker ? 0.15 : 0.35),
    });
  }

  const target = controls.target;
  camera.lookAt(target);
  const close = params.get('close');
  let tick = 100;
  const step = () => {
    tick += 0.25;
    traffic.update(tick, 1 / 60, voyages);
  };
  step();

  if (close) {
    const one = traffic
      .where()
      .filter((w) => w.car === (close === 'car'))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    if (one) {
      target.set(one.x, 0.1, one.z);
      const d = close === 'car' ? 1.6 : 0.9;
      camera.position.set(one.x + 0.45 * d, 0.8 * d, one.z + 0.45 * d);
      camera.lookAt(target);
    }
  }

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
