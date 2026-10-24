// Records the clip on this machine's GPU: the v0.1.0 release bundle's backend in Podman (nothing is built), this
// checkout's page from the Vite dev server, a visible Edge window, then ffmpeg. Everything it starts is stopped again.
// Usage: node scripts/clip-local.mjs [city] [seconds] [out dir]     (from web/, after `npm run core`)
//   CLIP_SIM=native   runs this checkout's sim (cargo run -p felix-metro-sim) against the bundle's broker instead of the
//                     bundle's sim image, for a sim that has changed since the release.
//   CLIP_WORK=dir     where the bundle and logs go (default: the system temp dir).
//   CLIP_BROWSER=msedge|chrome   the browser to draw in (default msedge).
//   CLIP_VERSION=0.1.0           the release bundle to take.
//   CLIP_REUSE=1      use the backend already running from the bundle in CLIP_WORK, and leave it running.
// The bundle's host ports 5000/udp, 8080 and 8443 are moved to 5100, 28080 and 18443 so it can run beside another Felix
// stack. The page opens at http://127.0.0.1:5173, the bundle's gateway answers /oidc and /ws through Vite's proxy.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

// The bundle's scripts look for Docker first; an empty config keeps a missing credential helper from getting in the way.
const env = {
  ...process.env,
  CONTAINER_ENGINE: 'podman',
  DOCKER_CONFIG: mkdtempSync(join(os.tmpdir(), 'docker-config-')),
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
    sh('bash', ['-c', `curl -fsSL '${url}' | tar xz -C '${work}'`]);
    const file = join(bundle, 'compose.yml');
    const moved = readFileSync(file, 'utf8')
      .replace('127.0.0.1:5000:5000/udp', '127.0.0.1:5100:5000/udp')
      .replace('127.0.0.1:8080:8080', '127.0.0.1:28080:8080')
      .replace('127.0.0.1:8443:8443', '127.0.0.1:18443:8443');
    writeFileSync(file, moved);
    const up = join(bundle, 'up.sh');
    writeFileSync(up, readFileSync(up, 'utf8').replace('127.0.0.1:8080/ready', '127.0.0.1:28080/ready'));
  }

  log('starting the backend');
  if (!reuse) sh(join(bundle, 'up.sh'), [], { cwd: bundle });

  let speedCmd = join(bundle, 'speed.sh');
  if (native) {
    // The sim container is replaced by this checkout's sim, which finds the bundle's broker on its moved port.
    sh('podman', ['compose', '-f', join(bundle, 'compose.yml'), 'stop', 'sim'], { cwd: bundle });
    const sim = spawn('cargo', ['run', '--release', '-p', 'felix-metro-sim'], {
      cwd: repo,
      env: {
        ...process.env,
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
    children.push(sim);
    speedCmd = join(work, 'speed-native.sh');
    writeFileSync(
      speedCmd,
      '#!/usr/bin/env bash\ncurl -fsS -X PUT -d "$2" "http://127.0.0.1:8090/cities/$1/speed"; echo\n',
    );
    chmodSync(speedCmd, 0o755);
  }

  log('starting the page');
  const vite = spawn(
    join(web, 'node_modules', '.bin', 'vite'),
    ['--port', '5173', '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: web,
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
    if (i > 60) throw new Error('the page did not come up; see vite.log');
    await new Promise((r) => setTimeout(r, 1000));
  }

  log('recording');
  const clipOut = join(out, 'clip-out');
  sh('node', [join(web, 'scripts', 'clip.mjs'), 'http://127.0.0.1:5173', city, seconds, clipOut], {
    cwd: web,
    env: {
      ...env,
      CLIP_BROWSER: process.env.CLIP_BROWSER ?? 'msedge',
      CLIP_SPEED_CMD: speedCmd,
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

function openLog(name) {
  // spawn takes a file descriptor, so the log is opened here and left to the process.
  return openSync(join(work, name), 'a');
}
