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
const today = Math.floor((await page.evaluate(() => window.__live.tick)) / TICKS_PER_DAY);

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

// The day to check is the newest one anyone made trips in: just after midnight nobody has yet.
const tripsByDay = new Map();
for (const r of reader.records) {
  if (r.tick > upTo) continue;
  const d = Math.floor(r.tick / TICKS_PER_DAY);
  for (const e of r.events) {
    if (e.type !== 'trip') continue;
    const trips = tripsByDay.get(d) ?? new Map();
    trips.set(e.resident, (trips.get(e.resident) ?? 0) + 1);
    tripsByDay.set(d, trips);
  }
}
const day = Math.max(-1, ...tripsByDay.keys());
if (day < 0) await fail(`nobody made a trip up to tick ${upTo}`);
const [resident, count] = [...tripsByDay.get(day)].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
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

const label = () => page.locator('#follow [data-label]').textContent();
const labelIs = (n) =>
  page.waitForFunction((n) => document.querySelector('#follow [data-label]')?.textContent.startsWith(`Day ${n}`), n, {
    polling: 250,
    timeout: 2 * MINUTE,
  });
// The sim runs at 16x, so the live city can cross midnight while this check runs, and a card on today then moves to the
// next day by itself. An arrow is pressed from the day the card shows, not from the one this check expects, and a card
// that has been paged back stays on its day.
const walkTo = async (n) => {
  for (let step = 0; step < 8; step++) {
    const here = Number((await label()).match(/^Day (\d+)/)?.[1]);
    if (here === n) return;
    const arrow = here > n ? 'prev' : 'next';
    await page.locator(`#follow [data-${arrow}]`).click();
    await labelIs(here > n ? here - 1 : here + 1).catch(async () =>
      fail(
        `the ${arrow} arrow on "${await label()}" did not move the card, live at tick ${await page.evaluate(() => window.__live.tick)}`,
      ),
    );
  }
  await fail(`the card never reached day ${n}, it shows "${await label()}"`);
};
await page.evaluate((r) => window.__following.start(r), resident);
// The card opens on the day the city is in; the arrows walk it back to the day being checked.
await labelIs(today + 1).catch(async () =>
  fail(`the card never showed day ${today + 1}: ${await page.locator('#follow').innerText()}`),
);
await walkTo(day + 1);
const rows = await matchesLog(day, `day ${day + 1}`);
console.log(`day ${day + 1}: ${rows.length} entries match the log`);
await page.screenshot({ path: join(out, 'day.png') });

// The arrows: nothing before the first day, and the day before once there is one.
const prev = page.locator('#follow [data-prev]');
let earlier = [];
if (day === 0) {
  if ((await prev.getAttribute('aria-disabled')) === 'false') await fail('the first day has a day before it');
} else {
  await walkTo(day);
  earlier = await matchesLog(day - 1, `day ${day}`);
  console.log(`day ${day}: matches the log`);
  await walkTo(day + 1);
  await matchesLog(day, `day ${day + 1} again`);
}

// A click seeks the timeline there, and the card marks the entry as the one they are in.
// Just after midnight the day's only trips can be too fresh to seek to, so the day before supplies one then.
const seekable = (r) => r.kind === 'trip' && !r.carried && r.tick <= upTo - 60;
const target = rows.find(seekable) ?? earlier.find(seekable);
if (!target) await fail('no trip far enough behind the newest tick to seek to');
if (!rows.includes(target)) await walkTo(day);
await page.locator(`#follow [data-log] li[data-tick="${target.tick}"][data-kind="trip"] button`).click();
await page
  .waitForFunction((t) => window.__metro.shown().past === t, target.tick, { polling: 250, timeout: 2 * MINUTE })
  .catch(async () =>
    fail(
      `clicking the trip at tick ${target.tick} left the city at ${JSON.stringify(await page.evaluate(() => window.__metro.shown().past))}`,
    ),
  );
// The card is repainted with the next frame, which a slow runner draws well after the seek is shown.
const markedTick = () => page.locator('#follow [data-log] li[aria-current]').getAttribute('data-tick');
await page
  .waitForFunction(
    (t) => document.querySelector('#follow [data-log] li[aria-current]')?.dataset.tick === String(t),
    target.tick,
    { polling: 250, timeout: MINUTE },
  )
  .catch(async () => fail(`after seeking to tick ${target.tick} the card marks the entry at ${await markedTick()}`));
console.log(`a click on the trip at tick ${target.tick} seeked there`);
await page.screenshot({ path: join(out, 'day-seeked.png') });

if (errors.length) await fail(`page errors:\n${errors.join('\n')}`);
await browser.close();
