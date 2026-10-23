// Opens the models page and fails if any model does not load, or the page logs an error.
// Usage: node scripts/check-models.mjs <models page url>. The page must already be served.
import { readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [url] = process.argv.slice(2);
if (!url) throw new Error('usage: check-models.mjs <models page url>');

// What is on disk, counted without the app's glob.
const dir = new URL('../../prototype/assets/models/', import.meta.url);
const onDisk = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.glb')).length;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
const result = await page.evaluate(() => window.__result);
await browser.close();

console.log(`${result.loaded} of ${result.total} models loaded (${onDisk} on disk)`);
for (const f of result.failures) console.error(`${f.pack}/${f.name}: ${f.error}`);
for (const e of errors) console.error(`console: ${e}`);
if (result.failures.length || errors.length || result.total !== onDisk) process.exit(1);
