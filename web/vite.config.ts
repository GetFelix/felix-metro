import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

// The models and the brand mark live outside web/, shared with the style frame.
const SHARED: Record<string, string> = {
  assets: fileURLToPath(new URL('../prototype/assets/', import.meta.url)),
  brand: fileURLToPath(new URL('../docs/brand/', import.meta.url)),
};
const TYPES: Record<string, string> = { '.glb': 'model/gltf-binary', '.png': 'image/png', '.md': 'text/markdown' };

// Served from the repo in dev, copied into dist for build and preview.
function sharedAssets(): Plugin {
  let outDir = '';
  let command = '';
  return {
    name: 'shared-assets',
    configResolved(config) {
      command = config.command;
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [, top = '', ...rest] = (req.url ?? '').split('?')[0]!.split('/');
        const root = SHARED[top];
        const file = root && join(root, decodeURIComponent(rest.join('/')));
        if (!file || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (command !== 'build') return;
      for (const [name, dir] of Object.entries(SHARED)) cpSync(dir, join(outDir, name), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [sharedAssets()],
  server: { fs: { allow: ['..'] } },
  test: { environment: 'node' },
});
