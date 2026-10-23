// Runs the app with every frame made slow and checks the automatic choice: high, then medium, then low, with the
// passes it dropped freed. Usage: node scripts/check-quality.mjs <app url>. The page must already be served.
import { chromium } from 'playwright';

const [appUrl] = process.argv.slice(2);
if (!appUrl) throw new Error('usage: check-quality.mjs <app url>');

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${appUrl}?t=18.7&slow=40&hud`, { waitUntil: 'load', timeout: 120_000 });
await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
await page.waitForFunction(() => window.__quality?.memory.some((m) => m.tier === 'low'), null, {
  polling: 500,
  timeout: 600_000,
});
const { history, memory } = await page.evaluate(() => ({
  history: [...window.__quality.history],
  memory: window.__quality.memory.map((m) => ({ ...m })),
}));
await browser.close();
console.log(JSON.stringify({ history, memory }));

const problems = [...errors];
if (history.join() !== 'high,medium,low') problems.push(`tiers went ${history.join(' > ')}, not high > medium > low`);
const at = (t) => memory.find((m) => m.tier === t);
const [high, low] = [at('high'), at('low')];
if (!high || !low) problems.push('no memory reading for high and low');
else {
  if (low.textures > high.textures) problems.push(`textures grew from ${high.textures} to ${low.textures}`);
  if (low.geometries > high.geometries) problems.push(`geometries grew from ${high.geometries} to ${low.geometries}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
