// The ambient life at fixed ticks, drawn by web/ambient.html. Every effect is a function of the tick on screen, so a tick
// must draw the same picture however it was reached (here: first, and again after other ticks, as a rewind or a seek
// reaches it), the effects must be there when they should and gone when they should not, and a tier that draws less
// must draw less. Usage: node scripts/check-ambient.mjs <ambient.html url> <out dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-ambient.mjs <ambient.html url> <out dir>');
mkdirSync(out, { recursive: true });
const [W, H] = [800, 600];
// A frame drawn twice at a tick, in one page: the share of pixels that may differ.
const SAME = Number(process.env.AMBIENT_SAME_PERCENT ?? '0.02') / 100;
const HOUR = 240;
const DAY = 5760;
const at = (hour) => Math.round(hour * HOUR);

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function run(name, query) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${pageUrl}?${query}`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.__ready === true || document.body.dataset.error, null, {
    polling: 100,
    timeout: 240_000,
  });
  const failed = await page.evaluate(() => document.body.dataset.error);
  if (failed) errors.push(failed);
  const result = await page.evaluate(() => window.__ambient);
  if (query.indexOf('draw=0') < 0) writeFileSync(join(out, `${name}.png`), await page.screenshot({ timeout: 120_000 }));
  await page.close();
  if (errors.length) throw new Error(`${query}:\n${errors.join('\n')}`);
  return result.frames;
}

let failed = false;
const expect = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
};

// Work (11:00), dawn (06:15), evening (18:45) and the dead of night (03:00), then work and dawn again: the last two are
// reached by going back, from a later tick.
const noon = at(11);
const dawn = at(6.25);
const evening = at(18.75);
const night = at(3);
const frames = await run('medium', `tier=medium&ticks=${[noon, dawn, evening, night, noon, dawn].join(',')}`);
const [fNoon, fDawn, fEvening, fNight, fNoonAgain, fDawnAgain] = frames;
expect(
  fNoonAgain.hash === fNoon.hash && fNoonAgain.differs <= SAME,
  `tick ${noon} draws the same after a rewind (${(fNoonAgain.differs * 100).toFixed(4)}% of pixels differ)`,
);
expect(
  fDawnAgain.hash === fDawn.hash && fDawnAgain.differs <= SAME,
  `tick ${dawn} draws the same after a rewind (${(fDawnAgain.differs * 100).toFixed(4)}% of pixels differ)`,
);
expect(
  JSON.stringify(fNoonAgain.counts) === JSON.stringify(fNoon.counts) &&
    JSON.stringify(fDawnAgain.counts) === JSON.stringify(fDawn.counts),
  'the same counts of every effect at a tick reached again',
);
expect(
  new Set([fNoon.hash, fDawn.hash, fEvening.hash, fNight.hash]).size === 4,
  'four different times draw four pictures',
);

const c = (f) => f.counts;
expect(
  c(fNoon).shops > 0 && c(fNoon).puffs > 0 && c(fNoon).vans > 0,
  `at 11:00 shops, smoke and vans are out (${JSON.stringify(c(fNoon))})`,
);
expect(c(fDawn).birds > 0, `at 06:15 birds are on the roofs (${c(fDawn).birds})`);
expect(
  c(fEvening).shops > 0 && c(fEvening).puffs === 0 && c(fEvening).vans === 0,
  'at 18:45 shops are lit and the factories and vans are done',
);
expect(
  c(fNight).shops + c(fNight).puffs + c(fNight).birds + c(fNight).vans + c(fNight).truck === 0,
  'at 03:00 nothing is lit, smoking, perched or driving',
);
for (const f of frames)
  expect(f.counts.green + f.counts.amber + f.counts.red > 0, `tick ${f.tick}: the crossings show a light`);

// A day and a half at a quarter hour a tick, counted without drawing: when each effect is on.
const sweep = [];
for (let t = 0; t < DAY * 1.5; t += 60) sweep.push(t);
const counts = await run('sweep', `tier=high&draw=0&ticks=${sweep.join(',')}`);
const hours = (pick) => counts.filter((f) => pick(f.counts) > 0).map((f) => (f.tick % DAY) / HOUR);
const within = (list, from, to) => list.every((h) => h >= from && h <= to);
const smoke = hours((k) => k.puffs);
const vans = hours((k) => k.vans);
const trucks = hours((k) => k.truck);
const birds = hours((k) => k.birds);
const shops = hours((k) => k.shops);
expect(
  smoke.length > 0 && within(smoke, 5.5, 19.2),
  `smoke only on work hours (${Math.min(...smoke)} to ${Math.max(...smoke)})`,
);
expect(
  vans.length > 0 && within(vans, 8, 17.5),
  `vans only on trading hours (${Math.min(...vans)} to ${Math.max(...vans)})`,
);
expect(
  trucks.length > 0 && within(trucks, 6, 11),
  `the garbage truck only in the morning (${Math.min(...trucks)} to ${Math.max(...trucks)})`,
);
expect(
  birds.length > 0 && within(birds, 5, 8.7),
  `birds only at dawn (${Math.min(...birds)} to ${Math.max(...birds)})`,
);
expect(
  shops.length > 0 && within(shops, 7.5, 22.2),
  `shops lit only in business hours (${Math.min(...shops)} to ${Math.max(...shops)})`,
);
// The second day is not the first: the rounds are planned from the day.
const day1 = counts.filter((f) => f.tick < DAY).map((f) => f.counts.vans + 100 * f.counts.truck);
const day2 = counts.filter((f) => f.tick >= DAY).map((f) => f.counts.vans + 100 * f.counts.truck);
expect(day1.slice(0, day2.length).join() !== day2.join(), 'the rounds on day two are not the rounds of day one');

// The low tier draws the shop windows and nothing that moves; medium draws fewer than high.
const [low] = await run('low', `tier=low&ticks=${noon}`);
expect(
  low.counts.shops > 0 &&
    low.counts.puffs + low.counts.vans + low.counts.green + low.counts.amber + low.counts.red === 0,
  `the low tier keeps the shops and drops the rest (${JSON.stringify(low.counts)})`,
);
const [high] = await run('high', `tier=high&ticks=${noon}`);
expect(
  fNoon.counts.puffs < high.counts.puffs && fNoon.counts.vans <= high.counts.vans,
  `medium draws less smoke and no more vans than high (${fNoon.counts.puffs}/${high.counts.puffs}, ${fNoon.counts.vans}/${high.counts.vans})`,
);
// With the ambient life left out the picture is the plain city.
const [plain] = await run('plain', `tier=medium&ambient=0&ticks=${noon}`);
expect(
  plain.counts === null && plain.hash !== fNoon.hash,
  'the same tick without the ambient life draws a different picture',
);

await browser.close();
process.exit(failed ? 1 : 0);
