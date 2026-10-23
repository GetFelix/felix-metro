import type { Mesh } from 'three';
// Dev page: loads and clones every model the asset glob finds, to catch a broken file or a missing texture.
import { allModels } from './assets';
import { cloneModel, loadModel } from './models';

declare global {
  interface Window {
    __ready?: boolean;
    __result?: { total: number; loaded: number; failures: { pack: string; name: string; error: string }[] };
  }
}

const failures: { pack: string; name: string; error: string }[] = [];
await Promise.all(
  allModels.map(async ({ pack, name }) => {
    try {
      const o = cloneModel(await loadModel(pack, name));
      let meshes = 0;
      o.traverse((n) => {
        if ((n as Mesh).isMesh) meshes++;
      });
      if (!meshes) throw new Error('no meshes');
    } catch (e) {
      failures.push({ pack, name, error: String(e) });
    }
  }),
);
window.__result = { total: allModels.length, loaded: allModels.length - failures.length, failures };
document.getElementById('out')!.textContent = JSON.stringify(window.__result, null, 2);
window.__ready = true;
