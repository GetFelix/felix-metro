// Scrubs the live city on the timeline bar, by pointer and by keyboard. Opening the page and hovering the bar must not
// open history sessions until the bar is reached for. Throughout: every sampled frame has the state folded whole (every
// district at one tick) with buildings in it, the city is never held at one moment while the handle crosses hours, and
// at rest the folded state is at the handle's tick with the clock saying that tick. A step forward inside an hour
// equals a fresh fold of that tick. Live records keep arriving while the past is shown. "Back to live" returns to the
// live city, including when a slow seek is still running. Screenshots of the bar live, while dragging and in the past
// are written to the out dir. Usage: node scripts/check-scrub.mjs <page url> <out dir>
// where the page url has no hash. The sim should have run long enough to hold a few city hours.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [appUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-scrub.mjs <page url> <out dir>');
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const HOUR_TICKS = 240;
/** A moment by which the city has buildings. */
const BUILT_BY = 2000;
const SPAN_NEEDED = 4 * HOUR_TICKS;

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

/** Handle, clock and drawn city in one read, so they are from the same frame. */
const read = () =>
  page.evaluate(() => {
    const scrub = document.getElementById('scrub');
    return {
      at: Number(scrub.dataset.at),
      mode: scrub.dataset.mode,
      min: Number(scrub.getAttribute('aria-valuemin')),
      max: Number(scrub.getAttribute('aria-valuemax')),
      clock: document.getElementById('clock').textContent,
      drawn: window.__live.tick,
      shown: window.__metro.shown(),
      liveNow: window.__metro.live(),
    };
  });

const minutesOf = (clock) => {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
};
const tickMinutes = (tick) => Math.floor(((tick % 5760) / 5760) * 24 * 60);

// What the page has drawn: the folded state, not a guess from pixels. A past state has every district at one tick and
// buildings in it once the city has grown; the live one has buildings in it.
/** Whether the live city has buildings at all; a stack that has built nothing proves nothing by an empty one. */
let grown = false;
const wholeProblem = (r) => {
  const { shown } = r;
  // The first hours of a city are empty, so only the live city and later moments must have buildings.
  if (grown && (shown.past === null || shown.past >= BUILT_BY) && !(shown.buildings > 0))
    return `no buildings are drawn (${JSON.stringify({ past: shown.past, ticks: shown.ticks })})`;
  if (shown.past !== null && shown.ticks.some((t) => t !== shown.past))
    return `the state is at ticks ${shown.ticks} while holding tick ${shown.past}`;
  return null;
};

let samples = 0;
/** `rest`: the handle has stopped, so the clock must say the folded state's tick. */
const sample = async (what, rest = false) => {
  const r = await read();
  samples++;
  const problem = wholeProblem(r);
  if (problem) await fail(`${what}: ${problem}`);
  // While the handle moves the sun follows it and the city lags; at rest both are at the same moment.
  const clockTick = rest ? (r.shown.past ?? Math.floor(r.drawn)) : r.at;
  const gap = Math.abs(minutesOf(r.clock) - tickMinutes(clockTick));
  if (gap > 1 && gap < 24 * 60 - 1) await fail(`${what}: the clock says ${r.clock} with the city at tick ${clockTick}`);
  return r;
};

