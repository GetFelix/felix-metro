// Hovers buildings in the live page against the dev stack and checks the card that says who built them. A building a
// builder put up reads "Built by <name> · Day N, HH:MM · See it go up", with the day and time of its `built` event; a
// generated one reads "Here since the start". The link then takes the page back to just before the building went up and
// plays it forward, so the lot is bare at first and has its building after. The card is left out under ?ui=0 and in photo
// mode, and a drag still moves the camera. The city must have buildings someone built (the builder bot and the restart
// check leave them in pinecrest). Usage: node scripts/check-attribution.mjs <page url> <out dir> where the page url has
// no hash.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { APPLIED, IDP, build, demolish, joined, sleep } from '../../dev/lib/gateway.mjs';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-attribution.mjs <page url> <out dir>');
const appUrl = withTrace(pageUrl);
const city = process.env.CHECK_CITY ?? 'pinecrest';
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;
const TICKS_PER_DAY = 5760;

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

/** The line the card should read for a building built at `tick`, as a person reads the city clock. */
function expectedWhen(tick) {
  const minutes = Math.floor(((tick % TICKS_PER_DAY) * 1440) / TICKS_PER_DAY);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `Day ${Math.floor(tick / TICKS_PER_DAY) + 1}, ${hh}:${mm}`;
}

await page.goto(`${appUrl}#${city}`, { waitUntil: 'load', timeout: 5 * MINUTE });
await page
  .waitForFunction(() => Number.isFinite(window.__live?.tick) && window.__lots, null, {
    polling: 250,
    timeout: 5 * MINUTE,
  })
  .catch(() => fail('the live city never drew a tick'));
// The camera comes down from its opening drift; it must be still before a lot is aimed at.
await page.waitForTimeout(3000);

const built = await page.evaluate(() => window.__lots.built());
if (built.length === 0) await fail('the page knows no building anyone built; nothing to hover');
console.log(
  `${built.length} buildings someone built, first lot ${built[0].lot} by ${built[0].name} at tick ${built[0].tick}`,
);

/** Move the pointer onto `lot` and return the text of the card that shows, or null when none does. */
async function hover(lot, wait = 4000) {
  // A card left by the last hover would sit between the pointer and the city.
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => window.__lots.card() === null, null, { polling: 50, timeout: 3000 }).catch(() => {});
  const at = await page.evaluate((l) => window.__lots.aim(l), lot);
  const under = await page.evaluate(([x, y]) => window.__lots.pick(x, y), [at.x, at.y]);
  if (under !== lot) return { at, under, text: null };
  await page.mouse.move(at.x - 30, at.y - 30);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  const shown = await page
    .waitForFunction(() => window.__lots.card(), null, { polling: 50, timeout: wait })
    .then(() => true)
    .catch(() => false);
  return { at, under, text: shown ? await page.evaluate(() => window.__lots.card()) : null };
}

// 1. A building someone built names its builder and says when. Try a few, since a neighbour can stand in front of one.
let target = null;
for (const b of built.slice(0, 6)) {
  const got = await hover(b.lot);
  if (got.text === null) continue;
  const want = `Built by ${b.name} · ${expectedWhen(b.tick)} · See it go up`;
  if (got.text !== want) await fail(`lot ${b.lot}: the card reads "${got.text}", expected "${want}"`);
  console.log(`lot ${b.lot}: "${got.text}"`);
  target = { ...b, at: got.at };
  break;
}
if (!target) await fail('no building someone built could be hovered');
await page.screenshot({ path: join(out, 'built.png') });

// 2. A generated building says it has been here since the start.
const seeded = await page.evaluate(() => window.__lots.seeded());
let seededText = null;
for (const lot of seeded.slice(0, 40)) {
  const got = await hover(lot, 1500);
  if (got.text === null) continue;
  seededText = got.text;
  console.log(`lot ${lot} (generated): "${got.text}"`);
  break;
}
if (seededText !== 'Here since the start')
  await fail(`a generated building's card reads ${JSON.stringify(seededText)}`);

// 3. The card goes when the pointer leaves, and stays out of photo mode.
await page.mouse.move(2, 2);
await page
  .waitForFunction(() => window.__lots.card() === null, null, { polling: 50, timeout: 3000 })
  .catch(() => fail('the card stayed after the pointer left'));
await page.evaluate(() => document.body.classList.add('photo'));
const photo = await hover(target.lot, 1500);
if (photo.text !== null) await fail(`the card shows in photo mode: "${photo.text}"`);
await page.evaluate(() => document.body.classList.remove('photo'));
console.log('no card in photo mode');

