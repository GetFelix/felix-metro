import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
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
    // A `?model` import is the model's URL, not its bytes (see src/assets.ts). Bundling the GLB would hash its name and
    // break the relative path to its texture.
    enforce: 'pre',
    load(id) {
      const [file, query] = id.split('?');
      if (query !== 'model') return null;
      return `export default ${JSON.stringify('assets/' + relative(SHARED.assets!, file!))};`;
    },
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

const gatewayPort = process.env.FELIX_GATEWAY_PORT ?? '8787';

export default defineConfig({
  plugins: [sharedAssets()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        models: fileURLToPath(new URL('models.html', import.meta.url)),
        construction: fileURLToPath(new URL('construction.html', import.meta.url)),
      },
    },
  },
  // A gateway on the host answers /oidc and /ws for the dev server, as the dev stack's web container does.
  // FELIX_GATEWAY_PORT moves it when 8787 is taken.
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/oidc': `http://127.0.0.1:${gatewayPort}`,
      '/ws': { target: `ws://127.0.0.1:${gatewayPort}`, ws: true },
    },
  },
  preview: { proxy: {} },
  test: { environment: 'node' },
});
