// Records the clip for getfelix.dev: the live city drawn frame by frame, so the video is smooth however slowly the runner
// draws. The sim runs fast to the evening rush, is paused there, and the page (?capture&trace) then draws one frame for
// every 1/30 s of video while this script moves the camera, the city's tick and the timeline bar. Frames are written as
// JPEGs for ffmpeg. Also writes density.json (cars and walkers on the road by hour of the first day) and shots.csv (what
// each second of video holds), so a sparse frame shows up in numbers.
// Usage: node scripts/clip.mjs <page url without hash> <city> <seconds> <out dir>
// Needs the dev stack up (dev/up.sh); the sim's speed is set through dev/speed.sh.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [base, city, secondsArg, out] = process.argv.slice(2);
if (!out) throw new Error('usage: clip.mjs <page url> <city> <seconds> <out dir>');
const SECONDS = Math.max(12, Number(secondsArg) || 30);
const FPS = 30;
const [W, H] = [1600, 900];
const TIER = process.env.CLIP_TIER ?? 'medium';
/** The hour the clip starts at: just before the evening rush. */
const START_HOUR = Number(process.env.CLIP_START_HOUR ?? 16.95);
const TICKS_PER_DAY = 5760;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const frames = join(out, 'frames');
mkdirSync(frames, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const speed = (v) => execFileSync(join(root, 'dev', 'speed.sh'), [city, String(v)], { encoding: 'utf8' }).trim();
const GPU = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CLIP_TIMING=1 only times a few frames at each tier, to see which one a runner can draw.
if (process.env.CLIP_TIMING) {
  for (const tier of ['low', 'medium', 'high']) {
    const b = await chromium.launch({ args: GPU });
    const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await p.goto(`${base}/?tier=${tier}&capture&trace#${city}`, { waitUntil: 'load', timeout: 300_000 });
    await p.waitForFunction(() => window.__capture && Number.isFinite(window.__live?.tick), null, {
      polling: 250,
      timeout: 300_000,
    });
    for (let i = 0; i < 3; i++) {
      const began = Date.now();
      await p.evaluate((t) => window.__capture.frame(t), i * 33);
      const drawn = Date.now();
      await p.screenshot({ type: 'jpeg', quality: 95, timeout: 600_000 });
      log(`${tier}: frame ${i}: ${drawn - began} ms to draw, ${Date.now() - drawn} ms to capture`);
    }
    await b.close();
  }
  process.exit(0);
}

// 1. Run the sim to the start of the rush, counting what is on the road on the way, then hold it there.
const probeBrowser = await chromium.launch({ args: GPU });
const probe = await probeBrowser.newPage({ viewport: { width: 480, height: 270 } });
await probe.goto(`${base}/?tier=low&trace#${city}`, { waitUntil: 'load', timeout: 300_000 });
await probe.waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 300_000 });
const first = await probe.evaluate(() => window.__live.tick);
const startTick = Math.ceil((first - START_HOUR * 240) / TICKS_PER_DAY) * TICKS_PER_DAY + Math.round(START_HOUR * 240);
log(`city at tick ${Math.floor(first)}, the clip starts at tick ${startTick}`);
speed(16);
const byHour = {};
for (;;) {
  const s = await probe.evaluate(() => {
    const w = window.__live.where();
    return { tick: window.__live.tick, cars: w.filter((x) => x.car).length, walkers: w.filter((x) => !x.car).length };
  });
  const hour = Math.floor((s.tick % TICKS_PER_DAY) / 240);
  const h = (byHour[hour] ??= { samples: 0, carsMax: 0, carsSum: 0, walkersMax: 0, walkersSum: 0 });
  h.samples++;
  h.carsMax = Math.max(h.carsMax, s.cars);
  h.carsSum += s.cars;
  h.walkersMax = Math.max(h.walkersMax, s.walkers);
  h.walkersSum += s.walkers;
  if (s.tick >= startTick - 6) break;
  await sleep(250);
}
speed(0);
writeFileSync(join(out, 'density.json'), JSON.stringify(byHour, null, 1));
log('cars and walkers drawn by hour (max over samples):');
for (const [hour, h] of Object.entries(byHour))
  log(`  ${hour.padStart(2)}:00  cars ${h.carsMax}  walkers ${h.walkersMax}  (${h.samples} samples)`);
await probeBrowser.close();
await sleep(3000);

// 2. The capture page, opened with the sim held, so its first tick is the start of the rush.
const browser = await chromium.launch({ args: GPU });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
await page.goto(`${base}/?tier=${TIER}&capture&trace#${city}`, { waitUntil: 'load', timeout: 300_000 });
await page.waitForFunction(() => window.__capture && Number.isFinite(window.__live?.tick), null, {
  polling: 250,
  timeout: 300_000,
});
await page.waitForTimeout(1500);
// Now let the sim run on at a gentle pace; every frame waits for the tick it needs.
speed(4);

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
const T = { rush: 8 * k, dusk: 16 * k, scrub: 22 * k, play: 27 * k, live: 30 * k };
const ms = (s) => Math.round(s * 1000);
const tiles = await page.evaluate(() => window.__capture.tiles);
const sp = Math.max(1, tiles / 17) * 1.2;
const orbit = (az, dist, height) => [dist * Math.sin(az), height, dist * Math.cos(az)];
const az0 = Math.atan2(11.1, 12.2);
const dist0 = Math.hypot(11.1, 12.2) * sp;

