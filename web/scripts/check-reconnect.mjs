// Opens the live city in headless Chromium against the running dev stack, takes the gateway away for a few seconds and
// checks what a person would see and what the page took: the `Reconnecting…` pill shows, the city's clock keeps
// running, the pill goes away when the gateway is back, and every district's records were taken in order with none
// missing and none taken twice. Also shoots the loading screen, with the gateway's answers slowed so it stays up.
// Usage: node scripts/check-reconnect.mjs <page url> <out dir>, with GATEWAY_STOP and GATEWAY_START set to the commands
// that take the gateway away and bring it back (dev/gateway.sh stop, dev/gateway.sh start). The page url needs ?trace.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [appUrl, out] = process.argv.slice(2);
const { GATEWAY_STOP, GATEWAY_START } = process.env;
if (!out || !GATEWAY_STOP || !GATEWAY_START) {
  throw new Error('usage: GATEWAY_STOP=... GATEWAY_START=... check-reconnect.mjs <page url> <out dir>');
}
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const OUTAGE_MS = 5000;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const fail = async (page, message) => {
  console.error(message);
  await page?.screenshot({ path: join(out, 'reconnect-failure.png') }).catch(() => {});
  await browser.close();
  process.exit(1);
};

// 1. The loading screen: the gateway answers slowly, so the grid of districts is seen filling in. Only for the
// screenshots; a page that does not get through is not what this checks.
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => setTimeout(() => ws.send(message), 1200));
  });
  await page.goto(appUrl, { waitUntil: 'commit', timeout: MINUTE });
  await page.waitForSelector('#loader:not(.hidden)', { timeout: MINUTE });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'loading.png') });
  await page.waitForSelector('.loader-grid i.on', { timeout: MINUTE });
  await page.screenshot({ path: join(out, 'loading-filling.png') });
  console.log('loading screen:', await page.locator('#loader p').textContent());
  await page.close();
} catch (err) {
  console.warn('no screenshot of the loading screen:', String(err).split('\n')[0]);
}

// 2. The outage.
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(appUrl, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 5 * MINUTE })
  .catch(() => fail(page, 'the live city never drew a tick'));
const pill = () => page.locator('#pill').textContent();
const tick = () => page.evaluate(() => window.__live.tick);
const t0 = await tick();
await page
  .waitForFunction((t) => window.__live.tick > t + 8, t0, { polling: 250, timeout: MINUTE })
  .catch(() => fail(page, `the tick stayed at ${t0}`));
if ((await pill()) !== 'LIVE') await fail(page, `the pill says ${await pill()} before the outage`);
console.log(`live at tick ${await tick()}; taking the gateway away`);

const stoppedAt = Date.now();
execSync(GATEWAY_STOP, { stdio: 'inherit' });
await page
  .waitForFunction(() => document.getElementById('pill').textContent === 'Reconnecting…', null, {
    polling: 100,
    timeout: MINUTE,
  })
  .catch(() => fail(page, 'the pill never showed Reconnecting…'));
// Sampled before the screenshot, which is slow on software rendering.
const shown = await tick();
console.log(`pill shows ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s after the stop, at tick ${shown}`);
await page.screenshot({ path: join(out, 'reconnecting.png') });
const wait = OUTAGE_MS - (Date.now() - stoppedAt);
if (wait > 0) await page.waitForTimeout(wait);
const during = await tick();
if (!(during > shown + 2))
  await fail(page, `the city stood still while the gateway was away: tick ${shown} -> ${during}`);
console.log(`the clock ran on while it was away: tick ${shown} -> ${during}`);

execSync(GATEWAY_START, { stdio: 'inherit' });
await page
  .waitForFunction(() => document.getElementById('pill').textContent === 'LIVE', null, {
    polling: 250,
    timeout: 3 * MINUTE,
  })
  .catch(() => fail(page, 'the pill never went back to LIVE'));
const back = await tick();
await page
  .waitForFunction((t) => window.__live.tick > t + 16, back, { polling: 250, timeout: MINUTE })
  .catch(() => fail(page, `the tick stayed at ${back} after the reconnect`));
await page.screenshot({ path: join(out, 'reconnected.png') });
console.log(`live again at tick ${back}; now ${await tick()}`);

// 3. What the page took: per district, each applied tick is the one after the last, and nothing was seen twice.
const trace = await page.evaluate(() => window.__trace ?? []);
const problems = [];
const last = new Map();
const applied = new Map();
for (const [district, t, result] of trace) {
  if (result !== 'applied') {
    problems.push(`district ${district} tick ${t}: ${result}`);
    continue;
  }
  const before = last.get(district);
  if (before !== undefined && t !== before + 1) problems.push(`district ${district}: tick ${before} then ${t}`);
  last.set(district, t);
  applied.set(district, (applied.get(district) ?? 0) + 1);
}
if (applied.size === 0) problems.push('no record was traced; was the page opened with ?trace?');
for (const [district, n] of applied)
  console.log(`district ${district}: ${n} ticks applied, ending at ${last.get(district)}`);
for (const [district, t] of last) {
  if (t < shown) problems.push(`district ${district} stopped at tick ${t}, before the outage began at ${shown}`);
}
if (problems.length) await fail(page, `records out of order:\n${problems.slice(0, 20).join('\n')}`);
console.log(`${trace.length} records taken, every district contiguous with none missing or repeated`);
if (errors.length) await fail(page, errors.join('\n'));
await browser.close();
