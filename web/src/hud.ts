import type * as THREE from 'three';
import type { Quality } from './quality';

const FRAMES = 120;
const REFRESH_MS = 500;

// Frame statistics for ?hud. The ring and the sort scratch are allocated once; the text is rewritten twice a second.
export function createHud(renderer: THREE.WebGLRenderer, quality: Quality) {
  const el = document.createElement('div');
  el.className = 'hud';
  document.body.append(el);

  // The renderer resets its counters on every render call, and a post chain makes several.
  renderer.info.autoReset = false;

  const ring = new Float32Array(FRAMES);
  const scratch = new Float32Array(FRAMES);
  let filled = 0;
  let next = 0;
  let since = 0;
  let calls = 0;
  let triangles = 0;

  function refresh() {
    scratch.set(ring);
    const sorted = scratch.subarray(0, filled).sort();
    const median = sorted[filled >> 1]!;
    const p95 = sorted[Math.min(filled - 1, Math.floor(filled * 0.95))]!;
    el.textContent =
      `${median.toFixed(1)} ms median  ${p95.toFixed(1)} ms p95\n` +
      `${calls} draws  ${triangles} tris\n` +
      `tier ${quality.tier} (${quality.mode})`;
  }

  return {
    /** Call once at the start of each frame with the previous frame's time in ms; the render counters are for the frame before. */
    frame(frameMs: number) {
      calls = renderer.info.render.calls;
      triangles = renderer.info.render.triangles;
      renderer.info.reset();
      ring[next] = frameMs;
      next = (next + 1) % FRAMES;
      if (filled < FRAMES) filled++;
      since += frameMs;
      if (since >= REFRESH_MS && filled > 0) {
        since = 0;
        refresh();
      }
    },
  };
}