// 4. A drag still turns the camera, and no card gets in its way.
const before = await page.evaluate(() => JSON.stringify(window.__camera.view()));
const centre = { x: 640, y: 360 };
await page.mouse.move(centre.x, centre.y);
await page.mouse.down();
await page.mouse.move(centre.x + 160, centre.y + 40, { steps: 8 });
if ((await page.evaluate(() => window.__lots.card())) !== null) await fail('a card showed during a drag');
await page.mouse.up();
await page.waitForTimeout(500);
if ((await page.evaluate(() => JSON.stringify(window.__camera.view()))) === before)
  await fail('a drag did not move the camera');
console.log('a drag turns the camera');

// 5. "See it go up" goes to just before the building was built, then plays on until the building is there. It samples in
// the page, because the rise is only a few seconds.
const first = await hover(target.lot);
if (first.text === null) await fail('the building could not be hovered again');
await page.evaluate(
  ([lot, tick]) => {
    window.__rise = { samples: [], stop: false };
    const sample = () => {
      const shown = window.__metro.shown();
      if (shown.past !== null) window.__rise.samples.push({ past: shown.past, standing: window.__lots.standing(lot) });
      if (!window.__rise.stop) setTimeout(sample, 40);
    };
    sample();
    window.__rise.tick = tick;
  },
  [target.lot, target.tick],
);
await page.locator('.attribution-link').click();
await page
  .waitForFunction(() => window.__rise.samples.some((s) => s.past > window.__rise.tick + 4), null, {
    polling: 100,
    timeout: 90_000,
  })
  .catch(() => fail('the page did not play on past the building going up'));
const samples = await page.evaluate(() => {
  window.__rise.stop = true;
  return window.__rise.samples;
});
// The preview of the nearest keyframe may come first; the seek itself lands two ticks before the building.
const start = samples.find((s) => s.past >= target.tick - 3);
if (!start || start.past > target.tick - 1) {
  await fail(`the page went to tick ${start?.past}, not two ticks before ${target.tick}`);
}
if (start.standing) await fail(`the lot already had its building at tick ${start.past}`);
if (!samples.at(-1).standing)
  await fail(`the lot has no building at tick ${samples.at(-1).past}, after it was built at ${target.tick}`);
console.log(`See it go up: from tick ${start.past} (bare) to tick ${samples.at(-1).past} (built at ${target.tick})`);
await page.screenshot({ path: join(out, 'go-up.png') });
if (errors.length > 0) await fail(`errors on the page: ${errors.join('; ')}`);

// 6. Signed in as the builder, the same building reads "Built by you". The page takes the token it finds in the tab.
const mayorToken = (await (await fetch(`${IDP}/token?sub=mayor&aud=felix-metro`)).json()).id_token;
const mine = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await mine.addInitScript((token) => sessionStorage.setItem('metro.token', token), mayorToken);
const own = await mine.newPage();
await own.goto(`${appUrl}#${city}`, { waitUntil: 'load', timeout: 5 * MINUTE });
await own.waitForFunction(() => Number.isFinite(window.__live?.tick) && window.__lots, null, {
  polling: 250,
  timeout: 5 * MINUTE,
});
await own.waitForTimeout(3000);
await own
  .evaluate((l) => window.__lots.aim(l), target.lot)
  .then(async (at) => {
    await own.mouse.move(at.x - 30, at.y - 30);
    await own.mouse.move(at.x, at.y, { steps: 3 });
  });
const youText = await own
  .waitForFunction(() => window.__lots.card(), null, { polling: 50, timeout: 4000 })
  .then(() => own.evaluate(() => window.__lots.card()))
  .catch(() => null);
const wantYou = `Built by you · ${expectedWhen(target.tick)} · See it go up`;
if (youText !== wantYou)
  await fail(`signed in as the builder the card reads ${JSON.stringify(youText)}, expected "${wantYou}"`);
console.log(`signed in as the builder: "${youText}"`);
await mine.close();

