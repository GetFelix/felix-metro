// A car and a walker drawn close up by web/traffic-load.html (?show=1), compared with the renders kept in
// web/references: the walker at two moments of its walk cycle, and the car at night with its lights on. A wrong row
// of the baked walk texture, a wrong phase or a missing light changes the picture. The two walk poses must also differ
// from each other, so a walker frozen in one pose fails even if it matches one reference.
// Usage: node scripts/check-traffic-pictures.mjs <traffic-load.html url> <out dir>   (UPDATE_REFERENCES=1 rewrites them)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import pngjs from 'pngjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-traffic-pictures.mjs <traffic-load.html url> <out dir>');
const REFERENCES = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');
const [W, H] = [800, 600];
// Where the car and the walker are in the frame.
const CLIP = { x: 60, y: 200, width: 680, height: 220 };
// A render against its reference on another machine's software GL, as a share of the clip.
const REFERENCE = Number(process.env.TRAFFIC_REFERENCE_PERCENT ?? '1');
// Two poses of one walker: a leg and an arm move, which is this much of the clip at least.
const DIFFERENT = Number(process.env.TRAFFIC_POSE_PERCENT ?? '0.3');
mkdirSync(out, { recursive: true });
mkdirSync(REFERENCES, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function shoot(name, query) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${pageUrl}?show=1&tier=medium&${query}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.__ready === true || document.body.dataset.error, null, {
    polling: 100,
    timeout: 120_000,
  });
  const failed = await page.evaluate(() => document.body.dataset.error);
  if (failed) errors.push(failed);
  const png = await page.screenshot({ clip: CLIP, timeout: 120_000 });
  writeFileSync(join(out, `${name}.png`), png);
  await page.close();
  if (errors.length) throw new Error(`${query}:\n${errors.join('\n')}`);
  return png;
}

const read = (png) => pngjs.PNG.sync.read(png);
const percent = (a, b) =>
  (100 * pixelmatch(read(a).data, read(b).data, null, CLIP.width, CLIP.height, { threshold: 0.1 })) /
  (CLIP.width * CLIP.height);
let failed = false;
const expect = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
};

const shots = {
  'traffic-walk-start': await shoot('walk-start', 't=12&walk=0'),
  'traffic-walk-mid': await shoot('walk-mid', 't=12&walk=0.3'),
  'traffic-night': await shoot('night', 't=20&walk=0.3'),
};
await browser.close();

for (const [name, png] of Object.entries(shots)) {
  const reference = join(REFERENCES, `${name}.png`);
  if (process.env.UPDATE_REFERENCES || !existsSync(reference)) {
    writeFileSync(reference, png);
    console.log(`wrote ${reference}`);
    continue;
  }
  const p = percent(png, readFileSync(reference));
  expect(p < REFERENCE, `${name} matches its reference (${p.toFixed(4)}% differ)`);
}
const moved = percent(shots['traffic-walk-start'], shots['traffic-walk-mid']);
expect(moved > DIFFERENT, `the walker's two poses differ (${moved.toFixed(4)}% of the clip)`);
process.exit(failed ? 1 : 0);
