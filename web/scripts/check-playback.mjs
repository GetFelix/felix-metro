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
    window.__fc = (window.__fc ?? 0) + 1;
    const nowMs = performance.now();
    window.__fps = window.__lastFrame
      ? (1000 / Math.max(1, nowMs - window.__lastFrame)) * 0.3 + (window.__fps ?? 1) * 0.7
      : 1;
    window.__lastFrame = nowMs;
    window.__frames.push({
      t: performance.now(),
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
for (let attempt = 1; attempt <= ATTEMPTS && compared < MIN_COMPARED; attempt++) {
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
  // The playhead moves on a timer between frames, so the first frame after the pause draws what it reached; hold starts there.
  const fc = await page.evaluate(() => window.__fc);
  await page.waitForFunction((n) => window.__fc >= n + 2, fc, { polling: 100, timeout: MINUTE });
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
  if (done.tipAtJoin - joined > 5) await fail(`joined at ${joined}, the live tip was ${done.tipAtJoin} at that moment`);
  if (await page.locator('#past').isVisible()) await fail('the past pill is still showing after the join');

  // Nothing under way jumped at the join: the tick never went back, and no resident moved much further between the
  // frames either side of it than it had between the ones before.
  const frames = done.frames;
  // The first frame that joined after one that had not: the record may start with an earlier attempt's join.
  const j = frames.findIndex((f, i) => f.joined && i > 0 && !frames[i - 1].joined);
  // Frames from the seek's landing on: the ones before it show the live tick the seek jumped away from.
  const landed = Math.max(
    0,
    frames.findIndex((f) => f.tick <= started + HOUR_TICKS),
  );
  const lo = Math.max(1, landed + 1, j - 12);
  // Enough frames between the seek and the join to see the join in; a slow software renderer draws too few to ask for 8.
  const span = frames[j] && frames[landed] ? (frames[j].t - frames[landed].t) / 1000 : 0;
  const fps = span > 0 ? (j - landed) / span : 0;
  const need = fps >= 4 ? 8 : 3;
  console.log(`the join was found ${j - landed} frames after the seek landed (${fps.toFixed(1)} fps, ${need} needed)`);
  if (j < landed + need) await fail(`the join was found at frame ${j} of the record, the seek landed at ${landed}`);
  for (let i = lo; i < Math.min(frames.length, j + 4); i++) {
    if (frames[i].tick < frames[i - 1].tick - 1e-6)
      await fail(`the tick went back from ${frames[i - 1].tick} to ${frames[i].tick} at the join`);
  }
  // No resident moves further between two frames than the fastest road allows for the ticks between them.
  let comparedHere = 0;
  for (let i = lo; i < Math.min(frames.length, j + 4); i++) {
    const allowed = MAX_TILES_PER_TICK * Math.max(0, frames[i].tick - frames[i - 1].tick) + 0.2;
    for (const [resident, step] of steps(frames, i, i)) {
      comparedHere++;
      if (step > allowed)
        await fail(
          `resident ${resident} moved ${step.toFixed(2)} tiles in frame ${i} (join at ${j}), over the ${allowed.toFixed(2)} its ticks allow`,
        );
    }
  }
  compared += comparedHere;
  console.log(`joined at tick ${joined}; ${comparedHere} resident steps compared around the join`);
}
if (compared < MIN_COMPARED)
  await fail(`fewer than ${MIN_COMPARED} resident steps were compared around the join in any attempt`);

const tipOf = () => Math.min(...window.__metro.live().ticks);

/**
 * Seek to `from`, then click Back to live and say how many seconds the page took to show the live city. The live tip and
 * the playhead are read just before the click, since the tip moves while the seek and the playback open. During the
 * catch-up the gap, head, tail, queues and frame rate are logged once a second.
 */
const backToLive = async (from, bound, { play = true, within = Infinity, draw = true, cold = false } = {}) => {
  const seeked = await page.evaluate(([t, d]) => window.__metro.seek(t, d), [from, draw]);
  if (play) {
    if (!(await page.evaluate(() => window.__metro.play()))) await fail('there was nothing to play from the past');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__metro.play());
  }
  if (cold) {
    // The session the past opened ahead is closed, as idleness or a refusal would leave it.
    await page.waitForFunction(() => window.__metro.warm(), null, { polling: 100, timeout: 30_000 });
    await page.evaluate(() => window.__metro.closeWarm());
  }
  const before = await page.evaluate(() => ({
    tip: Math.min(...window.__metro.live().ticks),
    head: window.__metro.playback().head ?? window.__metro.shown().past,
    drawn: window.__metro.playback().shown ?? window.__metro.shown().past,
    speed: window.__metro.shown().speed,
    frames: window.__fc,
  }));
  const gap = before.tip - before.head;
  if (gap > within) return { skipped: true, gap };
  // A scripted click: Playwright's own waits for the button to hold still across animation frames, which costs seconds at
  // a frame a second and lets the tip move on before the click lands.
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ entryTypes: ['longtask'] });
  });
  const began = Date.now();
  await page.evaluate(() => document.getElementById('back-live').click());
  let movedMs = null;
  let lastLog = began;
  let lastFrames = before.frames;
  for (;;) {
    const now = await page.evaluate(() => ({
      live: window.__metro.shown().live,
      playback: window.__metro.playback(),
      frames: window.__fc,
    }));
    const elapsed = Date.now() - began;
    if (movedMs === null && ((now.playback.shown ?? before.drawn) > before.drawn || now.live)) movedMs = elapsed;
    if (now.live) {
      const long = await page.evaluate(() => window.__longTasks.filter((t) => t[1] >= 500));
      console.log(`  long tasks (start ms, duration ms): ${JSON.stringify(long)}`);
      break;
    }
    if (Date.now() - lastLog >= 1000) {
      const p = now.playback;
      const m = p.marks;
      const at = (v) => (v === null || v === undefined ? 'never' : `${(v - m.began).toFixed(0)} ms`);
      const fps = ((now.frames - lastFrames) * 1000) / (Date.now() - lastLog);
      console.log(
        `  catch-up ${(elapsed / 1000).toFixed(1)} s: gap ${(p.tail - p.head).toFixed(0)}, head ${p.head?.toFixed(0)}, tail ${p.tail}, queued ${JSON.stringify(p.queued)}, ${fps.toFixed(1)} fps, session ${m ? at(m.attached) : '-'}, first record ${m ? at(m.applied) : '-'} after the race began`,
      );
      lastLog = Date.now();
      lastFrames = now.frames;
    }
    if (elapsed > bound * 1000) {
      const where = await page.evaluate(() => ({
        playback: { ...window.__metro.playback(), applied: undefined },
        shown: window.__metro.shown(),
        live: window.__metro.live().ticks,
        longTasks: window.__longTasks.filter((t) => t[1] >= 500),
      }));
      await fail(
        `Back to live from tick ${seeked.tick} (${gap} ticks behind at the click) had not arrived after ${bound} s: ${JSON.stringify(where)}`,
      );
    }
    await page.waitForTimeout(50);
  }
  return { seconds: (Date.now() - began) / 1000, gap, speed: before.speed, movedMs };
};

