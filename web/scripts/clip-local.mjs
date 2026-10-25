// Records the clip on this machine's GPU: the v0.1.0 release bundle's backend in Podman (nothing is built), this
// checkout's page from the Vite dev server, a visible Edge window, then ffmpeg. Everything it starts is stopped again.
// Usage: node scripts/clip-local.mjs [city] [seconds] [out dir]     (from web/, after `npm run core`)
//   CLIP_SIM=native   runs this checkout's sim (built with cargo, run directly) against the bundle's broker instead of the
//                     bundle's sim image, for a sim that has changed since the release.
//   CLIP_WORK=dir     where the bundle and logs go (default: the system temp dir).
//   CLIP_BROWSER=msedge|chrome   the browser to draw in (default msedge).
//   CLIP_VERSION=0.1.0           the release bundle to take.
//   CLIP_REUSE=1      use the backend already running from the bundle in CLIP_WORK, and leave it running.
//   CLIP_GATEWAY_PORT=18787   host port for the bundle's gateway (the bundle's 8787), reached through Vite's proxy.
//   CLIP_SIM_PORT=18090       host port for the native sim's control address (its default is 8090).
// The bundle's host ports 5000/udp, 8080 and 8443 are moved to 5100, 28080 and 18443 so it can run beside another Felix
// stack. The page opens at http://127.0.0.1:5173 and the run stops if that port is taken.
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [city = 'harbor', seconds = '30', outArg] = process.argv.slice(2);
const version = process.env.CLIP_VERSION ?? '0.1.0';
const work = process.env.CLIP_WORK ?? join(os.tmpdir(), 'felix-metro-clip');
const out = outArg ?? join(work, 'out');
const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const bundle = join(work, `felix-metro-compose-${version}`);
const native = process.env.CLIP_SIM === 'native';
const reuse = !!process.env.CLIP_REUSE;
const gatewayPort = process.env.CLIP_GATEWAY_PORT ?? '18787';
const simPort = process.env.CLIP_SIM_PORT ?? '18090';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

// The bundle's scripts look for Docker first; an empty config keeps a missing credential helper from getting in the way.
const env = {
  ...process.env,
  CONTAINER_ENGINE: 'podman',
  DOCKER_CONFIG: mkdtempSync(join(os.tmpdir(), 'docker-config-')),
  // Its own compose project, so the `down --volumes` at the end never reaches a felix-metro stack started by hand.
  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? 'felix-metro-clip',
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', env, ...opts });
const children = [];
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  if (reuse) return void children.forEach((c) => c.kill('SIGTERM'));
  log('stopping what this run started');
  for (const c of children) c.kill('SIGTERM');
  try {
    sh('podman', ['compose', '-f', join(bundle, 'compose.yml'), 'down', '--volumes', '--remove-orphans'], {
      cwd: bundle,
      stdio: 'ignore',
    });
  } catch {}
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stop(), process.exit(130)));

