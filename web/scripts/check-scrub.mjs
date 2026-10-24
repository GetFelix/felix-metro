// Scrubs the live city on the timeline bar, by pointer and by keyboard. Throughout: every sampled frame has the city
// drawn, the clock on screen follows the handle, and the city is never held at one moment while the handle crosses
// hours. At rest the city is at the handle's tick. Then "Back to live" returns to the live city. Screenshots of the bar
// live, while dragging and in the past are written to the out dir. Usage: node scripts/check-scrub.mjs <page url> <out dir>
// where the page url has no hash. The sim should have run long enough to hold a few city hours.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const [appUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-scrub.mjs <page url> <out dir>');
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const HOUR_TICKS = 240;
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
    };
  });

const minutesOf = (clock) => {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
};
const tickMinutes = (tick) => Math.floor(((tick % 5760) / 5760) * 24 * 60);

// A frame with nothing drawn is one colour; a city, by day or night, is not.
const blank = async () => {
  // The band between the chips, so the bar and the clock are not counted as a city.
  const png = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 100, width: 1280, height: 480 } }));
  const { data, width, height } = png;
  let differing = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (Math.abs(data[o] - data[0]) > 8 || Math.abs(data[o + 1] - data[1]) > 8 || Math.abs(data[o + 2] - data[2]) > 8)
      differing++;
  }
  return differing / (width * height) < 0.003;
};

let samples = 0;
const sample = async (what) => {
  const r = await read();
  samples++;
  if (await blank()) await fail(`${what}: a sampled frame has no city drawn`);
  const gap = Math.abs(minutesOf(r.clock) - tickMinutes(r.at));
  if (gap > 1 && gap < 24 * 60 - 1) await fail(`${what}: the clock says ${r.clock} with the handle at tick ${r.at}`);
  return r;
};

// The page, once its timeline has a few hours behind it.
await page.goto(`${appUrl}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(
    (need) => {
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
await page.locator('#timeline').screenshot({ path: join(out, 'bar-live.png') });
await page.screenshot({ path: join(out, 'live.png') });

const strip = await page.locator('#scrub .strip').boundingBox();
const y = strip.y + strip.height / 2;
const xAt = (f) => strip.x + strip.width * f;

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
await settled(last).catch(async () =>
  fail(`after the drag the city did not rest at tick ${last}: ${JSON.stringify(await read())}`),
);
const rest = await sample('after the drag');
if (rest.mode !== 'past') await fail(`after the drag the bar says "${rest.mode}"`);
console.log(`drag ended at tick ${last}; ${drawnTicks.size} moments drawn on the way`);

const pill = await page.locator('#past').innerText();
if (!/^(just now|\d+ m ago|\d+ h \d+ m ago)\s*·\s*Back to live$/.test(pill.replace(/\s+/g, ' ').trim()))
  await fail(`the past pill reads "${pill}"`);
console.log(`past pill: "${pill.replace(/\s+/g, ' ').trim()}"`);
await page.locator('#timeline').screenshot({ path: join(out, 'bar-past.png') });
await page.screenshot({ path: join(out, 'past.png') });

// Keyboard: three quarter-hour steps back made quickly, one forward, an hour back with shift.
await page.focus('#scrub');
const steps = [
  ['ArrowLeft', -60],
  ['ArrowLeft', -60],
  ['ArrowLeft', -60],
  ['ArrowRight', 60],
  ['Shift+ArrowLeft', -HOUR_TICKS],
];
let expected = last;
for (const [key, delta] of steps) {
  await page.keyboard.press(key);
  expected += delta;
  await sample(`pressing ${key}`);
}
await settled(expected).catch(async () =>
  fail(`after the arrow keys the city did not rest at tick ${expected}: ${JSON.stringify(await read())}`),
);
await sample('after the arrow keys');
console.log(`arrow keys ended at tick ${expected}`);

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
if (back.max - Math.floor(back.drawn) > 40)
  await fail(`after Back to live the city is at ${back.drawn}, the tip at ${back.max}`);
if (await page.locator('#past').isVisible()) await fail('the past pill is still showing after Back to live');
await page.locator('#timeline').screenshot({ path: join(out, 'bar-back-live.png') });

console.log(`${samples} frames sampled, none blank`);
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
