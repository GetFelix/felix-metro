// Screenshots the built app and the prototype style frame at the same frozen moment and measures how far apart they
// are. Usage: node scripts/compare-frame.mjs <app url> <style frame url> <out dir>. Both pages must already be served.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import pngjs from 'pngjs';

const [appUrl, frameUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: compare-frame.mjs <app url> <style frame url> <out dir>');
const T = process.env.FRAME_T ?? '12';
const [W, H] = [1920, 1080];
const FRAMES = 8;
const MIN_COLOURS = 30;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// The style frame draws each pedestrian's pose and speed after its model loads, so the numbers go to whichever person's
// model arrives first and the poses differ from run to run. The app draws them before the load; this makes the style
// frame do the same, in the same order.
// The same seeding as web/src/renderer.ts, for the style frame's ambient occlusion noise.
function seeded(make) {
  const original = Math.random;
  let a = 1;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return make();
  } finally {
    Math.random = original;
  }
}

function drawPeopleEarly(html) {
  const from = "const gltf = await model('mini-characters', pick(PEOPLE));";
  const to =
    'const name = pick(PEOPLE); const phase = rand() * 2, speed = 0.22 + rand() * 0.08;' +
    " const gltf = await model('mini-characters', name);";
  const swaps = [
    [from, to],
    ['mixer.setTime(rand() * 2);', 'mixer.setTime(phase);'],
    ['speed: 0.22 + rand() * 0.08', 'speed'],
    [
      'const ao = new GTAOPass(scene, camera, innerWidth, innerHeight);',
      `const ao = (${seeded.toString()})(() => new GTAOPass(scene, camera, innerWidth, innerHeight));`,
    ],
  ];
  for (const [a, b] of swaps) {
    if (html.split(a).length !== 2) throw new Error(`the style frame no longer contains: ${a}`);
    html = html.replace(a, b);
  }
  return html;
}

async function shoot(url, file) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (url.includes('style-frame')) {
    await page.route(
      (u) => u.pathname.endsWith('style-frame.html'),
      async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, body: drawPeopleEarly(await res.text()) });
      },
    );
  }
  await page.addInitScript((frames) => {
    const raf = window.requestAnimationFrame.bind(window);
    let n = 0;
    window.requestAnimationFrame = (cb) => {
      if (++n <= frames) return raf(cb);
      window.__stopped = true;
      return 0;
    };
  }, FRAMES);
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // Ambient occlusion varies from frame to frame, so each page stops after the same number of frames.
  await page.waitForFunction(() => window.__stopped === true, null, { polling: 100, timeout: 60_000 });
  await page.screenshot({ path: join(out, file), timeout: 120_000 });
  await page.close();
  if (errors.length) throw new Error(`${url}:\n${errors.join('\n')}`);
}

await shoot(`${frameUrl}?t=${T}&still`, 'style-frame.png');
await shoot(`${appUrl}?t=${T}&still`, 'app.png');
await browser.close();

const read = (f) => pngjs.PNG.sync.read(readFileSync(join(out, f)));
const [a, b] = [read('style-frame.png'), read('app.png')];
// A page that drew nothing, or only sky and ground, would match another that did the same. The middle of the frame is
// where the city is, so it must hold many distinct colours (4 bits a channel) that each cover a visible share of it.
for (const [name, png] of [
  ['style frame', a],
  ['app', b],
]) {
  const bins = new Map();
  let total = 0;
  for (let y = Math.floor(H * 0.3); y < Math.floor(H * 0.8); y++) {
    for (let x = Math.floor(W * 0.2); x < Math.floor(W * 0.8); x++) {
      const i = (y * W + x) * 4;
      const key = ((png.data[i] >> 4) << 8) | ((png.data[i + 1] >> 4) << 4) | (png.data[i + 2] >> 4);
      bins.set(key, (bins.get(key) ?? 0) + 1);
      total++;
    }
  }
  const colours = [...bins.values()].filter((n) => n >= total * 0.0005).length;
  console.log(`${name}: ${colours} distinct colours in the middle of the frame`);
  if (colours < MIN_COLOURS) throw new Error(`the ${name} screenshot shows only ${colours} colours in the middle`);
}
const diff = new pngjs.PNG({ width: W, height: H });
const differing = pixelmatch(a.data, b.data, diff.data, W, H, { threshold: 0.1 });
writeFileSync(join(out, 'diff.png'), pngjs.PNG.sync.write(diff));
let sum = 0;
let max = 0;
for (let i = 0; i < a.data.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(a.data[i + c] - b.data[i + c]);
    sum += d;
    max = Math.max(max, d);
  }
}
const result = {
  t: Number(T),
  differingPixels: differing,
  differingPercent: Number(((100 * differing) / (W * H)).toFixed(4)),
  meanAbsoluteError: Number((sum / (W * H * 3)).toFixed(4)),
  maxChannelDifference: max,
};
writeFileSync(join(out, 'diff.json'), JSON.stringify(result, null, 2) + '\n');
console.log(result);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### App against the style frame at t=${T}\n\n` +
      `${result.differingPixels} pixels differ (${result.differingPercent}%), ` +
      `mean absolute error ${result.meanAbsoluteError} of 255, largest channel difference ${max}.\n`,
  );
}
const limit = Number(process.env.FRAME_MAX_DIFFERING_PERCENT ?? '100');
if (result.differingPercent > limit) {
  console.error(`more than ${limit}% of pixels differ`);
  process.exit(1);
}
