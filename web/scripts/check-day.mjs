// Follows a resident in the live city and checks the card's day against the log: the trips and arrivals in the list are
// the `trip` and `arrived` events the sim wrote for that resident that day, no more and no fewer, and a click on an
// entry seeks to its tick. The log is read by a second client that decodes the events itself (dev/lib/gateway.mjs),
// so the card is not checked against its own reading. Usage: node scripts/check-day.mjs <page url> <out dir> where the
// page url has no hash. The sim should have run long enough for residents to have made trips.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { DISTRICTS, Session, sleep } from '../../dev/lib/gateway.mjs';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-day.mjs <page url> <out dir>');
const appUrl = withTrace(pageUrl);
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const TICKS_PER_DAY = 5760;
const KINDS = { trip: 'trip', arrived: 'stay', replan: 'replan' };

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
const fail = async (message) => {
  console.error(message);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await browser.close();
  process.exit(1);
};

await page.goto(`${appUrl}#harbor`, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 5 * MINUTE })
  .catch(() => fail('the live city never drew a tick'));
const day = Math.floor((await page.evaluate(() => window.__live.tick)) / TICKS_PER_DAY);

// The log as a plain client reads it: every district from its first record, until all have reached the tick on screen.
const reader = new Session('harbor', 'viewer', { name: 'check-day' });
await reader.join();
reader.follow(Array.from({ length: DISTRICTS }, () => 0));
const wanted = await page.evaluate(() => Math.floor(window.__live.tick));
for (let waited = 0; ; waited += 500) {
  const ticks = [...reader.last.values()].map((l) => l.tick);
  if (ticks.length === DISTRICTS && Math.min(...ticks) >= wanted) break;
  if (waited > 2 * MINUTE)
    await fail(`the log reader only reached ${JSON.stringify([...reader.last])}, short of ${wanted}`);
  await sleep(500);
}
reader.ws.close();
const upTo = Math.min(...[...reader.last.values()].map((l) => l.tick));

/** What the log says one resident did in a day, up to `upTo`: [kind, tick] pairs. */
const byTick = (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]);
const expected = (resident, which) =>
  reader.records
    .filter((r) => r.tick >= which * TICKS_PER_DAY && r.tick < (which + 1) * TICKS_PER_DAY && r.tick <= upTo)
    .flatMap((r) =>
      r.events.filter((e) => e.resident === resident && KINDS[e.type]).map((e) => [KINDS[e.type], r.tick]),
    )
    .sort(byTick);

// The resident with the most trips that day: enough to have a day worth checking.
const trips = new Map();
for (const r of reader.records) {
  if (r.tick < day * TICKS_PER_DAY || r.tick > upTo) continue;
  for (const e of r.events) if (e.type === 'trip') trips.set(e.resident, (trips.get(e.resident) ?? 0) + 1);
}
const [resident, count] = [...trips].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [];
if (resident === undefined) await fail(`nobody made a trip on day ${day + 1} up to tick ${upTo}`);
console.log(`following resident ${resident}: ${count} trips on day ${day + 1} up to tick ${upTo}`);

const rowsOnCard = () =>
  page.$$eval('#follow [data-log] li', (items) =>
    items.map((li) => ({
      kind: li.dataset.kind,
      tick: Number(li.dataset.tick),
      carried: li.hasAttribute('data-carried'),
      when: li.querySelector('time').textContent,
    })),
  );
const clock = (tick) => {
  const minutes = Math.floor((tick % TICKS_PER_DAY) / 4);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

/** Waits for the card's entries up to `upTo` to be the log's, and for each to carry its time. */
async function matchesLog(which, what) {
  const want = JSON.stringify(expected(resident, which));
  let got = '';
  for (let waited = 0; waited < MINUTE; waited += 500) {
    const rows = await rowsOnCard();
    const mine = rows
      .filter((r) => !r.carried && r.tick <= upTo)
      .map((r) => [r.kind, r.tick])
      .sort(byTick);
    got = JSON.stringify(mine);
    if (got === want) {
      for (const r of rows.filter((x) => !x.carried)) {
        if (!r.when.includes(clock(r.tick)))
          await fail(`${what}: the entry at tick ${r.tick} says "${r.when}", not ${clock(r.tick)}`);
      }
      return rows;
    }
    await sleep(500);
  }
  await fail(`${what}: the card lists\n${got}\nbut the log has\n${want}`);
}

await page.evaluate((r) => window.__following.start(r), resident);
await page
  .waitForFunction(() => document.querySelectorAll('#follow [data-log] li').length > 0, null, {
    polling: 250,
    timeout: 2 * MINUTE,
  })
  .catch(async () => fail(`the card never listed a day: ${await page.locator('#follow').innerText()}`));
const label = await page.locator('#follow [data-label]').textContent();
if (!label.startsWith(`Day ${day + 1}`)) await fail(`the card shows "${label}", not day ${day + 1}`);
const rows = await matchesLog(day, `day ${day + 1}`);
console.log(`day ${day + 1}: ${rows.length} entries match the log`);
await page.screenshot({ path: join(out, 'day.png') });

// The arrows: nothing before the first day, and the day before once there is one.
const prev = page.locator('#follow [data-prev]');
if (day === 0) {
  if (await prev.isEnabled()) await fail('the first day has a day before it');
} else {
  await prev.click();
  await page.waitForFunction(
    (n) => document.querySelector('#follow [data-label]').textContent.startsWith(`Day ${n}`),
    day,
    { timeout: 2 * MINUTE },
  );
  await matchesLog(day - 1, `day ${day}`);
  console.log(`day ${day}: matches the log`);
  await page.locator('#follow [data-next]').click();
  await page.waitForFunction(
    (n) => document.querySelector('#follow [data-label]').textContent.startsWith(`Day ${n}`),
    day + 1,
    { timeout: MINUTE },
  );
  await matchesLog(day, `day ${day + 1} again`);
}

// A click seeks the timeline there, and the card marks the entry as the one they are in.
const target = rows.find((r) => r.kind === 'trip' && !r.carried && r.tick <= upTo - 60);
if (!target) await fail('no trip far enough behind the newest tick to seek to');
await page.locator(`#follow [data-log] li[data-tick="${target.tick}"][data-kind="trip"] button`).click();
await page
  .waitForFunction((t) => window.__metro.shown().past === t, target.tick, { polling: 250, timeout: 2 * MINUTE })
  .catch(async () =>
    fail(
      `clicking the trip at tick ${target.tick} left the city at ${JSON.stringify(await page.evaluate(() => window.__metro.shown().past))}`,
    ),
  );
await page.waitForTimeout(500);
const marked = await page.locator('#follow [data-log] li[aria-current]').getAttribute('data-tick');
if (Number(marked) !== target.tick)
  await fail(`after seeking to tick ${target.tick} the card marks the entry at ${marked}`);
console.log(`a click on the trip at tick ${target.tick} seeked there`);
await page.screenshot({ path: join(out, 'day-seeked.png') });

if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
