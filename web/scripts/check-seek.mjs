// Opens the live city and seeks it to earlier ticks through the page's own seek: every district's folded tick is the tick
// asked for, the city it folds to matches the live page's, and it is drawn within a second of the call. Then it opens the
// same ticks cold with ?at= and logs how long that takes. Usage: node scripts/check-seek.mjs <page url> <out dir> where the
// page url has no hash. The sim should have run for a while so there is something earlier to go to.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [appUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-seek.mjs <page url> <out dir>');
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const BUDGET_MS = 1000;

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

// The live page tells how far the city has got.
await page.goto(`${appUrl}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 5 * MINUTE })
  .catch(() => fail('the live city never drew a tick'));
const newest = Math.floor(await page.evaluate(() => window.__live.tick));
if (newest < 300) await fail(`only ${newest} ticks exist; the sim needs to run longer`);

// The live page's own history connection is opened ahead, as the timeline will, so the budget below is the seek itself.
const prepared = await page.evaluate(async () => {
  const t0 = performance.now();
  await window.__metro.prepare();
  return performance.now() - t0;
});
console.log(`history connection opened in ${prepared.toFixed(0)} ms`);

// The folded city must be the live one. The live page's buildings are read before and after a seek to the newest tick
// every district has; if they did not change in between, the fold has to show the same ones.
let matched = false;
for (let attempt = 0; attempt < 5 && !matched; attempt++) {
  const before = await page.evaluate(() => window.__metro.live());
  const at = Math.min(...before.ticks) - 1;
  const folded = await page.evaluate((t) => window.__metro.seek(t), at);
  const after = await page.evaluate(() => window.__metro.live());
  if (before.sig !== after.sig) continue;
  if (folded.sig !== before.sig || folded.buildings !== before.buildings) {
    await fail(
      `the city folded to tick ${at} has ${folded.buildings} buildings (${folded.sig}); the live page has ${before.buildings} (${before.sig})`,
    );
  }
  matched = true;
  console.log(`fold at tick ${at} matches the live page: ${folded.buildings} buildings`);
}
if (!matched) console.warn('the live page kept changing; the fold could not be compared to it');

// A tick a hundred or so back, and one a few keyframes back, so a seek crosses a keyframe and not only a hot one.
const targets = [newest - 100, Math.floor(newest / 2), 7];
const folded = {};
for (const t of targets) {
  const r = await page.evaluate((tick) => window.__metro.seek(tick), t);
  const pill = await page.locator('#pill').textContent();
  const shown = await page.evaluate(() => window.__live.tick);
  console.log(
    `seek to tick ${t}: ${r.ms.toFixed(0)} ms from the call to the first frame (${r.reads} reads in all), districts at [${r.ticks}], offsets [${r.offsets}], ${r.buildings} buildings, "${pill}"`,
  );
  folded[t] = r;
  if (!r.exact || r.tick !== t) await fail(`asked for tick ${t}, got ${r.tick}`);
  if (r.ticks.length === 0 || r.ticks.some((x) => x !== t)) await fail(`districts folded to [${r.ticks}], not ${t}`);
  if (r.offsets.some((o) => !Number.isInteger(o) || o < 0)) await fail(`offsets [${r.offsets}] are not offsets`);
  if (shown !== t) await fail(`the page shows tick ${shown}, not ${t}`);
  if (!/^Earlier/.test(pill ?? '')) await fail(`the page does not say it is showing the past: "${pill}"`);
  if (r.ms > BUDGET_MS) await fail(`seeking to ${t} took ${r.ms.toFixed(0)} ms, over ${BUDGET_MS} ms`);
  await page.screenshot({ path: join(out, `at-${t}.png`) });
}

// The same ticks opened cold, a page apiece: not under the budget, which is for a page already loaded.
for (const t of targets) {
  await page.goto(`${appUrl}?at=${t}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
  await page
    .waitForFunction(() => window.__seek?.drawMs !== null && window.__seek?.drawMs !== undefined, null, {
      polling: 100,
      timeout: MINUTE,
    })
    .catch(() => fail(`the city never drew at tick ${t}`));
  await page.waitForTimeout(500);
  const { tick, seekMs, drawMs, reads, ticks } = await page.evaluate(() => window.__seek);
  const shown = await page.evaluate(() => window.__live.tick);
  const cold = await page.evaluate(() => window.__metro.live());
  console.log(
    `cold ?at=${t}: shown ${shown}, found in ${seekMs.toFixed(0)} ms (${reads} reads), first frame ${drawMs.toFixed(0)} ms later`,
  );
  if (shown !== t || tick !== t || ticks.some((x) => x !== t))
    await fail(`asked for tick ${t}, the page shows ${shown}`);
  // A page with nothing cached folds to the same city as the one that had seeked around.
  if (cold.sig !== folded[t].sig) await fail(`a cold page at tick ${t} differs from the one already open`);
}
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
