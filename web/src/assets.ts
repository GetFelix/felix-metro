// Every model under prototype/assets/models, found by folder and file name. The glob resolves to URLs (see the
// shared-assets plugin in vite.config.ts), so a new GLB needs no code.
const entries = import.meta.glob<string>('../../prototype/assets/models/**/*.glb', {
  query: '?model',
  import: 'default',
});

export type Pack = 'cars' | 'commercial' | 'industrial' | 'mini-characters' | 'roads' | 'suburban';

export interface ModelRef {
  pack: Pack;
  name: string;
}

const PATH = /\/models\/([^/]+)\/([^/]+)\.glb$/;

const byRef = new Map<string, () => Promise<string>>();
export const allModels: ModelRef[] = [];
for (const [path, load] of Object.entries(entries)) {
  const m = PATH.exec(path);
  if (!m) continue;
  byRef.set(`${m[1]}/${m[2]}`, load);
  allModels.push({ pack: m[1] as Pack, name: m[2]! });
}

export async function modelUrl(pack: Pack, name: string): Promise<string> {
  const load = byRef.get(`${pack}/${name}`);
  if (!load) throw new Error(`no model ${pack}/${name}`);
  return load();
}
