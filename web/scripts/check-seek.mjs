// Opens the live city, then opens the same city at an earlier tick and checks that it is drawn there: the tick on screen
// is the tick asked for, and the city took under a second to find. Usage: node scripts/check-seek.mjs <page url> <out dir>
// where the page url has no hash. The sim should have run for a while so there is something earlier to go to.
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

// A tick a hundred or so back, and one a few keyframes back, so a seek crosses a keyframe and not only a hot one.
const targets = [newest - 100, Math.floor(newest / 2), 7];
for (const t of targets) {
  await page.goto(`${appUrl}?at=${t}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
  await page
    .waitForFunction(() => window.__seek?.drawMs !== null && window.__seek?.drawMs !== undefined, null, {
      polling: 100,
      timeout: MINUTE,
    })
    .catch(() => fail(`the city never drew at tick ${t}`));
  await page.waitForTimeout(500);
  const { tick, seekMs, drawMs, reads } = await page.evaluate(() => window.__seek);
  const shown = await page.evaluate(() => window.__live.tick);
  const pill = await page.locator('#pill').textContent();
  console.log(
    `seek to tick ${t}: shown ${shown}, found in ${seekMs.toFixed(0)} ms (${reads} reads), first frame ${drawMs.toFixed(0)} ms later, "${pill}"`,
  );
  if (shown !== t || tick !== t) await fail(`asked for tick ${t}, the page shows ${shown}`);
  if (!/^Earlier/.test(pill ?? '')) await fail(`the page does not say it is showing the past: "${pill}"`);
  if (seekMs > BUDGET_MS) await fail(`seeking to ${t} took ${seekMs.toFixed(0)} ms, over ${BUDGET_MS} ms`);
  await page.screenshot({ path: join(out, `at-${t}.png`) });
}
if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