// Frame 0 is drawn from the default view, to see where the cars are.
const f0 = await capture(0);
const cars = await page.evaluate(() => window.__live.where().filter((w) => w.car));
// The busiest spot is the car with the most others within four tiles.
let best = null;
for (const c of cars) {
  const near = cars.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) < 4);
  if (!best || near.length > best.near.length) best = { c, near };
}
const spot = best
  ? {
      x: best.near.reduce((a, o) => a + o.x, 0) / best.near.length,
      z: best.near.reduce((a, o) => a + o.z, 0) / best.near.length,
    }
  : { x: 0, z: 0 };
log(
  `frame 0: tick ${Math.floor(f0.tick)} ${f0.clock}, ${f0.cars} cars and ${f0.walkers} walkers drawn, busiest spot (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) with ${best?.near.length ?? 0} cars within 4 tiles`,
);

const path = {
  position: [
    { t: 0, v: [spot.x + 3.4, 1.7, spot.z + 3.4] },
    { t: ms(T.rush), v: [spot.x + 2.4, 1.2, spot.z + 2.6] },
    { t: ms(T.rush + 1.5 * k), v: orbit(az0 - 0.45, dist0 * 0.8, 7 * sp) },
    { t: ms(T.dusk), v: orbit(az0 + 0.25, dist0 * 0.95, 9 * sp) },
    { t: ms(T.live), v: orbit(az0 + 0.5, dist0 * 1.0, 9.6 * sp) },
  ],
  target: [
    { t: 0, v: [spot.x, 0.2, spot.z] },
    { t: ms(T.rush), v: [spot.x, 0.2, spot.z] },
    { t: ms(T.rush + 1.5 * k), v: [0, 0, 0] },
    { t: ms(T.live), v: [0, 0, 0] },
  ],
  // City minutes the video covers: the rush at about three ticks a second, then the evening in a rush to the lights.
  ticks: [
    { t: 0, v: [0] },
    { t: ms(T.rush - 1 * k), v: [22] },
    { t: ms(T.rush + 1.5 * k), v: [40] },
    { t: ms(T.dusk), v: [470] },
    { t: ms(T.live), v: [470] },
  ],
};
await page.evaluate((p) => window.__capture.setPath(p), path);

const shots = join(out, 'shots.csv');
writeFileSync(shots, 'video_s,tick,clock,cars,walkers,cars_in_view,walkers_in_view\n');
let lastSecond = -1;
const note = (t, info) => {
  if (Math.floor(t / 1000) === lastSecond) return;
  lastSecond = Math.floor(t / 1000);
  appendFileSync(
    shots,
    `${lastSecond},${Math.floor(info.tick)},${info.clock},${info.cars},${info.walkers},${info.carsInView},${info.walkersInView}\n`,
  );
};
const started = Date.now();
let t = 1000 / FPS;
const step = async (until, extra) => {
  for (; t <= ms(until); t += 1000 / FPS) {
    const info = await capture(Math.round(t), extra);
    note(t, info);
    if (n % 30 === 0)
      log(
        `frame ${n}, video ${(t / 1000).toFixed(1)} s, ${((Date.now() - started) / n / 1000).toFixed(2)} s a frame, ${info.clock}, ${info.carsInView} cars in view`,
      );
  }
};

// Shots 1 and 2: the rush from the street, then up and out over the city as the evening comes on.
await step(T.dusk);
const posterAt = T.dusk;

// Shot 3: the handle taken back across the day to the morning rush.
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
const morning = Math.floor(f0.tick / TICKS_PER_DAY) * TICKS_PER_DAY + 7.9 * 240;
const goal = Math.min(0.98, Math.max(0, (morning - range.min) / (range.max - range.min)));
log(`timeline spans ${range.min}..${range.max}; dragging to tick ${morning} at ${goal.toFixed(3)} of the bar`);
await page.mouse.move(box.x + box.width * 0.985, y);
await page.mouse.down();
const dragFrames = Math.round((T.scrub - T.dusk - 0.5 * k) * FPS);
const dragFrom = t;
for (let i = 0; i <= dragFrames; i++) {
  const p = i / dragFrames;
  const e = p * p * (3 - 2 * p);
  await page.mouse.move(box.x + box.width * (0.985 + (goal - 0.985) * e), y);
  const info = await capture(Math.round(t));
  note(t, info);
  t += 1000 / FPS;
}
await page.mouse.up();
log(`dragged for ${((t - dragFrom) / 1000).toFixed(1)} s; the clock says ${lastInfo.clock}`);
await step(T.scrub + 1 * k);

// Shots 4 and 5 need Play and Back to live racing to now.
const canPlay = (await page.locator('#play').count()) > 0;
if (canPlay) {
  await page.locator('#play').click();
  await step(T.play, () => page.waitForTimeout(40));
  await page.locator('#back-live').click();
  await step(T.live, () => page.waitForTimeout(40));
} else {
  log('skipping shots 4 and 5: this build of the page has no Play button, so the past cannot be played forward');
  await step(T.scrub + 3 * k);
}

if (errors.length) log(`page errors:\n${errors.join('\n')}`);
writeFileSync(
  join(out, 'meta.json'),
  JSON.stringify({ fps: FPS, frames: n, posterAt, width: W, height: H, played: canPlay, tier: TIER }),
);
log(`${n} frames in ${((Date.now() - started) / 60000).toFixed(1)} minutes`);
await browser.close();
if (errors.length) process.exit(1);
