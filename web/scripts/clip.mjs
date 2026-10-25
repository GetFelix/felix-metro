// Records the clip for getfelix.dev: the live city drawn frame by frame, so the video is smooth however slowly the runner
// draws. The sim is paused for the whole capture and this script steps it on purpose: city time follows the script,
// never the wall clock. It runs the sim to the evening rush and holds it; has the builder bot raise buildings in the
// development area (the sim runs for the bot's commands only), then runs it on to the evening and holds it again. The
// page (?capture&trace) then draws one frame for every 1/30 s of video while this script moves the camera, the city's
// tick and the timeline bar. Frames are written as JPEGs for ffmpeg. Also writes shots.csv (what each second of video
// holds, with the clock and the "ago" label), bot.ndjson and meta.json.
// Usage: node scripts/clip.mjs <page url without hash> <city> <seconds> <out dir>
// Needs the dev stack up (dev/up.sh) and cargo for the bot; the sim's speed is set through dev/speed.sh.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [base, city, secondsArg, out] = process.argv.slice(2);
if (!out) throw new Error('usage: clip.mjs <page url> <city> <seconds> <out dir>');
const SECONDS = Math.max(Number(process.env.CLIP_MIN_SECONDS ?? 12), Number(secondsArg) || 30);
const FPS = 30;
const [W, H] = [1600, 900];
const TIER = process.env.CLIP_TIER ?? 'medium';
/** The hour the clip starts at: just before the evening rush. */
const START_HOUR = Number(process.env.CLIP_START_HOUR ?? 16.95);
const TICKS_PER_DAY = 5760;
/** The hour the live city has reached when the rewind starts: lights on. */
const EVENING_HOUR = Number(process.env.CLIP_EVENING_HOUR ?? 19.5);
const BUILDINGS = Number(process.env.CLIP_BUILDINGS ?? 10);
/** How far back the handle is taken, in city hours: before the bot's first building, short enough that the race back is a few seconds of video. */
const REWIND_HOURS = Number(process.env.CLIP_REWIND_HOURS ?? 4);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const frames = join(out, 'frames');
mkdirSync(frames, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// CLIP_SPEED_CMD names another way to set the sim's speed (called with the city and the speed), for a stack that is not
// dev/compose.yml. CLIP_BROWSER=msedge (or chrome) draws on the machine's GPU in a visible window; by default the
// bundled Chromium draws in software, as on a CI runner.
const speedCmd = process.env.CLIP_SPEED_CMD ? process.env.CLIP_SPEED_CMD.split(' ') : [join(root, 'dev', 'speed.sh')];
const speed = (v) => execFileSync(speedCmd[0], [...speedCmd.slice(1), city, String(v)], { encoding: 'utf8' }).trim();
const channel = process.env.CLIP_BROWSER || undefined;
const GPU = channel ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const launch = () =>
  chromium.launch({
    channel,
    headless: !channel,
    args: [
      ...GPU,
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CLIP_TIMING=1 only times a few frames at each tier, to see which one a runner can draw.
if (process.env.CLIP_TIMING) {
  log(`${os.cpus().length} cores, load ${os.loadavg().map((l) => l.toFixed(1))}`);
  for (const [tier, w, h, frames] of [
    ['low', 800, 450, 6],
    ['low', W, H, 6],
    ['medium', 800, 450, 4],
  ]) {
    const b = await launch();
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.goto(`${base}/?tier=${tier}&capture&trace#${city}`, { waitUntil: 'load', timeout: 300_000 });
    await p.waitForFunction(() => window.__capture && Number.isFinite(window.__live?.tick), null, {
      polling: 250,
      timeout: 300_000,
    });
    for (let i = 0; i < frames; i++) {
      const began = Date.now();
      const info = await p.evaluate((t) => window.__capture.frame(t), i * 33);
      const drawn = Date.now();
      await p.screenshot({ type: 'jpeg', quality: 95, timeout: 600_000 });
      log(
        `${tier} ${w}x${h}: frame ${i}: ${drawn - began} ms to draw (gpu ${JSON.stringify(info.gpu)}), ${Date.now() - drawn} ms to capture, load ${os.loadavg()[0].toFixed(1)}`,
      );
    }
    await b.close();
  }
  process.exit(0);
}

// The sim is held from here on and runs only when this script says so.
speed(0);

/**
 * Runs the sim until `tipOf()` reaches `target`, then holds it again. The last stretch is at 4 ticks a second so the
 * hold overshoots by a tick or two, not by the several a fast speed would.
 */
const advanceTo = async (target, tipOf) => {
  for (const [rate, margin] of [
    [16, 60],
    [4, 0],
  ]) {
    if ((await tipOf()) >= target - margin) continue;
    speed(rate);
    while ((await tipOf()) < target - margin) await sleep(30);
    speed(0);
    await sleep(800);
  }
  return tipOf();
};

// 1. Run the sim to the start of the rush and hold it there. CLIP_NOW=1 skips this and starts wherever the sim is.
if (!process.env.CLIP_NOW) {
  const probeBrowser = await launch();
  const probe = await probeBrowser.newPage({ viewport: { width: 480, height: 270 } });
  await probe.goto(`${base}/?tier=low&trace#${city}`, { waitUntil: 'load', timeout: 300_000 });
  await probe.waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 300_000 });
  const first = await probe.evaluate(() => window.__live.tick);
  const startTick =
    Math.ceil((first - START_HOUR * 240) / TICKS_PER_DAY) * TICKS_PER_DAY + Math.round(START_HOUR * 240);
  log(`city at tick ${Math.floor(first)}, the clip starts at tick ${startTick}`);
  await advanceTo(startTick, () => probe.evaluate(() => window.__live.tick));
  await probeBrowser.close();
  await sleep(3000);
}

// 2. The capture page, opened with the sim held, so its first tick is the start of the rush.
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  // A missing icon is not worth stopping a recording for; it is logged.
  if (m.type() === 'error') log(`console.error: ${m.text()}`);
});
await page.goto(`${base}/?tier=${TIER}&capture&trace${process.env.CLIP_PICTURE ? '&picture' : ''}#${city}`, {
  waitUntil: 'load',
  timeout: 300_000,
});
await page.waitForFunction(() => window.__capture && Number.isFinite(window.__live?.tick), null, {
  polling: 250,
  timeout: 300_000,
});
await page.waitForTimeout(1500);
const latest = () => page.evaluate(() => window.__capture.latest());

