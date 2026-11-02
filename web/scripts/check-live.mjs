// Opens the live city in headless Chromium against the running dev stack and checks that it follows the sim: the tick
// on screen advances, a car is drawn and moves, and the day turns to dusk with the tick. Writes screenshots of a day
// moment, dusk and a street close-up. A car picked with a click is followed. Usage: node scripts/check-live.mjs <page url> <out dir>.
// The sim should run fast (dev/speed.sh harbor 16), so the city reaches its commute and its evening in minutes.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-live.mjs <page url> <out dir>');
const appUrl = withTrace(pageUrl);
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
// 3. Click a car to follow it: the camera stays on them and the card keeps saying what they are doing. The copied link
// names them. The clipboard is replaced, since a headless page may not be allowed one.
await page.evaluate(() => {
  window.__copied = null;
  if (navigator.clipboard) navigator.clipboard.writeText = async (text) => void (window.__copied = text);
});
// A click picks among the cars drawn in the last frame, and a runner draws only a few frames a second while the sim runs
// at 16x, so a car has moved on from where it was drawn by the time the click lands. Aim at the car that moved least
// between two looks, and click again at a fresh one when that missed.
const carsInView = () =>
  page.evaluate(() => {
    const onScreen = (s) => s && s.x > 40 && s.x < innerWidth - 40 && s.y > 120 && s.y < innerHeight - 140;
    const found = [];
    for (const w of window.__live.where().filter((w) => w.car)) {
      const s = window.__following.screenOf(w.resident);
      if (onScreen(s)) found.push({ resident: w.resident, x: s.x, y: s.y });
    }
    return found;
  });
const aim = async () => {
  const before = await carsInView();
  await page.waitForTimeout(250);
  const after = new Map((await carsInView()).map((c) => [c.resident, c]));
  const steady = before
    .filter((c) => after.has(c.resident))
    .map((c) => ({
      ...after.get(c.resident),
      drift: Math.hypot(after.get(c.resident).x - c.x, after.get(c.resident).y - c.y),
    }))
    .sort((a, b) => a.drift - b.drift);
  return steady[0] ?? null;
};
const CLICKS = 8;
let followedNobody = 0;
for (
  let attempt = 1;
  attempt <= CLICKS && (await page.evaluate(() => window.__following.resident())) === null;
  attempt++
) {
  let car = null;
  for (let i = 0; i < 60 && !car; i++) {
    car = await aim();
    if (!car) await page.waitForTimeout(500);
  }
  if (!car) await fail('no car was in view to click');
  await page.mouse.click(car.x, car.y);
  const hit = await page
    .waitForFunction(() => window.__following.resident() !== null, null, { polling: 100, timeout: 3000 })
    .then(
      () => true,
      () => false,
    );
  if (!hit) {
    followedNobody++;
    console.log(
      `click ${attempt} at ${car.x.toFixed(0)}, ${car.y.toFixed(0)} (a car drifting ${car.drift.toFixed(1)} px in 250 ms) followed nobody, ${(await page.evaluate(() => window.__live.fps)).toFixed(1)} fps`,
    );
  }
}
if ((await page.evaluate(() => window.__following.resident())) === null)
  await fail(`${CLICKS} clicks on a car followed nobody`);
if (followedNobody) console.log(`${followedNobody} clicks missed before one followed`);
const followed = await page.evaluate(() => window.__following.resident());
await page
  .waitForFunction(() => !document.getElementById('follow').hidden, null, { polling: 100, timeout: 5000 })
  .catch(() => fail('the card did not show'));
console.log(`followed resident ${followed}: ${await page.locator('#follow [data-name]').textContent()}`);
await page.waitForTimeout(6000);
const after = await page.evaluate((r) => {
  const w = window.__live.where().find((x) => x.resident === r);
  const c = window.__camera.state();
  return {
    who: window.__following.resident(),
    d: w ? Math.hypot(c.x - w.x, c.z - w.z) : null,
    doing: document.querySelector('#follow [data-doing]').textContent,
  };
}, followed);
if (after.who !== followed) await fail(`the follow moved from resident ${followed} to ${after.who}`);
if (after.d !== null && after.d > 0.5)
  await fail(`the camera is ${after.d.toFixed(2)} tiles from the resident followed`);
if (after.doing === '') await fail('the card says nothing about what they are doing');
console.log(`still on resident ${followed}: "${after.doing}"`);
await page.screenshot({ path: join(out, 'follow.png') });
await page.click('#share-button');
const copied = await page.evaluate(() => window.__copied);
if (!copied?.includes(`follow=${followed}`))
  await fail(`the shared link does not name the resident followed: ${copied}`);
await page.keyboard.press('Escape');
if (await page.locator('#follow').isVisible()) await fail('Esc did not stop following');
if ((await page.evaluate(() => window.__following.resident())) !== null) await fail('Esc left someone followed');

const load = () =>
  page.evaluate(() => ({ movers: window.__live.movers, capped: window.__live.capped, fps: window.__live.fps }));

// 4. Day follows the tick: a bright hour, then dusk, each looked at from the page.
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
  const l = await load();
  console.log(
    `${name}: ${await dayLabel()} ${await clock()}, ${l.movers} movers drawn, ${l.capped} capped, ${l.fps.toFixed(1)} fps`,
  );
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
