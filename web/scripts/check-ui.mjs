// Checks the overlay's controls with the keyboard and takes screenshots of them, day and night, at a desktop and a
// phone width: the settings sheet and its quality options, the key list, the first-visit tip and the rolling clock.
// Usage: node scripts/check-ui.mjs <app url> <out dir>. The page must already be served; no gateway is needed.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-ui.mjs <app url> <out dir>');
mkdirSync(out, { recursive: true });
const base = withTrace(pageUrl);
// live=0 draws the city alone, so a gateway that happens to be running cannot change what is checked.
const url = (query) => `${base}&live=0&${query}`;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

// A fresh context each time, so local storage starts empty.
async function open(query, size, options = {}) {
  const context = await browser.newContext({ viewport: size, ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e}`));
  await page.goto(url(query), { waitUntil: 'load', timeout: 300_000 });
  await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return { context, page };
}

const active = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
const inSheet = (page) => page.evaluate(() => !!document.activeElement?.closest('#sheet'));
const visible = (page, selector) => page.locator(selector).isVisible();
const settle = (page, ms = 350) => page.waitForTimeout(ms);

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 360, height: 740 };

// 1. The keyboard: reach the button, open the sheet, choose a quality, read the key list, close, and land back.
{
  const { context, page } = await open('tier=high&still&t=12', DESKTOP);
  check(await visible(page, '#settings-button'), 'the settings button is on screen');
  for (let i = 0; i < 6 && (await active(page)) !== 'settings-button'; i++) await page.keyboard.press('Tab');
  check((await active(page)) === 'settings-button', 'Tab reaches the settings button');
  check(
    await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'),
    'the settings button shows a focus ring',
  );
  await page.keyboard.press('Enter');
  check(await visible(page, '#sheet'), 'Enter opens the sheet');
  check((await page.getAttribute('#settings-button', 'aria-expanded')) === 'true', 'the button says the sheet is open');
  check(await inSheet(page), 'focus moves into the sheet');
  check(
    (await page.evaluate(() => document.activeElement.value)) === 'high',
    'the option in use (High, from the address) has focus',
  );
  await page.keyboard.press('ArrowDown');
  check(
    (await page.evaluate(() => localStorage.getItem('felix-metro.tier'))) === 'medium',
    'an arrow key picks Medium and keeps it',
  );
  for (const key of ['ArrowUp', 'ArrowUp']) await page.keyboard.press(key);
  check(
    (await page.evaluate(() => document.querySelector('input[name=quality]:checked').value)) === 'auto',
    'the arrows reach Automatic',
  );
  check(
    (await page.evaluate(() => localStorage.getItem('felix-metro.tier'))) === null,
    'Automatic forgets the saved tier',
  );
  check(
    /Right now it is on High\./.test(await page.locator('[data-running]').innerText()),
    'Automatic says which tier it is on',
  );
  let trapped = true;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    trapped &&= await inSheet(page);
  }
  check(trapped, 'Tab stays inside the open sheet');
  await page.keyboard.press('?');
  check(await visible(page, '[data-view=keys]'), '? opens the key list from the sheet');
  check(!(await visible(page, '[data-view=settings]')), 'the key list replaces the settings');
  const rows = await page.locator('[data-keys] tr').count();
  check(rows >= 10, `the key list has its rows (${rows})`);
  await page.keyboard.press('Escape');
  check(!(await visible(page, '#sheet')), 'Esc closes the sheet');
  check((await active(page)) === 'settings-button', 'focus goes back to the button');
  check((await page.getAttribute('#settings-button', 'aria-expanded')) === 'false', 'the button says it is closed');
  // The hour slider is invisible, so its ring is drawn round its knob.
  for (let i = 0; i < 6 && (await active(page)) !== 'hour'; i++) await page.keyboard.press('Tab');
  check((await active(page)) === 'hour', 'Tab reaches the hour slider');
  check(
    await page.evaluate(() => getComputedStyle(document.querySelector('.track .knob')).outlineStyle !== 'none'),
    'the hour slider shows a focus ring on its knob',
  );
  await context.close();
}

// 2. ? from the page, ignored while typing; Esc gives focus back to where it was.
{
  const { context, page } = await open('tier=low&still&t=12', DESKTOP);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'typing';
    input.type = 'text';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('?');
  check(!(await visible(page, '#sheet')), '? is left alone while typing in a text field');
  await page.evaluate(() => document.getElementById('typing').blur());
  await page.keyboard.press('?');
  check(await visible(page, '[data-view=keys]'), '? opens the key list from the page');
  await page.keyboard.press('Escape');
  check(!(await visible(page, '#sheet')), 'Esc closes the key list');
  await page.evaluate(() => document.getElementById('settings-button').click());
  await page.mouse.click(300, 300);
  check(!(await visible(page, '#sheet')), 'a click outside closes the sheet');
  await context.close();
}

// 3. The first-visit tip: shown once, gone on the first touch, remembered, and never with ?ui=0 or ?capture.
{
  const { context, page } = await open('tier=low&still&t=12', DESKTOP);
  // With no gateway the timeline never appears, so nothing may offer the tip by itself. When it is due is a unit test.
  check((await page.locator('.toast.hint').count()) === 0, 'the tip does not show before the timeline does');
  check(await page.evaluate(() => window.__ui.offerHint()), 'the tip is offered on a first visit');
  check((await page.locator('.toast.hint').innerText()).includes('timeline'), 'the tip speaks of the timeline');
  await page.screenshot({ path: join(out, 'hint-day-1280.png') });
  await page.keyboard.press('Shift');
  await settle(page, 100);
  check((await page.locator('.toast.hint').count()) === 0, 'the first key press takes the tip away');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
  check(!(await page.evaluate(() => window.__ui.offerHint())), 'the tip is not shown again on the next visit');
  await context.close();
}
for (const [query, what] of [
  ['tier=low&still&ui=0', '?ui=0'],
  ['tier=low&still&capture', '?capture'],
]) {
  const { context, page } = await open(query, DESKTOP);
  check(await page.evaluate(() => window.__ui === undefined), `no controls and no tip under ${what}`);
  check((await page.locator('#settings-button').count()) === 0, `no settings button under ${what}`);
  if (query.includes('ui=0'))
    for (const [selector, name] of [
      ['.brand', 'the Felix Metro chip'],
      ['.clock', 'the clock'],
      ['#timeline', 'the timeline'],
    ])
      check(!(await visible(page, selector)), `${name} is hidden under ${what}`);
  await context.close();
}

// 4. The clock rolls, and holds still when motion is off.
for (const reduce of [false, true]) {
  const { context, page } = await open('tier=low&still', DESKTOP, {
    reducedMotion: reduce ? 'reduce' : 'no-preference',
  });
  const set = (h) =>
    page.evaluate((hour) => {
      const slider = document.getElementById('hour');
      slider.value = String(hour);
      slider.dispatchEvent(new Event('input'));
    }, h);
  await set(12.2);
  await settle(page, 400);
  await set(13.0);
  const rolling = await page.locator('#clock .digit.roll').count();
  check((await page.locator('#clock').textContent()) === '13:00', 'the clock text stays plain HH:MM');
  check(reduce ? rolling === 0 : rolling > 0, reduce ? 'no digit rolls with reduced motion' : 'a changed digit rolls');
  const ended = await page
    .waitForFunction(() => !document.querySelector('#clock .digit.roll'), null, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  check(ended, 'the roll ends');
  await context.close();
}

// 5. Screenshots: day and night, desktop and phone; the sheet, the key list and the tip on top.
for (const [size, tag] of [
  [DESKTOP, '1280'],
  [PHONE, '360'],
]) {
  for (const [hour, time] of [
    [12, 'day'],
    [21, 'night'],
  ]) {
    const { context, page } = await open(`tier=low&still&t=${hour}`, size);
    // What a live city adds to the clock chip, which a page with no gateway never shows.
    await page.evaluate(() => {
      document.getElementById('pill').classList.remove('hidden');
    });
    await settle(page);
    await page.screenshot({ path: join(out, `shell-${time}-${tag}.png`) });
    // The widest the two chips get: the picker's chevron once cities arrive, and the reconnecting pill.
    await page.evaluate(() => {
      document.getElementById('chevron').classList.remove('hidden');
      const pill = document.getElementById('pill');
      pill.textContent = 'Reconnecting…';
      pill.classList.add('late');
    });
    await settle(page, 100);
    const [brand, clock] = await page.evaluate(() =>
      ['.brand', '.clock'].map((s) => {
        const { left, right, top, bottom } = document.querySelector(s).getBoundingClientRect();
        return { left, right, top, bottom };
      }),
    );
    const apart = clock.left - brand.right;
    const stacked = clock.top >= brand.bottom;
    check(
      apart >= 8 || stacked,
      `the brand chip and the clock do not touch at ${tag}px with the chevron and Reconnecting (${time}, ${Math.round(apart)}px apart)`,
    );
    check(
      clock.left >= 0 && clock.right <= size.width,
      `the clock stays on screen with Reconnecting at ${tag}px (${time})`,
    );
    await page.screenshot({ path: join(out, `reconnecting-${time}-${tag}.png`) });
    await page.evaluate(() => {
      document.getElementById('chevron').classList.add('hidden');
      const pill = document.getElementById('pill');
      pill.textContent = 'LIVE';
      pill.classList.remove('late');
    });
    await page.evaluate(() => {
      document.getElementById('pill').classList.add('hidden');
      document.getElementById('past').classList.remove('hidden');
      document.getElementById('past-ago').textContent = '3 h 12 m ago';
    });
    await page.screenshot({ path: join(out, `past-${time}-${tag}.png`) });
    await page.evaluate(() => document.getElementById('past').classList.add('hidden'));
    await page.evaluate(() => window.__ui.offerHint());
    await page.screenshot({ path: join(out, `tip-${time}-${tag}.png`) });
    await page.evaluate(() => window.__ui.openSettings());
    await settle(page, 100);
    await page.screenshot({ path: join(out, `settings-${time}-${tag}.png`) });
    await page.evaluate(() => window.__ui.openKeys());
    await settle(page, 100);
    await page.screenshot({ path: join(out, `keys-${time}-${tag}.png`) });
    // Nothing may run past the screen's edge at phone width.
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!wide, `nothing overflows the page at ${tag}px (${time})`);
    await context.close();
  }
}

// 8. Photo mode hides every control, including the tip, and H or Esc brings them back.
{
  const { context, page } = await open('tier=low&still&t=12&hud', DESKTOP);
  const shown = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('.chip, .corner, .toasts, .hud, #settings-button')].filter((el) =>
          el.checkVisibility(),
        ).length,
    );
  check((await shown()) > 0, 'the controls are on screen before photo mode');
  await page.evaluate(() => window.__ui.offerHint());
  await page.keyboard.press('h');
  check((await shown()) === 0, 'H hides every control, the tip and the frame times');
  await page.screenshot({ path: join(out, 'photo-day-1280.png') });
  await page.keyboard.press('h');
  check((await shown()) > 0, 'H brings them back');
  await page.keyboard.press('h');
  await page.keyboard.press('Escape');
  check((await shown()) > 0, 'Esc brings them back');
  await page.keyboard.press('?');
  await page.keyboard.press('h');
  check(await visible(page, '#sheet'), 'H does nothing under an open sheet');
  await context.close();
}

// 9. A shared view is where the camera starts, with no opening drift.
{
  const { context, page } = await open('tier=low&t=12&cam=3,-2,15,1.2,0.9', DESKTOP);
  await settle(page, 300);
  const state = await page.evaluate(() => window.__camera.state());
  check(
    state.x === 3 && state.z === -2 && state.distance === 15 && state.azimuth === 1.2 && state.polar === 0.9,
    `?cam puts the camera there (${JSON.stringify(state)})`,
  );
  await context.close();
}

// 10. Attract mode: untouched, the camera turns; a mouse move stops it.
{
  const { context, page } = await open('tier=low&t=12&attract=2', DESKTOP);
  const azimuth = () => page.evaluate(() => window.__camera.state().azimuth);
  // The opening drift ends on its own; wait it out, then see whether the camera holds.
  await settle(page, 2500);
  const first = await azimuth();
  await settle(page, 1500);
  const second = await azimuth();
  check(second !== first, `the camera turns after the quiet (${first} to ${second})`);
  await page.mouse.move(400, 300);
  await settle(page, 400);
  const held = await azimuth();
  await page.mouse.move(420, 310);
  await settle(page, 1000);
  check((await azimuth()) === held, 'a mouse move stops the turn');
  await context.close();
}
{
  const { context, page } = await open('tier=low&t=12&attract=0', DESKTOP);
  await settle(page, 3000);
  const first = await page.evaluate(() => window.__camera.state().azimuth);
  await settle(page, 1500);
  check((await page.evaluate(() => window.__camera.state().azimuth)) === first, '?attract=0 keeps the camera still');
  await context.close();
}

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
