// A lot going up and a lot coming down, drawn at a frozen tick by web/construction.html and compared with the reference
// renders in web/references. Every route to a tick (run forward, seek past a keyframe, rewind) must draw the same
// picture, and the middle of a window must differ from before it and after it.
// Usage: node scripts/check-construction.mjs <construction.html url> <out dir>   (UPDATE_REFERENCES=1 rewrites them)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import pngjs from 'pngjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-construction.mjs <construction.html url> <out dir>');
const REFERENCES = join(dirname(fileURLToPath(import.meta.url)), '..', 'references');
const [W, H] = [800, 600];
// Between two routes to one tick, and between a render and its reference on another machine's software GL.
const SAME = Number(process.env.CONSTRUCTION_SAME_PERCENT ?? '0.02');
const REFERENCE = Number(process.env.CONSTRUCTION_REFERENCE_PERCENT ?? '1');
// A window's middle against the ends: scaffolding and a partial building change this much of the frame at least.
const DIFFERENT = 0.3;
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
  await page.goto(`${pageUrl}?${query}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.__ready === true || document.body.dataset.error, null, {
    polling: 100,
    timeout: 180_000,
  });
  const failed = await page.evaluate(() => document.body.dataset.error);
  if (failed) errors.push(failed);
  const state = await page.evaluate(() => window.__construction);
  const png = await page.screenshot({ timeout: 120_000 });
  writeFileSync(join(out, `${name}.png`), png);
  await page.close();
  if (errors.length) throw new Error(`${query}:\n${errors.join('\n')}`);
  return { png: pngjs.PNG.sync.read(png), state };
}

const percent = (a, b) => (100 * pixelmatch(a.data, b.data, null, W, H, { threshold: 0.1 })) / (W * H);
let failed = false;
const expect = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
};

for (const mode of ['build', 'demolish']) {
  const reference = join(REFERENCES, mode === 'build' ? 'construction-rise.png' : 'construction-fall.png');
  const shot = (tick, via = 'forward', extra = '') =>
    shoot(`${mode}-${tick}-${via}${extra}`, `mode=${mode}&tick=${tick}&via=${via}${extra}`);
  const mid = await shot(104);
  const before = await shot(98);
  const after = await shot(112);
  const later = await shot(140);
  expect(mid.state.active === 1, `${mode}: one lot is mid-window at tick 104`);
  expect(before.state.active === 0 && after.state.active === 0, `${mode}: none before the event or after the window`);
  expect(percent(mid.png, before.png) > DIFFERENT, `${mode}: tick 104 differs from before the event`);
  expect(percent(mid.png, after.png) > DIFFERENT, `${mode}: tick 104 differs from after the window`);
  expect(percent(after.png, later.png) < SAME, `${mode}: nothing is left of the animation after the window`);
  for (const via of ['seek', 'back']) {
    const other = await shot(104, via);
    const p = percent(mid.png, other.png);
    expect(p < SAME, `${mode}: ${via} draws tick 104 as a forward run does (${p.toFixed(4)}% differ)`);
    expect(other.state.active === 1, `${mode}: ${via} finds the lot mid-window`);
  }
  // The low tier leaves out the scaffold and the dust but still scales the building.
  const low = await shot(104, 'forward', '&tier=low');
  expect(
    low.state.active === 1 && percent(low.png, mid.png) > 0,
    `${mode}: the low tier still animates, with no extras`,
  );

  if (process.env.UPDATE_REFERENCES) {
    writeFileSync(reference, readFileSync(join(out, `${mode}-104-forward.png`)));
    console.log(`wrote ${reference}`);
  } else if (!existsSync(reference)) {
    expect(false, `${mode}: ${reference} is missing`);
  } else {
    const p = percent(mid.png, pngjs.PNG.sync.read(readFileSync(reference)));
    expect(p < REFERENCE, `${mode}: tick 104 matches its reference (${p.toFixed(4)}% differ)`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
