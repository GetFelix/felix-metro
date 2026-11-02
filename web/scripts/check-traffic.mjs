// Draws a generated city with N cars and walkers (web/traffic-load.html) and prints the draw calls and frame times per
// N. The draw calls of a frame must not grow with the number of movers: that is what instancing is for.
// Usage: node scripts/check-traffic.mjs <traffic-load.html url> [tier] [counts, comma separated]
//   TRAFFIC_FRAMES=30 sets the frames timed per count. TRAFFIC_MAX_EXTRA_CALLS bounds the calls N adds over the first N.
import { chromium } from 'playwright';

const [pageUrl, tier = 'high', counts = '0,40,100,200,400'] = process.argv.slice(2);
if (!pageUrl) throw new Error('usage: check-traffic.mjs <traffic-load.html url> [tier] [counts]');
const FRAMES = Number(process.env.TRAFFIC_FRAMES ?? '30');
const MAX_EXTRA =
  process.env.TRAFFIC_MAX_EXTRA_CALLS === undefined ? null : Number(process.env.TRAFFIC_MAX_EXTRA_CALLS);

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function measure(n) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${pageUrl}?n=${n}&tier=${tier}&frames=${FRAMES}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.__ready === true || document.body.dataset.error, null, {
    polling: 200,
    timeout: 600_000,
  });
  const failed = await page.evaluate(() => document.body.dataset.error);
  if (failed) errors.push(failed);
  const load = await page.evaluate(() => window.__load);
  await page.close();
  if (errors.length) throw new Error(`n=${n}:\n${errors.join('\n')}`);
  return load;
}

const rows = [];
for (const n of counts.split(',').map(Number)) rows.push({ n, ...(await measure(n)) });
await browser.close();

console.log(`tier ${tier}, ${FRAMES} frames each (SwiftShader; ms are medians)`);
console.log('asked  drawn  cars  walkers  calls  triangles  geometries  submit ms  frame ms');
for (const r of rows) {
  console.log(
    [r.n, r.movers, r.cars, r.walkers, r.calls, r.triangles, r.geometries, r.submitMs.toFixed(1), r.frameMs.toFixed(1)]
      .map((v, i) => String(v).padStart([5, 6, 4, 7, 5, 9, 10, 9, 8][i]))
      .join('  '),
  );
}
let failed = rows.some((r) => r.movers !== r.n);
if (failed) console.error('FAIL: not every mover was drawn');
if (MAX_EXTRA !== null) {
  const extra = rows[rows.length - 1].calls - rows[0].calls;
  const ok = extra <= MAX_EXTRA;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${rows[rows.length - 1].n} movers add ${extra} draw calls (at most ${MAX_EXTRA})`,
  );
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
