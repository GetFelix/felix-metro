// Plays the city forward from a past tick and back to live. From a seek a few city hours back the page plays at the
// city's speed, then "Back to live" races forward and joins the live city. Every record the playback applied is
// recorded: each district's ticks must run on from the seek's tick one at a time with none missing or taken twice, up to
// the tick the page joined live at. At the join the state on screen is the live one, and the cars and walkers under way
// do not jump between the frames either side of it. Usage: node scripts/check-playback.mjs <page url> <out dir> where
// the page url has no hash. Back to live must also arrive from a few ticks back, where the tip keeps moving away, and
// from many hours back in a bounded time. The sim should have run long enough to hold a few city hours.
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
/** The fastest road in tiles per tick (1.5 tiles a second, 4 ticks a second): the most any resident can move. */
const MAX_TILES_PER_TICK = 0.375;
const MIN_COMPARED = 5;

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
    // A retried tick may arrive again and is ignored as 'seen'; anything else that is not applied, or a repeat of a tick
    // never applied, is wrong.
    const have = new Set();
    for (const [, tick, result] of mine) {
      if (result === 'applied') have.add(tick);
      else if (result !== 'seen' || !have.has(tick))
        await fail(`district ${d} took a record out of order: ${JSON.stringify([tick, result])}`);
    }
    const ticks = mine.filter((a) => a[2] === 'applied').map((a) => a[1]);
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
  // No resident moves further between two frames than the fastest road allows for the ticks between them.
  let comparedHere = 0;
  for (let i = Math.max(1, j - 12); i < Math.min(frames.length, j + 4); i++) {
    const allowed = MAX_TILES_PER_TICK * Math.max(0, frames[i].tick - frames[i - 1].tick) + 0.2;
    for (const [resident, step] of steps(frames, i, i)) {
      comparedHere++;
      if (step > allowed)
        await fail(
          `resident ${resident} moved ${step.toFixed(2)} tiles in frame ${i} (join at ${j}), over the ${allowed.toFixed(2)} its ticks allow`,
        );
    }
  }
  compared = comparedHere >= MIN_COMPARED ? comparedHere : 0;
  console.log(`joined at tick ${joined}; ${comparedHere} resident steps compared around the join`);
}
if (compared === 0)
  await fail(`fewer than ${MIN_COMPARED} resident steps were compared around the join in any attempt`);

/** Seek to `from`, then click Back to live and say how many seconds the page took to show the live city. */
const backToLive = async (from, bound) => {
  const seeked = await page.evaluate((t) => window.__metro.seek(t), from);
  if (!(await page.evaluate(() => window.__metro.play()))) await fail('there was nothing to play from the past');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__metro.play());
  const began = Date.now();
  await page.click('#back-live');
  await page
    .waitForFunction(() => window.__metro.shown().live, null, { polling: 50, timeout: bound * 1000 })
    .catch(() => fail(`Back to live from tick ${seeked.tick} had not arrived after ${bound} s`));
  return (Date.now() - began) / 1000;
};

// Near the tip, which moves away while the page closes on it.
for (const back of [8, 40]) {
  const live = Math.floor(await page.evaluate(() => window.__live.tick));
  const seconds = await backToLive(live - back, 5);
  console.log(`back to live from ${back} ticks back took ${seconds.toFixed(1)} s`);
}

// From many city hours back, as far as the sim has run: the time is logged, and only a very slow one fails.
const live = Math.floor(await page.evaluate(() => window.__live.tick));
const far = Math.max(0, live - 12 * HOUR_TICKS);
if (live - far > 3 * HOUR_TICKS) {
  const seconds = await backToLive(far, 15);
  console.log(
    `back to live from ${((live - far) / HOUR_TICKS).toFixed(1)} city hours back took ${seconds.toFixed(1)} s`,
  );
} else console.log(`the sim has run ${live} ticks, too few to measure a catch-up from many hours back`);
await page.screenshot({ path: join(out, 'joined.png') });
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