// 7. On a phone a tap opens the card and a tap elsewhere closes it, and a builder with the longest name there can be
// gets a card that still fits the screen with its link whole.
const LONG = 'Bartholomew-Maximilian-Featherstonehaugh-of-the-Upper-Marsh-District-x'.slice(0, 64);
const writer = await joined(city, 'mayor', { name: LONG });
writer.follow();
while (writer.newest < 0) await sleep(200);
await writer.ready();
let longLot = null;
for (let first = 0; first < 400 && longLot === null; first += 8) {
  const lots = Array.from({ length: 8 }, (_, i) => first + i);
  const seen = await writer.send(lots.map((lot) => [9000 + lot, build(lot)]));
  longLot = lots.find((lot) => seen.get(9000 + lot).result === APPLIED) ?? null;
}
if (longLot === null) await fail('no lot took a build for the long name');
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const touch = await phone.newPage();
await touch.goto(`${appUrl}#${city}`, { waitUntil: 'load', timeout: 5 * MINUTE });
await touch.waitForFunction(() => Number.isFinite(window.__live?.tick) && window.__lots, null, {
  polling: 250,
  timeout: 5 * MINUTE,
});
for (const lot of [target.lot, longLot]) {
  await touch.waitForFunction((l) => window.__lots.built().some((b) => b.lot === l), lot, {
    polling: 100,
    timeout: 60_000,
  });
}
await touch.waitForTimeout(3000);
await touch.evaluate(() => {
  window.__touches = [];
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
    document.addEventListener(
      type,
      (e) => {
        const t = e.target;
        const where = `${t.tagName}#${t.id}.${t.className} at ${Math.round(e.clientX)},${Math.round(e.clientY)}`;
        window.__touches.push(
          `${type} on ${where} made ${Math.round(e.timeStamp)} handled ${Math.round(performance.now())}, ` +
            `body "${document.body.className}", lot under it ${window.__lots.pick(e.clientX, e.clientY)}`,
        );
      },
      true,
    );
  }
});
// On a tall phone the council opens over the middle of the screen, where the tap would land on it.
const foldCouncil = () =>
  touch.evaluate(() => {
    const details = document.querySelector('#council-chip details');
    if (details) {
      details.dataset.touched = '1';
      details.open = false;
    }
  });
async function tap(lot) {
  await foldCouncil();
  const at = await touch.evaluate((l) => window.__lots.aim(l), lot);
  if ((await touch.evaluate(([x, y]) => window.__lots.pick(x, y), [at.x, at.y])) !== lot)
    await fail(`lot ${lot} is not under the tap`);
  // A tap that did land shows its card before the next attempt, so a second tap never closes the first one's card.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await touch.touchscreen.tap(at.x, at.y);
    const shown = await touch
      .waitForFunction(() => window.__lots.card(), null, { polling: 50, timeout: 10_000 })
      .then(() => touch.evaluate(() => window.__lots.card()))
      .catch(() => null);
    if (shown !== null) return shown;
    await foldCouncil();
    console.log(
      `tap ${attempt} on lot ${lot} showed no card: ${(await touch.evaluate(() => window.__touches.splice(0))).join('; ')}`,
    );
  }
  return null;
}
const tapped = await tap(target.lot);
if (!tapped?.startsWith('Built by ')) await fail(`a tap on a building shows ${JSON.stringify(tapped)}`);
await touch.touchscreen.tap(5, 300);
await touch
  .waitForFunction(() => window.__lots.card() === null, null, { polling: 50, timeout: 3000 })
  .catch(() => fail('a tap elsewhere did not close the card'));
console.log(`a tap shows "${tapped}", and a tap elsewhere closes it`);
const wide = await tap(longLot);
if (!wide?.startsWith(`Built by ${LONG} \u00b7 Day `) || !wide.endsWith(' \u00b7 See it go up')) {
  await fail(`the long name's card reads ${JSON.stringify(wide)}`);
}
const fit = await touch.evaluate(() => {
  const box = (selector) => document.querySelector(selector).getBoundingClientRect();
  const card = box('.attribution');
  const link = box('.attribution-link');
  const name = document.querySelector('.attribution-name');
  return {
    card: [card.left, card.right],
    link: [link.left, link.right],
    cut: name.scrollWidth > name.clientWidth,
    width: innerWidth,
    after: document.querySelector('.attribution-after').getBoundingClientRect().width > 0,
  };
});
if (fit.card[0] < 0 || fit.card[1] > fit.width)
  await fail(`the long name's card is off the screen: ${JSON.stringify(fit)}`);
if (fit.link[0] < fit.card[0] || fit.link[1] > fit.card[1])
  await fail(`the link is outside the card: ${JSON.stringify(fit)}`);
if (!fit.cut) await fail(`the long name was not cut short: ${JSON.stringify(fit)}`);
await touch.screenshot({ path: join(out, 'long-name.png') });
console.log('a 64 character name is cut short and the card stays on a 390 px screen');
await phone.close();
const gone = await writer.send([[9500 + longLot, demolish(longLot)]], 1_000_000);
if (gone.get(9500 + longLot).result !== APPLIED) await fail(`demolishing lot ${longLot} was refused`);
writer.close();

// 8. With ?ui=0 there is no card.
const bare = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const url = new URL(appUrl);
url.searchParams.set('ui', '0');
await bare.goto(`${url}#${city}`, { waitUntil: 'load', timeout: 5 * MINUTE });
await bare.waitForFunction(() => Number.isFinite(window.__live?.tick), null, { polling: 250, timeout: 5 * MINUTE });
if (await bare.evaluate(() => window.__lots !== undefined || document.getElementById('attribution') !== null)) {
  await fail('the card exists under ?ui=0');
}
console.log('no card under ?ui=0');
await browser.close();
console.log('the card says who built what');