// Near the tip, which moves away while the page closes on it: the design is about 3 s, 5 with the session and frame slack.
for (const back of [8, 40]) {
  const live = Math.floor(await page.evaluate(tipOf));
  const { seconds, gap } = await backToLive(live - back, 5);
  console.log(`back to live from ${back} ticks back (${gap} behind at the click) took ${seconds.toFixed(1)} s`);
}

// The session the past opened ahead is gone by the click (no Play first: a playback would hold that session itself): the race starts at once anyway, with the tick drawn moving
// and the head following when the session is open. A frame is drawn about once a second here, so the first movement is
// allowed a few frames.
{
  const live = Math.floor(await page.evaluate(tipOf));
  const { seconds, gap, movedMs } = await backToLive(live - 40, 5, { cold: true, play: false });
  const frameMs = await page.evaluate(() => 1000 / Math.max(0.5, window.__fps ?? 1));
  console.log(
    `cold back to live (${gap} behind at the click): the tick drawn moved after ${movedMs} ms, arrived in ${seconds.toFixed(1)} s (frames ${frameMs.toFixed(0)} ms apart)`,
  );
  if (movedMs === null || movedMs > 300 + 2 * frameMs)
    await fail(`with no session open the tick drawn moved after ${movedMs} ms, frames ${frameMs.toFixed(0)} ms apart`);
}

// A click within a second of the tip shows the live city at once. The seek takes a while, so the tip is read after it
// lands, with no wait for the city to fill in, and a seek is tried again until it lands that close; the gaps tried are logged.
{
  let snapped = null;
  const gaps = [];
  for (let i = 0; i < 8 && !snapped; i++) {
    const live = Math.floor(await page.evaluate(tipOf));
    const speed = await page.evaluate(() => window.__metro.shown().speed);
    const result = await backToLive(live - 1, 1, { play: false, draw: false, within: Math.max(4, speed) - 1 });
    gaps.push(result.gap);
    if (!result.skipped) snapped = result;
  }
  if (!snapped) await fail(`no seek landed within a second of the tip to test the snap: gaps ${JSON.stringify(gaps)}`);
  console.log(
    `back to live inside the snap window: ${snapped.gap} behind, took ${snapped.seconds.toFixed(2)} s (gaps tried ${JSON.stringify(gaps)})`,
  );
}

// From many city hours back, as far as the sim has run: the time is logged, and only a very slow one fails.
const live = Math.floor(await page.evaluate(() => window.__live.tick));
const far = Math.max(0, live - 12 * HOUR_TICKS);
if (live - far > 3 * HOUR_TICKS) {
  const { seconds } = await backToLive(far, 15);
  console.log(
    `back to live from ${((live - far) / HOUR_TICKS).toFixed(1)} city hours back took ${seconds.toFixed(1)} s`,
  );
} else console.log(`the sim has run ${live} ticks, too few to measure a catch-up from many hours back`);
await page.screenshot({ path: join(out, 'joined.png') });
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