// Opening the page and moving over the bar must not open history sessions.
await page.goto(`${appUrl}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => window.__ready === true && window.__metro, null, { polling: 250, timeout: 5 * MINUTE })
  .catch(() => fail('the page never became ready'));
await page.waitForTimeout(4000);
if (await page.evaluate(() => window.__metro.historyOpen()))
  await fail('history was opened by a viewer who never reached for the bar');
const bar0 = await page.locator('#scrub').boundingBox();
if (!bar0) await fail('the bar is not showing with only the live tip');
await page.mouse.move(bar0.x + bar0.width / 2, bar0.y + bar0.height / 2);
await page
  .waitForFunction(() => window.__metro.historyOpen(), null, { polling: 100, timeout: MINUTE })
  .catch(() => fail('hovering the bar did not read the span'));

// The page, once its timeline has a few hours behind it.
await page
  .waitForFunction(
    (need) => {
      void window.__metro.refresh();
      const s = document.getElementById('scrub');
      return (
        !s.classList.contains('hidden') &&
        Number(s.getAttribute('aria-valuemax')) - Number(s.getAttribute('aria-valuemin')) >= need
      );
    },
    SPAN_NEEDED,
    { polling: 500, timeout: 8 * MINUTE },
  )
  .catch(() => fail('the timeline never showed a few hours of history'));
await page.evaluate(() => window.__metro.prepare());
const live = await read();
if (live.mode !== 'live') await fail(`the page opens in "${live.mode}", not live`);
console.log(`timeline spans ticks ${live.min} to ${live.max}`);
grown = live.shown.buildings > 0;
console.log(`the live city has ${live.shown.buildings} buildings`);
await page.locator('#timeline').screenshot({ path: join(out, 'bar-live.png') });
await page.screenshot({ path: join(out, 'live.png') });

const strip = await page.locator('#scrub .strip').boundingBox();
const y = strip.y + strip.height / 2;
const xAt = (f) => strip.x + strip.width * f;

// Back to live while a slow seek is still running: once the seek lands, the page must still be live.
await page.evaluate(() => window.__metro.holdSeeks(4000));
await page.mouse.move(xAt(0.3), y);
await page.mouse.down();
await page.mouse.move(xAt(0.28), y);
await page.mouse.up();
await page
  .waitForSelector('#back-live', { state: 'visible', timeout: 10_000 })
  .catch(() => fail('no Back to live while seeking'));
await page.click('#back-live');
await page.waitForTimeout(6000);
const held = await read();
if (held.mode !== 'live' || !held.shown.live || held.shown.past !== null)
  await fail(
    `a seek that landed after Back to live took the page into the past: ${JSON.stringify({ mode: held.mode, past: held.shown.past, live: held.shown.live })}`,
  );
if (await page.locator('#past').isVisible()) await fail('the past pill came back after a slow seek landed');
await page.evaluate(() => window.__metro.holdSeeks(0));
console.log('Back to live held against a seek still running');

// Drag from near the live end back across most of the span, faster than a seek completes.
await page.mouse.move(xAt(0.9), y);
await page.mouse.down();
const drawnTicks = new Set();
const handles = [];
const STEPS = 36;
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.move(xAt(0.9 - (0.75 * i) / STEPS), y);
  await page.waitForTimeout(30);
  if (i % 3 === 0) {
    const r = await sample(`dragging, step ${i}`);
    drawnTicks.add(Math.floor(r.drawn));
    handles.push(r.at);
    if (i === STEPS / 2) await page.locator('#timeline').screenshot({ path: join(out, 'bar-dragging.png') });
  }
}
const last = (await read()).at;
await page.mouse.up();
if (handles.some((h, i) => i > 0 && h >= handles[i - 1])) await fail(`the handle did not move steadily: ${handles}`);
if (handles[0] - last < 2 * HOUR_TICKS) await fail(`the drag crossed only ${handles[0] - last} ticks`);
// Continuous: the city followed the handle while it moved, not only at the end.
if (drawnTicks.size < 3) await fail(`the city was drawn at only ${drawnTicks.size} moments during the drag`);

const settled = (expected) =>
  page.waitForFunction(
    (tick) => {
      const s = document.getElementById('scrub');
      return Number(s.dataset.at) === tick && Math.floor(window.__live.tick) === tick;
    },
    expected,
    { polling: 100, timeout: MINUTE },
  );
// The release lands on the tick under the pointer, which moves a little as the live tip does, so the tick it rests at
// is read from the page: the city must be folded to the very tick the bar holds.
await page
  .waitForFunction(
    () => {
      const s = document.getElementById('scrub');
      const { past } = window.__metro.shown();
      return past !== null && Number(s.dataset.at) === past && Math.floor(window.__live.tick) === past;
    },
    null,
    { polling: 100, timeout: MINUTE },
  )
  .catch(async () => fail(`after the drag the city did not rest at the handle: ${JSON.stringify(await read())}`));
const rest = await sample('after the drag', true);
const dragEnd = rest.shown.past;
if (rest.mode !== 'past') await fail(`after the drag the bar says "${rest.mode}"`);
console.log(`drag ended at tick ${dragEnd}; ${drawnTicks.size} moments drawn on the way`);

const pill = await page.locator('#past').innerText();
if (!/^(just now|\d+ m ago|\d+ h \d+ m ago)\s*·\s*Back to live$/.test(pill.replace(/\s+/g, ' ').trim()))
  await fail(`the past pill reads "${pill}"`);
console.log(`past pill: "${pill.replace(/\s+/g, ' ').trim()}"`);
await page.locator('#timeline').screenshot({ path: join(out, 'bar-past.png') });
await page.screenshot({ path: join(out, 'past.png') });

// Keyboard: three quarter-hour steps back made quickly, one forward, an hour back with shift. The steps sum to six
// quarter-hours back, and the bar stops at the oldest moment held, which moves up as retention does. The drag ended
// a fraction of the span from the oldest end, so start from the middle, where the whole sum fits with room to spare.
await page.mouse.click(xAt(0.6), y);
await page
  .waitForFunction(
    () => {
      const s = document.getElementById('scrub');
      const { past } = window.__metro.shown();
      return past !== null && Number(s.dataset.at) === past && Math.floor(window.__live.tick) === past;
    },
    null,
    { polling: 100, timeout: MINUTE },
  )
  .catch(async () => fail(`after the click the city did not rest at the handle: ${JSON.stringify(await read())}`));
const start = await sample('after the click', true);
const keysStart = start.shown.past;
if (keysStart - start.min < 2 * HOUR_TICKS)
  await fail(`only ${keysStart - start.min} ticks lie below the handle, too few for the keys to move freely`);
await page.focus('#scrub');
const steps = [
  ['ArrowLeft', -60],
  ['ArrowLeft', -60],
  ['ArrowLeft', -60],
  ['ArrowRight', 60],
  ['Shift+ArrowLeft', -HOUR_TICKS],
];
let expected = keysStart;
for (const [key, delta] of steps) {
  await page.keyboard.press(key);
  expected += delta;
  await sample(`pressing ${key}`);
}
await settled(expected).catch(async () =>
  fail(`after the arrow keys the city did not rest at tick ${expected}: ${JSON.stringify(await read())}`),
);
await sample('after the arrow keys', true);
console.log(`arrow keys ended at tick ${expected}`);

// One step forward inside the hour folds only the records after the shown ones; it must equal a fresh fold.
if (expected % HOUR_TICKS > HOUR_TICKS - 70) {
  await page.keyboard.press('ArrowLeft');
  expected -= 60;
  await settled(expected).catch(() => fail(`the city did not rest at tick ${expected} before the forward step`));
}
await page.keyboard.press('ArrowRight');
expected += 60;
await settled(expected).catch(async () =>
  fail(`after the forward step the city did not rest at ${expected}: ${JSON.stringify(await read())}`),
);
const forward = await sample('after the forward step', true);
if (forward.shown.past !== expected || forward.shown.ticks.some((t) => t !== expected))
  await fail(`the forward step left the state at ${forward.shown.ticks}, not ${expected}`);
const fresh = await page.evaluate((t) => window.__metro.seek(t), expected);
if (fresh.sig !== forward.shown.sig || fresh.buildings !== forward.shown.buildings)
  await fail(`folding forward to ${expected} differs from folding it afresh`);
console.log(`folding forward to tick ${expected} matches a fresh fold`);

// The live city keeps taking records while the past is shown.
const before = Math.max(...(await read()).liveNow.ticks);
await page
  .waitForFunction((b) => Math.max(...window.__metro.live().ticks) > b, before, { polling: 250, timeout: MINUTE })
  .catch(() => fail('the live state stopped advancing while the past was shown'));
if ((await read()).shown.past !== expected) await fail('the past moved while live records arrived');
console.log('live records kept arriving in the past');

// Back to live.
await page.click('#back-live');
await page
  .waitForFunction(() => document.getElementById('scrub').dataset.mode === 'live', null, {
    polling: 100,
    timeout: MINUTE,
  })
  .catch(() => fail('Back to live did not return to the live city'));
await page.waitForTimeout(1000);
const back = await sample('back live');
if (!back.shown.live || back.shown.past !== null)
  await fail('after Back to live the page is not showing the live state');
if (back.shown.sig !== back.liveNow.sig) await fail('after Back to live the city is not the live one');
if (back.max - Math.floor(back.drawn) > 40)
  await fail(`after Back to live the city is at ${back.drawn}, the tip at ${back.max}`);
if (await page.locator('#past').isVisible()) await fail('the past pill is still showing after Back to live');
await page.locator('#timeline').screenshot({ path: join(out, 'bar-back-live.png') });

console.log(`${samples} frames sampled, each whole`);
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
