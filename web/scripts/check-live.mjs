// Opens the live city in headless Chromium against the running dev stack and checks that it follows the sim: the tick
// on screen advances, a car is drawn and moves, and the day turns to dusk with the tick. Writes screenshots of a day
// moment, dusk and a street close-up. Usage: node scripts/check-live.mjs <page url> <out dir>.
// The sim should run fast (dev/speed.sh harbor 16), so the city reaches its commute and its evening in minutes.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [appUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-live.mjs <page url> <out dir>');
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  console.error('console:', m.text());
  errors.push(`console.error: ${m.text()}`);
});
// The page keeps no history of the pill or of `unplaced`, so watch both for the whole run, not only at the end.
await page.addInitScript(() => {
  window.__watch = { reconnected: false, unplaced: 0 };
  setInterval(() => {
    if (document.getElementById('pill')?.textContent?.startsWith('Reconnecting')) window.__watch.reconnected = true;
    window.__watch.unplaced = Math.max(window.__watch.unplaced, window.__live?.unplaced ?? 0);
  }, 100);
});

const fail = async (message) => {
  console.error(message);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await browser.close();
  process.exit(1);
};

// The page signs in at the dev IdP and comes back, so the first load ends somewhere else than it began.
await page.goto(appUrl, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 5 * MINUTE })
  .catch(() => fail('the live city never drew a tick'));

const clock = () => page.locator('#clock').textContent();
const dayLabel = () => page.locator('#day').textContent();

// 1. The tick on screen advances, and so does the clock a person reads.
const [tick0, clock0] = [await page.evaluate(() => window.__live.tick), await clock()];
await page
  .waitForFunction((t) => window.__live.tick > t + 8, tick0, { polling: 250, timeout: MINUTE })
  .catch(() => fail(`the tick stayed at ${tick0}`));
await page
  .waitForFunction((c) => document.getElementById('clock').textContent !== c, clock0, { polling: 250, timeout: MINUTE })
  .catch(() => fail(`the clock stayed at ${clock0}`));
console.log(`tick ${tick0} -> ${await page.evaluate(() => window.__live.tick)}, clock ${clock0} -> ${await clock()}`);

// 2. A car is drawn and it moves.
await page
  .waitForFunction(() => window.__live.where().some((w) => w.car), null, { polling: 500, timeout: 12 * MINUTE })
  .catch(() => fail('no car was ever drawn'));
// Cars come and go, so follow each by resident from where it was first seen.
const first = new Map();
let moved = 0;
for (let i = 0; i < 40 && moved === 0; i++) {
  for (const w of await page.evaluate(() => window.__live.where().filter((w) => w.car))) {
    const was = first.get(w.resident);
    if (!was) first.set(w.resident, w);
    else if (Math.hypot(w.x - was.x, w.z - was.z) > 0.05) moved++;
  }
  await page.waitForTimeout(500);
}
if (moved === 0) await fail(`${first.size} cars drawn, none moved`);
console.log(`${first.size} cars seen, ${moved} moved`);

// 3. Day follows the tick: a bright hour, then dusk, each looked at from the page.
const shoot = async (name, from, to, minutes) => {
  await page
    .waitForFunction(
      ([a, b]) => (window.__live.tick % 5760) / 240 >= a && (window.__live.tick % 5760) / 240 < b,
      [from, to],
      {
        polling: 500,
        timeout: minutes * MINUTE,
      },
    )
    .catch(async () => fail(`the city never reached ${from}:00 (at ${await clock()})`));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`${name}: ${await dayLabel()} ${await clock()}`);
};
await shoot('day', 11, 15, 12);
await shoot('dusk', 18.2, 19.5, 12);
await page
  .waitForFunction(() => window.__live.closeUp(), null, { polling: 250, timeout: MINUTE })
  .catch(() => fail('no car to look at'));
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'street.png') });

const { reconnected, unplaced } = await page.evaluate(() => window.__watch);
if (unplaced > 0) await fail(`${unplaced} trips matched no route of their resident`);
if (reconnected) await fail('the page lost its session and reconnected');
if (errors.length) await fail(errors.join('\n'));
await browser.close();