try {
  if (!existsSync(bundle)) {
    log(`fetching the ${version} bundle`);
    const url = `https://github.com/GetFelix/felix-metro/releases/download/v${version}/felix-metro-compose-${version}.tar.gz`;
    // Extract and patch in a scratch dir, then rename into place, so a failed run never leaves a half bundle behind.
    const scratch = mkdtempSync(join(work, 'bundle-'));
    try {
      sh('bash', ['-c', `set -o pipefail; curl -fsSL '${url}' | tar xz -C '${scratch}'`]);
      const dir = join(scratch, `felix-metro-compose-${version}`);
      const patch = (name, edits) => {
        let text = readFileSync(join(dir, name), 'utf8');
        for (const [from, to] of edits) {
          if (!text.includes(from)) throw new Error(`${name} of the ${version} bundle has no "${from}" to patch`);
          text = text.replace(from, to);
        }
        writeFileSync(join(dir, name), text);
      };
      patch('compose.yml', [
        ['127.0.0.1:5000:5000/udp', '127.0.0.1:5100:5000/udp'],
        ['127.0.0.1:8080:8080', '127.0.0.1:28080:8080'],
        ['127.0.0.1:8443:8443', '127.0.0.1:18443:8443'],
        ['127.0.0.1:8787:8787', `127.0.0.1:${gatewayPort}:8787`],
      ]);
      patch('up.sh', [
        ['127.0.0.1:8080/ready', '127.0.0.1:28080/ready'],
        ['127.0.0.1:8787/oidc', `127.0.0.1:${gatewayPort}/oidc`],
      ]);
      renameSync(dir, bundle);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  log('starting the backend');
  if (!reuse && !native) sh(join(bundle, 'up.sh'), [], { cwd: bundle });
  if (!reuse && native) await startWithoutSim();

  let speedCmd = join(bundle, 'speed.sh');
  if (native) {
    // The bundle's sim container never starts, so the logs are empty for this checkout's sim; it finds the broker on its moved port.
    // Built first and run directly: killing `cargo run` would leave the sim it spawned running.
    const cargoEnv = { ...process.env, CARGO_TARGET_DIR: join(repo, 'target') };
    sh('cargo', ['build', '--release', '-p', 'felix-metro-sim', '--bin', 'sim'], { cwd: repo, env: cargoEnv });
    const sim = spawn(join(repo, 'target', 'release', 'sim'), [], {
      cwd: repo,
      env: {
        ...process.env,
        SIM_CONTROL_ADDR: `127.0.0.1:${simPort}`,
        SIM_FELIX_BROKERS: '127.0.0.1:5100',
        SIM_FELIX_CA_FILE: join(bundle, 'state', 'broker-cert.pem'),
        SIM_FELIX_TOKEN_FILE: join(bundle, 'state', 'sim.token'),
        SIM_TENANT: 'metro',
        SIM_CITIES: 'harbor pinecrest',
        SIM_ON_DEMAND: 'lakeside',
        SIM_TICKS_PER_SECOND: '4',
        RUST_LOG: 'info',
      },
      stdio: ['ignore', openLog('sim.log'), openLog('sim.log')],
    });
    sim.on('exit', (code) => {
      if (!stopped) log(`the sim exited (${code}); see sim.log`), stop(), process.exit(1);
    });
    sim.on('error', (e) => (log('the sim did not start:', e.message), stop(), process.exit(1)));
    children.push(sim);
    speedCmd = join(work, 'speed-native.sh');
    writeFileSync(
      speedCmd,
      `#!/usr/bin/env bash\ncurl -fsS -X PUT -d "$2" "http://127.0.0.1:${simPort}/cities/$1/speed"; echo\n`,
    );
    chmodSync(speedCmd, 0o755);
  }

  log('starting the page');
  if (await portTaken(5173)) throw new Error('127.0.0.1:5173 is already in use; stop that server and run again');
  const vite = spawn(
    join(web, 'node_modules', '.bin', 'vite'),
    ['--port', '5173', '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: web,
      env: { ...process.env, FELIX_GATEWAY_PORT: gatewayPort },
      stdio: ['ignore', openLog('vite.log'), openLog('vite.log')],
    },
  );
  children.push(vite);
  for (let i = 0; ; i++) {
    if (
      await fetch('http://127.0.0.1:5173/').then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (vite.exitCode !== null) throw new Error('vite exited; see vite.log');
    if (i > 60) throw new Error('the page did not come up; see vite.log');
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (vite.exitCode !== null) throw new Error('vite exited; see vite.log');
  log('recording');
  const clipOut = join(out, 'clip-out');
  sh('node', [join(web, 'scripts', 'clip.mjs'), 'http://127.0.0.1:5173', city, seconds, clipOut], {
    cwd: web,
    env: {
      ...env,
      CLIP_BROWSER: process.env.CLIP_BROWSER ?? 'msedge',
      CLIP_SPEED_CMD: speedCmd,
      // The builder bot finds the gateway here; it is on the moved port.
      GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
      CLIP_TIER: process.env.CLIP_TIER ?? 'high',
    },
  });

  log('encoding');
  const meta = JSON.parse(readFileSync(join(clipOut, 'meta.json'), 'utf8'));
  const mp4 = join(out, `metro-${city}.mp4`);
  const ff = (...a) => sh('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
  // JPEG frames are full range; the mp4 is limited range like the site's other clips.
  ff(
    '-framerate',
    String(meta.fps),
    '-i',
    join(clipOut, 'frames', 'f%05d.jpg'),
    '-vf',
    'scale=in_range=pc:out_range=tv,format=yuv420p',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-crf',
    '22',
    '-preset',
    'slow',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  );
  const at = String(meta.posterAt);
  const jpg = join(out, `metro-${city}.jpg`);
  ff('-ss', at, '-i', mp4, '-frames:v', '1', '-q:v', '3', jpg);
  // Not every ffmpeg build has libwebp; cwebp does the same from the jpg.
  try {
    ff('-ss', at, '-i', mp4, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', join(out, `metro-${city}.webp`));
  } catch {
    try {
      sh('cwebp', ['-q', '82', '-quiet', jpg, '-o', join(out, `metro-${city}.webp`)]);
    } catch {
      log('no webp poster: this ffmpeg has no libwebp and cwebp is not installed');
    }
  }
  // A few stills to look at without playing the clip.
  mkdirSync(join(out, 'stills'), { recursive: true });
  for (let s = 2; s < meta.frames / meta.fps; s += 3)
    ff(
      '-ss',
      String(s),
      '-i',
      mp4,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      join(out, 'stills', `t${String(s).padStart(2, '0')}.jpg`),
    );
  log(`wrote ${mp4}`);
} finally {
  stop();
}

// up.sh waits for a probe that needs the bundle's sim, so a native run starts the other services itself.
async function startWithoutSim() {
  const file = join(bundle, 'compose.yml');
  const compose = (...a) => sh('podman', ['compose', '-f', file, ...a], { cwd: bundle });
  try {
    compose('down', '--volumes', '--remove-orphans');
  } catch {}
  rmSync(join(bundle, 'state'), { recursive: true, force: true });
  mkdirSync(join(bundle, 'state'));
  compose('up', '--detach', 'idp', 'controlplane', 'seed', 'broker', 'finalize', 'gateway');
  for (let i = 0; ; i++) {
    const ready = await fetch(`http://127.0.0.1:${gatewayPort}/oidc`).then(
      (r) => existsSync(join(bundle, 'state', 'finalized')) && existsSync(join(bundle, 'state', 'sim.token')),
      () => false,
    );
    if (ready) return;
    if (i > 120) throw new Error('the backend did not come up');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function portTaken(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

function openLog(name) {
  // spawn takes a file descriptor, so the log is opened here and left to the process.
  return openSync(join(work, name), 'a');
}
