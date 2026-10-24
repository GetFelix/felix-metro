// Opens the page at /#pinecrest against the running dev stack and checks the city picker: it lists the cities the sim
// has registered, a city started after the page loaded shows up in it without a reload, and choosing it opens that
// city. Usage: node scripts/check-cities.mjs <page url without a hash> <out dir>, with START_CITY set to the command
// that starts the held-back city (dev/city.sh lakeside).
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
const { START_CITY } = process.env;
if (!out || !START_CITY) throw new Error('usage: START_CITY=... check-cities.mjs <page url> <out dir>');
const appUrl = withTrace(pageUrl);
mkdirSync(out, { recursive: true });
const MINUTE = 60_000;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const fail = async (message) => {
  console.error(message);
  await page.screenshot({ path: join(out, 'cities-failure.png') }).catch(() => {});
  await browser.close();
  process.exit(1);
};
const listed = () => page.locator('#cities li').allTextContents();
const drawing = (name) =>
  page
    .waitForFunction(
      (n) => document.getElementById('subtitle').textContent === n && Number.isFinite(window.__live?.tick),
      name,
      { polling: 250, timeout: 5 * MINUTE },
    )
    .catch(() => fail(`${name} was never drawn`));

// 1. Opening /#pinecrest shows that city, and the picker lists the cities there are.
await page.goto(`${appUrl}#pinecrest`, { waitUntil: 'load', timeout: 5 * MINUTE });
await drawing('Pinecrest');
await page
  .waitForFunction(() => document.querySelectorAll('#cities li').length >= 2, null, { polling: 250, timeout: MINUTE })
  .catch(() => fail('the picker never listed the cities'));
let names = await listed();
if (!names.includes('Harbor') || !names.includes('Pinecrest')) await fail(`the picker lists ${names}`);
if (names.includes('Lakeside')) await fail('Lakeside is listed before it was started');
const current = await page.locator('#cities a[aria-current="page"]').allTextContents();
if (current.join() !== 'Pinecrest') await fail(`the picker marks ${current} as the open city`);
await page.click('#brand-button');
await page.screenshot({ path: join(out, 'picker.png') });
console.log(`opened at /#pinecrest; the picker lists ${names}`);

// 2. A city that comes into being after the page loaded appears in the list without a reload.
await page.evaluate(() => (window.__sameDocument = true));
execSync(START_CITY, { stdio: 'inherit' });
await page
  .waitForFunction(
    () => [...document.querySelectorAll('#cities li')].some((li) => li.textContent === 'Lakeside'),
    null,
    {
      polling: 250,
      timeout: MINUTE,
    },
  )
  .catch(() => fail('Lakeside never appeared in the picker'));
if (!(await page.evaluate(() => window.__sameDocument === true))) await fail('the page reloaded to show the new city');
await page.screenshot({ path: join(out, 'picker-new-city.png') });
console.log(`a city started after the load appeared without a reload: ${await listed()}`);

// 3. Choosing it opens it, as a fresh page that follows that city.
await page.click('#cities a[href$="#lakeside"]');
await page
  .waitForFunction(
    () =>
      window.__sameDocument === undefined &&
      document.getElementById('subtitle').textContent === 'Lakeside' &&
      Number.isFinite(window.__live?.tick),
    null,
    { polling: 250, timeout: 5 * MINUTE },
  )
  .catch(() => fail('choosing Lakeside did not open it'));
const t0 = await page.evaluate(() => window.__live.tick);
await page
  .waitForFunction((t) => window.__live.tick > t + 8, t0, { polling: 250, timeout: MINUTE })
  .catch(() => fail(`Lakeside stayed at tick ${t0}`));
names = await listed();
if (names.length < 3) await fail(`the picker on Lakeside lists ${names}`);
await page.screenshot({ path: join(out, 'lakeside.png') });
console.log(`Lakeside is open and its clock runs (tick ${t0} -> ${await page.evaluate(() => window.__live.tick)})`);
if (errors.length) await fail(errors.join('\n'));
await browser.close();
