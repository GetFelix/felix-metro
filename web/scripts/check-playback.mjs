// Plays the city forward from a past tick and back to live. From a seek a few city hours back the page plays at the
// city's speed, then "Back to live" races forward and joins the live city. Every record the playback applied is
// recorded: each district's ticks must run on from the seek's tick one at a time with none missing or taken twice, up to
// the tick the page joined live at. At the join the state on screen is the live one, and the cars and walkers under way
// do not jump between the frames either side of it. Usage: node scripts/check-playback.mjs <page url> <out dir> where
// the page url has no hash. The sim should have run long enough to hold a few city hours.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-playback.mjs <page url> <out dir>');
const appUrl = withTrace(pageUrl);
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const HOUR_TICKS = 240;
const ATTEMPTS = 4;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
const fail = async (message) => {
  console.error(message);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await browser.close();
  process.exit(1);
};

await page.goto(`${appUrl}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => window.__ready === true && window.__metro && Number.isFinite(window.__live?.tick), null, {
    polling: 250,
    timeout: 5 * MINUTE,
  })
  .catch(() => fail('the live city did not open'));
await page.evaluate(() => window.__metro.prepare());

// A frame by frame record of the tick drawn and where everything is, to look at the join afterwards.
await page.evaluate(() => {
  window.__frames = [];
  const record = () => {
    window.__frames.push({
      joined: window.__metro.playback().joined !== null,
      tick: window.__live.tick,
      where: window.__live.where().map((w) => [w.resident, w.x, w.z]),
    });
    if (window.__frames.length > 4000) window.__frames.shift();
    requestAnimationFrame(record);
  };
  requestAnimationFrame(record);
});

/** The largest step in tiles any one resident took between frames `from` and `to` of `frames`. */
const steps = (frames, from, to) => {
  const largest = new Map();
  for (let i = Math.max(1, from); i <= to && i < frames.length; i++) {
    const before = new Map(frames[i - 1].where.map(([r, x, z]) => [r, [x, z]]));
    for (const [r, x, z] of frames[i].where) {
      const b = before.get(r);
      if (b) largest.set(r, Math.max(largest.get(r) ?? 0, Math.hypot(x - b[0], z - b[1])));
    }
  }
  return largest;
};

let compared = 0;
for (let attempt = 1; attempt <= ATTEMPTS && compared === 0; attempt++) {
  const live = Math.floor(await page.evaluate(() => window.__live.tick));
  const from = live - 2 * HOUR_TICKS - 7 * attempt;
  if (from < 0) await fail(`the sim has run ${live} ticks, too few to play from two city hours back`);
  await page.evaluate(() => (window.__frames.length = 0));
  const seeked = await page.evaluate((t) => window.__metro.seek(t), from);
  console.log(`attempt ${attempt}: seeked to ${seeked.tick}, live is at ${live}`);

  // Play at the city's speed: the tick on screen moves on from the seek's, one district tick at a time.
  if (!(await page.evaluate(() => window.__metro.play()))) await fail('there was nothing to play from the past');
  await page
    .waitForFunction((t) => window.__live.tick > t + 24, seeked.tick, { polling: 100, timeout: MINUTE })
    .catch(() => fail('playback did not move the clock on'));
  const playing = await page.evaluate(() => ({ ...window.__metro.playback(), shown: window.__metro.shown().past }));
  if (!playing.playing || playing.shown === null || playing.shown <= seeked.tick)
    await fail(`playing, the page shows ${JSON.stringify(playing.shown)} from ${seeked.tick}`);
  if (playing.started !== seeked.tick) await fail(`playback started at ${playing.started}, not ${seeked.tick}`);

  // Pause holds the tick, play takes it up again.
  await page.evaluate(() => window.__metro.play());
  const held = await page.evaluate(() => window.__live.tick);
  await page.waitForTimeout(1500);
  const still = await page.evaluate(() => window.__live.tick);
  if (still !== held) await fail(`paused, the clock went from ${held} to ${still}`);
  await page.evaluate(() => window.__metro.play());

  await page.click('#back-live');
  await page
    .waitForFunction(() => window.__metro.playback().joined !== null && window.__metro.shown().live, null, {
      polling: 100,
      timeout: MINUTE,
    })
    .catch(() => fail('Back to live did not join the live city'));
  await page.waitForTimeout(1500);

  const done = await page.evaluate(() => ({
    ...window.__metro.playback(),
    shown: window.__metro.shown(),
    liveNow: window.__metro.live(),
    frames: window.__frames.slice(),
  }));
  const { applied, joined, started } = done;

  // Every district's ticks, from the one after the seek to the join, each once and in order.
  const districts = done.liveNow.ticks.length;
  for (let d = 0; d < districts; d++) {
    const mine = applied.filter((a) => a[0] === d);
    const ticks = mine.map((a) => a[1]);
    if (mine.some((a) => a[2] !== 'applied'))
      await fail(
        `district ${d} took a record twice or out of order: ${JSON.stringify(mine.filter((a) => a[2] !== 'applied'))}`,
      );
    if (ticks[0] !== started + 1) await fail(`district ${d} began at tick ${ticks[0]}, not ${started + 1}`);
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i] !== started + 1 + i)
        await fail(`district ${d} has tick ${ticks[i]} where ${started + 1 + i} should be`);
    }
    if (ticks.at(-1) < joined)
      await fail(`district ${d} stopped at tick ${ticks.at(-1)}, before the join at ${joined}`);
    console.log(
      `district ${d}: ticks ${ticks[0]} to ${ticks.at(-1)}, ${ticks.length} records, none missing or repeated`,
    );
  }
  if (joined - started < 2 * HOUR_TICKS - 10) await fail(`the playback covered only ${joined - started} ticks`);

  // The page now shows the live city, and joined at its tip.
  if (done.shown.past !== null || !done.shown.live) await fail('after the join the page is not showing the live state');
  if (done.shown.sig !== done.liveNow.sig) await fail('after the join the city is not the live one');
  if (Math.min(...done.liveNow.ticks) - joined > 80)
    await fail(`joined at ${joined}, the live tip is ${Math.min(...done.liveNow.ticks)}`);
  if (await page.locator('#past').isVisible()) await fail('the past pill is still showing after the join');

  // Nothing under way jumped at the join: the tick never went back, and no resident moved much further between the
  // frames either side of it than it had between the ones before.
  const frames = done.frames;
  const j = frames.findIndex((f) => f.joined);
  if (j < 12) await fail(`the join was found at frame ${j} of the record`);
  for (let i = Math.max(1, j - 12); i < Math.min(frames.length, j + 4); i++) {
    if (frames[i].tick < frames[i - 1].tick - 1e-6)
      await fail(`the tick went back from ${frames[i - 1].tick} to ${frames[i].tick} at the join`);
  }
  const before = steps(frames, j - 12, j - 1);
  const across = steps(frames, j, j + 1);
  for (const [resident, step] of across) {
    if (!before.has(resident)) continue;
    compared++;
    const allowed = Math.max(0.3, 2 * before.get(resident));
    if (step > allowed)
      await fail(
        `resident ${resident} jumped ${step.toFixed(2)} tiles at the join, against ${before.get(resident).toFixed(2)} before it`,
      );
  }
  console.log(`joined at tick ${joined}; ${compared} residents compared across the join`);
}
if (compared === 0) await fail('no car or walker was under way across the join in any attempt');
await page.screenshot({ path: join(out, 'joined.png') });
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
