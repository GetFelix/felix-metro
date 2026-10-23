// Screenshots the built app at one frozen moment on each quality tier, and once with the frame-time HUD.
// Usage: node scripts/shoot-tiers.mjs <app url> <out dir>. The page must already be served.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [appUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: shoot-tiers.mjs <app url> <out dir>');
const FRAMES = 12;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const shots = [
  ['high', '?tier=high&t=18.7&still'],
  ['medium', '?tier=medium&t=18.7&still'],
  ['low', '?tier=low&t=18.7&still'],
  ['hud', '?tier=high&t=18.7&still&hud'],
];

for (const [name, query] of shots) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((frames) => {
    const raf = window.requestAnimationFrame.bind(window);
    let n = 0;
    window.requestAnimationFrame = (cb) => {
      if (++n <= frames) return raf(cb);
      window.__stopped = true;
      return 0;
    };
  }, FRAMES);
  await page.goto(appUrl + query, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForFunction(() => window.__stopped === true, null, { polling: 100, timeout: 120_000 });
  await page.screenshot({ path: join(out, `${name}.png`), timeout: 120_000 });
  await page.close();
  if (errors.length) throw new Error(`${query}:\n${errors.join('\n')}`);
}
await browser.close();