const shot = () => page.screenshot({ type: 'jpeg', quality: 95, timeout: 180_000 });
let n = 0;
let lastInfo = null;
const capture = async (tMs, extra) => {
  if (extra) await extra();
  const began = Date.now();
  lastInfo = await page.evaluate((t) => window.__capture.frame(t), tMs);
  const drawn = Date.now();
  writeFileSync(join(frames, `f${String(n++).padStart(5, '0')}.jpg`), await shot());
  if (n <= 3) log(`frame ${n}: ${drawn - began} ms to draw, ${Date.now() - drawn} ms to capture`);
  return lastInfo;
};

const k = SECONDS / 30;
const T = { rush: 7 * k, swing: 9.5 * k, growEnd: 15.5 * k, dusk: 18.5 * k, scrub: 22.5 * k, play: 25 * k };
const LIVE_HOLD = 2;
const ms = (s) => Math.round(s * 1000);
const tiles = await page.evaluate(() => window.__capture.tiles);
const half = (tiles - 1) / 2;
const sp = Math.max(1, tiles / 17) * 1.2;
const orbit = (az, dist, height) => [dist * Math.sin(az), height, dist * Math.cos(az)];
const az0 = Math.atan2(11.1, 12.2);
const dist0 = Math.hypot(11.1, 12.2) * sp;

// Frame 0 is drawn from the default view, to see where the cars are.
const f0 = await capture(0);
const cars = await page.evaluate(() => window.__live.where().filter((w) => w.car));
// The busiest spot is the car with the most others within four tiles; the camera stands on the road behind it.
let best = null;
for (const c of cars) {
  const near = cars.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) < 4);
  if (!best || near.length > best.near.length) best = { c, near };
}
const lead = best?.c ?? { x: 0, z: 0, heading: 0 };
log(
  `frame 0: tick ${Math.floor(f0.tick)} ${f0.clock}, ${f0.cars} cars and ${f0.walkers} walkers drawn, the camera follows the road behind (${lead.x.toFixed(1)}, ${lead.z.toFixed(1)}) with ${best?.near.length ?? 0} cars within 4 tiles`,
);

