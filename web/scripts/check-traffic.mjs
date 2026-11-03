// Draws a generated city with N cars and walkers (web/traffic-load.html) and prints the draw calls and frame times per
// N. The draw calls of a frame must not grow with the number of movers, nor with the size of the city: that is what
// instancing is for.
// Usage: node scripts/check-traffic.mjs <traffic-load.html url> [tier] [counts, comma separated]
//   TRAFFIC_FRAMES=30 sets the frames timed per count. TRAFFIC_MAX_EXTRA_CALLS bounds the calls N adds over the first N.
//   TRAFFIC_WAIT_MS bounds how long a page may take to draw its frames (default 5 minutes).
//   TRAFFIC_MAX_CALLS bounds the draw calls of every row (the 2 by 2 city, with its movers).
//   TRAFFIC_RUN_CHECK=1 also opens the page's measuring mode (?run=1) over 16 districts and checks what it writes;
//   TRAFFIC_MAX_RUN_CALLS bounds the draw calls it writes, which the static city alone would put in the tens of thousands.
import { chromium } from 'playwright';

const [pageUrl, tier = 'high', counts = '0,40,100,200,400'] = process.argv.slice(2);
if (!pageUrl) throw new Error('usage: check-traffic.mjs <traffic-load.html url> [tier] [counts]');
const FRAMES = Number(process.env.TRAFFIC_FRAMES ?? '30');
const WAIT_MS = Number(process.env.TRAFFIC_WAIT_MS ?? '300000');
const MAX_CALLS = process.env.TRAFFIC_MAX_CALLS === undefined ? null : Number(process.env.TRAFFIC_MAX_CALLS);
const MAX_RUN_CALLS =
  process.env.TRAFFIC_MAX_RUN_CALLS === undefined ? null : Number(process.env.TRAFFIC_MAX_RUN_CALLS);
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
    timeout: WAIT_MS,
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

// TRAFFIC_RUN_CHECK=1: the page's measuring mode over the 16 districts of the scale goal writes a frame rate on the
// page, and the tier's cap holds the movers drawn to what the live page draws.
let runProblem = null;
if (process.env.TRAFFIC_RUN_CHECK) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  await page.goto(`${pageUrl}?run=1&districts=4&n=400&tier=medium&cap=tier`, { waitUntil: 'load', timeout: 120_000 });
  const text = await page
    .waitForFunction(
      () =>
        document.body.dataset.error ||
        (/fps/.test(document.querySelector('pre')?.textContent ?? '') && document.querySelector('pre').textContent),
      null,
      {
        polling: 500,
        timeout: WAIT_MS,
      },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  console.log(text ?? 'the page wrote no frame rate');
  if (problems.length) text && (runProblem = `the measuring mode logged errors:\n${problems.join('\n')}`);
  const drawn = Number(text?.match(/(\d+) of 400 movers/)?.[1]);
  if (!runProblem && (!text?.includes('16 districts') || !(drawn > 0 && drawn <= 160)))
    runProblem = `the measuring mode did not show 16 districts with at most 160 of 400 movers drawn: ${text}`;
  const runCalls = Number(text?.match(/(\d+) draws/)?.[1]);
  if (!runProblem && MAX_RUN_CALLS !== null && !(runCalls <= MAX_RUN_CALLS))
    runProblem = `16 districts drew ${runCalls} calls, more than ${MAX_RUN_CALLS}: the static city is not instanced`;
  await page.close();
}
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
if (runProblem) {
  console.error(`FAIL: ${runProblem}`);
  failed = true;
}
if (MAX_CALLS !== null) {
  const worst = Math.max(...rows.map((r) => r.calls));
  const ok = worst <= MAX_CALLS;
  console.log(`${ok ? 'ok  ' : 'FAIL'} at most ${worst} draw calls in a frame (at most ${MAX_CALLS})`);
  failed ||= !ok;
}
if (MAX_EXTRA !== null) {
  const extra = rows[rows.length - 1].calls - rows[0].calls;
  const ok = extra <= MAX_EXTRA;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${rows[rows.length - 1].n} movers add ${extra} draw calls (at most ${MAX_EXTRA})`,
  );
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