// 3. The builder bot raises buildings in the development area. Its commands apply at the next tick, so the sim runs
// while it works and is held again when it is done. Nothing is drawn meanwhile; the clip replays these ticks.
const base0 = Math.floor(await latest()) - 1;
const botLog = join(out, 'bot.ndjson');
const botArgs = [
  join(root, 'dev', 'builder-bot.mjs'),
  city,
  '--count',
  String(BUILDINGS),
  '--interval',
  '0.4',
  '--json',
  botLog,
];
if (process.env.CLIP_CITY_FILE) botArgs.push('--city-file', process.env.CLIP_CITY_FILE);
speed(4);
await new Promise((done, fail) => {
  const bot = spawn('node', botArgs, { cwd: root, stdio: 'inherit' });
  const timer = setTimeout(() => (bot.kill(), fail(new Error('the builder bot took over 10 minutes'))), 600_000);
  bot.on('exit', (code) => {
    clearTimeout(timer);
    code === 0 ? done() : fail(new Error(`the builder bot exited with ${code}`));
  });
});
speed(0);
await sleep(1000);
const botLines = readFileSync(botLog, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const placed = botLines.filter((e) => e.type === 'build' && e.phase === 'grow' && e.outcome === 'applied');
const botEnd = botLines.find((e) => e.type === 'end');
if (placed.length < 8 || !botEnd?.centre) throw new Error(`the bot raised ${placed.length} buildings`);
const firstBuild = Math.min(...placed.map((e) => e.tick));
const lastBuild = Math.max(...placed.map((e) => e.tick));
const hourOf = (tick) => (tick % TICKS_PER_DAY) / 240;
log(
  `the bot raised ${placed.length} buildings between tick ${firstBuild} (${hourOf(firstBuild).toFixed(2)} h) and ${lastBuild}, around tile ${botEnd.centre.x.toFixed(1)},${botEnd.centre.z.toFixed(1)}`,
);

// 4. On to the evening, so the live city has its lights on when the clip comes back to it, and hold it there.
const eveningTick = base0 + Math.max(lastBuild - base0 + 100, Math.round((EVENING_HOUR - hourOf(base0)) * 240));
const tip = Math.floor(await advanceTo(eveningTick, latest));
log(`the live city is held at tick ${tip} (${hourOf(tip).toFixed(2)} h); the clip starts at tick ${base0 + 1}`);

// The clip's ticks are counted from where the sim stood at the start. Each shot's tick span is planned here:
// the rush at a few ticks a second, the buildings going up in about a minute and a half of city time, then the evening.
const rel = (tick) => tick - base0;
const preGrowth = Math.max(6, rel(firstBuild) - 8);
const buildsDone = rel(lastBuild) + 12;
const eveningRel = tip - 2 - base0;
const gx = botEnd.centre.x - half;
const gz = botEnd.centre.z - half;
const azOut = Math.atan2(gx, gz);
const growth = (turn) => {
  const [dx, h, dz] = orbit(azOut + 0.9 + turn, 7.5 * sp, 5 * sp);
  return [gx + dx, h, gz + dz];
};

const path = {
  base: base0,
  position: [
    { t: ms(T.rush + 0.5 * k), v: orbit(az0 - 0.45, dist0 * 0.8, 7 * sp) },
    { t: ms(T.swing), v: growth(0) },
    { t: ms(T.growEnd), v: growth(0.2) },
    { t: ms(T.play), v: growth(0.3) },
    { t: ms(T.play + 3 * k), v: orbit(az0 + 0.5, dist0 * 1.0, 9.6 * sp) },
  ],
  target: [
    { t: ms(T.rush + 0.5 * k), v: [0, 0, 0] },
    { t: ms(T.swing), v: [gx, 0.3, gz] },
    { t: ms(T.play), v: [gx, 0.3, gz] },
    { t: ms(T.play + 3 * k), v: [0, 0, 0] },
  ],
  ticks: [
    { t: 0, v: [0] },
    { t: ms(T.rush), v: [preGrowth] },
    { t: ms(T.swing), v: [preGrowth + 3] },
    { t: ms(T.growEnd), v: [Math.max(buildsDone, preGrowth + 20)] },
    { t: ms(T.dusk), v: [eveningRel] },
  ],
};
path.follow = {
  resident: lead.resident,
  back: 3.4,
  backEnd: 1.8,
  up: 0.8,
  side: 0.3,
  ahead: 3,
  until: ms(T.rush + 0.5 * k),
  blend: ms(1.5 * k),
};
await page.evaluate((p) => window.__capture.setPath(p), path);
// The most the clock may move between two live shots a second apart, from the plan itself.
function sampleTicks(tMs) {
  const ks = path.ticks;
  if (tMs <= ks[0].t) return ks[0].v[0];
  if (tMs >= ks[ks.length - 1].t) return ks[ks.length - 1].v[0];
  let i = 0;
  while (ks[i + 1].t < tMs) i++;
  // The page eases between keys with a cubic; a straight line is within a few ticks of it.
  return ks[i].v[0] + ((ks[i + 1].v[0] - ks[i].v[0]) * (tMs - ks[i].t)) / (ks[i + 1].t - ks[i].t);
}
let maxStep = 0;
for (let s = 0; s * 1000 < ms(T.dusk); s++)
  maxStep = Math.max(maxStep, sampleTicks((s + 1) * 1000) - sampleTicks(s * 1000));
maxStep = Math.ceil(maxStep * 1.6) + 4;
log(
  `planned ticks: rush to ${preGrowth}, buildings until ${buildsDone}, evening at ${eveningRel}; at most ${maxStep} a second`,
);

const shots = join(out, 'shots.csv');
writeFileSync(shots, 'video_s,tick,clock,cars,walkers,cars_in_view,walkers_in_view,phase,ago\n');
let lastSecond = -1;
// What the clip is doing, so the check on the clock can tell a scripted drag from a jump.
let phase = 'live';
const note = async (t, info) => {
  if (Math.floor(t / 1000) === lastSecond) return;
  lastSecond = Math.floor(t / 1000);
  const ago = await page.evaluate(() => {
    const e = document.getElementById('past-ago');
    return e && e.offsetParent ? (e.textContent ?? '').replace(/,/g, ' ').trim() : '';
  });
  appendFileSync(
    shots,
    `${lastSecond},${Math.floor(info.tick)},${info.clock},${info.cars},${info.walkers},${info.carsInView},${info.walkersInView},${phase},${ago}\n`,
  );
};
const started = Date.now();
let t = 1000 / FPS;
const step = async (until, extra) => {
  for (; t <= ms(until); t += 1000 / FPS) {
    const info = await capture(Math.round(t), extra);
    await note(t, info);
    if (n % 30 === 0) log(`spent ${JSON.stringify(info.spent)}`);
    if (n % 30 === 0)
      log(
        `frame ${n}, video ${(t / 1000).toFixed(1)} s, ${((Date.now() - started) / n / 1000).toFixed(2)} s a frame, ${info.clock}, ${info.carsInView} cars in view`,
      );
  }
};

// Shots 1 and 2: the rush from the street, then the buildings going up in the development area as the evening comes on.
await step(T.dusk);
const posterAt = T.growEnd;

// Shot 3: the handle taken back a few city hours, to before the first building. The sim is held, so the live tip is
// where the clock stands and "ago" is exactly the distance dragged.
await page.waitForTimeout(1500);
const bar = page.locator('#scrub');
await page.mouse.move(W / 2, H - 60);
await step(T.dusk + 0.5 * k);
const box = await bar.boundingBox();
if (!box) throw new Error('the timeline bar is not on screen');
const y = box.y + box.height / 2;
await page.mouse.move(box.x + box.width * 0.9, y);
let range;
for (let i = 0; i < 400; i++) {
  range = await bar.evaluate((e) => ({
    min: Number(e.getAttribute('aria-valuemin')),
    max: Number(e.getAttribute('aria-valuemax')),
  }));
  // Until the history span is read the bar spans a single tick.
  if (range.max - range.min > 240) break;
  await capture(Math.round(t), null);
  t += 1000 / FPS;
}
const liveTick = await page.evaluate(() => window.__live.tick);
const rewound = Math.max(range.min, Math.min(range.max, liveTick) - REWIND_HOURS * 240);
if (rewound >= firstBuild)
  throw new Error(`the rewind to tick ${Math.floor(rewound)} is after the first building, tick ${firstBuild}`);
// The bar holds the span it had when the press began (at least a city day), so the fraction is read from that span.
const goal = Math.min(0.98, Math.max(0, (rewound - range.min) / (range.max - range.min)));
log(
  `timeline spans ${range.min}..${range.max}, live at ${Math.floor(liveTick)}; dragging to tick ${Math.floor(rewound)} at ${goal.toFixed(3)} of the bar`,
);
await page.mouse.move(box.x + box.width * 0.985, y);
await page.mouse.down();
phase = 'drag';
const dragFrames = Math.round((T.scrub - T.dusk - 0.5 * k) * FPS);
const dragFrom = t;
for (let i = 0; i <= dragFrames; i++) {
  const p = i / dragFrames;
  const e = p * p * (3 - 2 * p);
  await page.mouse.move(box.x + box.width * (0.985 + (goal - 0.985) * e), y);
  const info = await capture(Math.round(t));
  await note(t, info);
  t += 1000 / FPS;
}
await page.mouse.up();
phase = 'past';
log(`dragged for ${((t - dragFrom) / 1000).toFixed(1)} s; the clock says ${lastInfo.clock}`);
await step(T.scrub + 1 * k);

// Shots 4 and 5 need Play and Back to live racing to now.
const canPlay = (await page.locator('#play').count()) > 0;
if (canPlay) {
  await page.locator('#play').click();
  await step(T.play, () => page.waitForTimeout(40));
  // The sim is still held, so the live tip stays where it was while the catch-up is drawn frame by frame.
  phase = 'race';
  await page.locator('#back-live').click();
  // The catch-up is paced by video time, so frames are drawn until the past is gone, however far back it started.
  const inPast = () => page.evaluate(() => !document.getElementById('past').classList.contains('hidden'));
  const raceEnd = t + 20_000;
  while (t <= raceEnd && (await inPast())) {
    await page.waitForTimeout(40);
    await note(t, await capture(Math.round(t)));
    t += 1000 / FPS;
  }
  if (await inPast()) throw new Error('Back to live did not reach the live city within 20 s of video');
  log(`back on the live city at video ${(t / 1000).toFixed(1)} s`);
  phase = 'live';
  // Live again: the city moves on for the closing seconds, a few ticks a second, from where the race ended.
  const from = Math.floor(await latest()) - 1 - base0;
  speed(4);
  await page.evaluate((p) => window.__capture.setPath(p), {
    ...path,
    ticks: [
      { t: Math.round(t), v: [from] },
      { t: Math.round(t) + ms(LIVE_HOLD), v: [from + 16] },
    ],
  });
  await step(t / 1000 + LIVE_HOLD);
  speed(0);
} else {
  log('skipping shots 4 and 5: this build of the page has no Play button, so the past cannot be played forward');
  await step(T.scrub + 3 * k);
}

// The last shot must be the live city: the "ago" label gone and Back to live hidden.
const endsLive = await page.evaluate(
  () =>
    document.getElementById('past').classList.contains('hidden') && !document.getElementById('past-ago').offsetParent,
);
const endTick = Math.floor(lastInfo.tick);
appendFileSync(
  shots,
  `end,${endTick},${lastInfo.clock},${lastInfo.cars},${lastInfo.walkers},${lastInfo.carsInView},${lastInfo.walkersInView},live,\n`,
);
log(`last frame: tick ${endTick}, ${endsLive ? 'live' : 'NOT live'}`);
if (canPlay && !endsLive) errors.push('the clip does not end on the live city');
if (errors.length) log(`page errors:\n${errors.join('\n')}`);
writeFileSync(
  join(out, 'meta.json'),
  JSON.stringify({
    fps: FPS,
    frames: n,
    posterAt,
    width: W,
    height: H,
    played: canPlay,
    tier: TIER,
    endsLive,
    endTick,
    built: placed.length,
    firstBuild,
    maxStep,
  }),
);
log(`${n} frames in ${((Date.now() - started) / 60000).toFixed(1)} minutes`);
await browser.close();
if (errors.length) process.exit(1);
