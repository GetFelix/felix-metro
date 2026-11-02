// Checks the overlay's controls with the keyboard and takes screenshots of them, day and night, at a desktop and a
// phone width: the settings sheet and its quality options, the key list, the first-visit tip and the rolling clock, and
// that the sound button makes no audio until it is used and says so quietly when audio is blocked.
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
// `init` runs in the page before any of its own code.
async function open(query, size, options = {}, init = null) {
  const context = await browser.newContext({ viewport: size, ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e}`));
  page.consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && page.consoleErrors.push(m.text()));
  if (init) await page.addInitScript(init);
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
  check((await page.locator('#sound-button').count()) === 0, `no sound button under ${what}`);
  if (query.includes('ui=0'))
    for (const [selector, name] of [
      ['.brand', 'the Felix Metro chip'],
      ['.clock', 'the clock'],
      ['#timeline', 'the timeline'],
    ])
      check(!(await visible(page, selector)), `${name} is hidden under ${what}`);
  await context.close();
}

// 3b. Sound: nothing is made before the button is used, the button and the M key toggle it, the choice is kept, and a
// browser that blocks audio gets a short word and no console error.
const countAudio = () => {
  const Real = window.AudioContext;
  window.__audio = { made: 0 };
  window.AudioContext = class extends Real {
    constructor(...args) {
      super(...args);
      window.__audio.made++;
    }
  };
};
const blockAudio = () => {
  window.__audio = { made: 0 };
  window.AudioContext = function () {
    window.__audio.made++;
    throw new DOMException('Audio is blocked here', 'NotAllowedError');
  };
  delete window.webkitAudioContext;
};
const pressed = (page) => page.getAttribute('#sound-button', 'aria-pressed');
const made = (page) => page.evaluate(() => window.__audio.made);
{
  const { context, page } = await open('tier=low&still&t=12', DESKTOP, {}, countAudio);
  check(await visible(page, '#sound-button'), 'the sound button is on screen');
  check((await pressed(page)) === 'false', 'sound starts off');
  await page.mouse.click(300, 300);
  await page.keyboard.press('Shift');
  await page.keyboard.press('j');
  await settle(page, 200);
  check((await made(page)) === 0, 'no audio context exists until the sound button is used');
  for (let i = 0; i < 6 && (await active(page)) !== 'sound-button'; i++) await page.keyboard.press('Tab');
  check((await active(page)) === 'sound-button', 'Tab reaches the sound button');
  await page.keyboard.press('Enter');
  check((await pressed(page)) === 'true', 'Enter turns the sound on and the button says so');
  check((await made(page)) === 1, 'the first use makes the audio context');
  await page.screenshot({ path: join(out, 'sound-on-1280.png') });
  await page.keyboard.press('m');
  check((await pressed(page)) === 'false', 'M turns the sound off');
  await page.keyboard.press('m');
  check((await pressed(page)) === 'true', 'M turns the sound on');
  check((await made(page)) === 1, 'turning it on again reuses the audio context');
  await page.evaluate(() => window.__ui.openSettings());
  await page.keyboard.press('m');
  check((await pressed(page)) === 'true', 'M does nothing while the settings sheet is open');
  await page.keyboard.press('Escape');
  check(page.consoleErrors.length === 0, 'using the sound makes no console error');
  // The choice is kept; the sound itself starts at the first click, since the browser allows nothing before one.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
  check((await pressed(page)) === 'true', 'sound left on shows as on after a reload');
  check((await made(page)) === 0, 'sound left on makes no audio context before a click');
  await page.mouse.click(300, 300);
  check((await made(page)) === 1, 'the first click starts the sound left on');
  await page.click('#sound-button');
  check((await pressed(page)) === 'false', 'the button turns it off');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { polling: 100, timeout: 180_000 });
  check((await pressed(page)) === 'false', 'sound turned off stays off after a reload');
  await page.keyboard.press('h');
  check(!(await visible(page, '#sound-button')), 'photo mode hides the sound button');
  await page.keyboard.press('m');
  check((await pressed(page)) === 'true', 'M still switches the sound in photo mode');
  await page.keyboard.press('h');
  check(await visible(page, '#sound-button'), 'the sound button is back after photo mode');
  await context.close();
}
{
  const { context, page } = await open('tier=low&still&t=12', DESKTOP, {}, blockAudio);
  const before = page.consoleErrors.length;
  await page.click('#sound-button');
  await settle(page, 200);
  check((await made(page)) === 1, 'a blocked audio context was tried once');
  check((await pressed(page)) === 'false', 'the button stays off when audio is blocked');
  check(
    (await page.locator('.toast').allInnerTexts()).some((t) => /not available/.test(t)),
    'a blocked browser gets a short word',
  );
  await page.keyboard.press('m');
  check(page.consoleErrors.length === before, 'blocked audio makes no console error');
  await context.close();
}
{
  const { context, page } = await open('tier=low&still&t=12', DESKTOP, {}, () => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
  });
  const before = page.consoleErrors.length;
  await page.click('#sound-button');
  check((await pressed(page)) === 'false', 'the button stays off with no AudioContext at all');
  check(page.consoleErrors.length === before, 'no AudioContext makes no console error');
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
  // The roll is 160 ms, but it ends on a frame, and a software-rendered frame of the city takes seconds on a busy runner.
  const ended = await page
    .waitForFunction(() => !document.querySelector('#clock .digit.roll'), null, { timeout: 120_000 })
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
  await page.keyboard.press('?');
  check(!(await visible(page, '#sheet')), '? opens nothing in photo mode');
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
  // The camera moves on a frame, and a software-rendered frame takes seconds on a busy runner, so wait for the turn.
  const turned = await page
    .waitForFunction((was) => window.__camera.state().azimuth !== was, first, { polling: 100, timeout: 120_000 })
    .then(
      () => true,
      () => false,
    );
  check(turned, `the camera turns after the quiet (from ${first})`);
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

// 11. Following a resident from a link: the card shows who they are and their day, the camera goes to their building,
// Esc and a pan let go, and turning and zooming do not. With no log the resident is placed by their schedule at the
// hour on the slider, so this runs without a gateway; picking a moving car is checked against the live stack.
{
  const { context, page } = await open('tier=low&still&t=12&follow=3&attract=0', DESKTOP);
  await settle(page, 1200);
  const card = '#follow';
  const text = (selector) => page.locator(`${card} ${selector}`).innerText();
  check(await visible(page, card), '?follow= shows the resident’s card');
  check((await text('[data-name]')).trim().length > 2, 'the card names the resident');
  check(
    /^(Office|Shift|Night) worker$|^(Shopkeeper|Student|Retiree)$/.test((await text('[data-kind]')).trim()),
    'the card says what kind of resident they are',
  );
  check(
    (await text('[data-doing]')).trim().length > 3,
    `the card says what they are doing (${await text('[data-doing]')})`,
  );
  const rows = await page.locator(`${card} [data-day] li`).count();
  check(rows >= 2, `the card lists their day (${rows} blocks)`);
  check(
    (await page.locator(`${card} [data-day] li[aria-current]`).count()) === 1,
    'one block is marked as the one they are in',
  );
  check(
    /^\d\d:\d\d$/.test((await page.locator(`${card} [data-day] time`).first().innerText()).replace('until ', '')),
    'each block says when they leave',
  );
  check((await page.evaluate(() => window.__following.resident())) === 3, 'the page knows who is followed');
  const camera = await page.evaluate(() => window.__camera.state());
  check(camera.distance <= 14.01, `the camera came in close (${camera.distance})`);
  check(camera.x !== 0 || camera.z !== 0, `the camera went to their building (${camera.x}, ${camera.z})`);
  await page.screenshot({ path: join(out, 'follow-day-1280.png') });

  // Turning and zooming keep the follow; the camera stays on them.
  const view = () => page.evaluate(() => window.__camera.state());
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(700, 380, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -200);
  await settle(page, 600);
  const turned = await view();
  check(turned.azimuth !== camera.azimuth, 'a left drag still turns the view');
  check(await visible(page, card), 'turning and zooming keep following');
  check(
    Math.hypot(turned.x - camera.x, turned.z - camera.z) < 0.05,
    'the camera is still on them after turning and zooming',
  );

  // A click that is not on a car or walker does nothing.
  await page.mouse.click(300, 600);
  check(await visible(page, card), 'a click on empty ground leaves the follow alone');

  // Photo mode hides the card, and its Esc is its own.
  await page.keyboard.press('h');
  check(!(await visible(page, card)), 'photo mode hides the card');
  await page.keyboard.press('Escape');
  check(await visible(page, card), 'Esc leaves photo mode and keeps following');

  await page.keyboard.press('Escape');
  check(!(await visible(page, card)), 'Esc stops following');
  check((await page.evaluate(() => window.__following.resident())) === null, 'nobody is followed after Esc');
  const left = await view();
  await settle(page, 400);
  const still = await view();
  check(still.x === left.x && still.z === left.z, 'the camera stays where it was when the follow ends');
  await context.close();
}
// 11b. The list of a day on the card, drawn from a view the way the log's day would be: the page here has no log, so the
// card starts on the schedule, and a view replaces it. Rows are buttons that report the one chosen.
{
  const { context, page } = await open('tier=low&still&t=12&follow=3&attract=0', DESKTOP);
  await settle(page, 1200);
  const card = '#follow';
  const row = (kind, tick, text, place, when, carried = false) => ({ kind, tick, carried, text, place, when });
  const view = {
    status: 'ready',
    label: 'Day 2, today',
    canPrev: true,
    canNext: false,
    rows: [
      row('stay', 5760, 'At home', null, 'until 07:30', true),
      row('trip', 6900, 'Drove to work', 'Harbor Mill', '07:30 to 07:52'),
      row('replan', 6950, 'Changed route', null, '07:42'),
      row('stay', 6990, 'At work', null, 'from 07:52'),
    ],
    current: 1,
    note: null,
  };
  check(await visible(page, `${card} [data-day]`), 'with no log the card lists the schedule');
  check(
    (await page.locator(`${card} [data-label]`).textContent()) === 'Their usual day',
    'and says it is their usual day',
  );
  check(!(await visible(page, `${card} [data-prev]`)), 'with no day to page through there are no arrows');
  await page.evaluate((v) => window.__day.show(v), view);
  check(!(await visible(page, `${card} [data-day]`)), 'a day from the log replaces the schedule');
  check((await page.locator(`${card} [data-label]`).textContent()) === 'Day 2, today', 'the card names the day');
  check(await page.locator(`${card} [data-prev]`).isEnabled(), 'the day before can be chosen');
  check(!(await page.locator(`${card} [data-next]`).isEnabled()), 'the day after today cannot');
  const rows = page.locator(`${card} [data-log] li`);
  check((await rows.count()) === 4, 'every entry is listed');
  check(
    (await page.locator(`${card} [data-log] li[aria-current] button`).getAttribute('data-row')) === '1',
    'the entry they are in is marked',
  );
  check(
    (await rows.nth(1).locator('button').innerText()).replace(/\s+/g, ' ') ===
      'Drove to work, Harbor Mill 07:30 to 07:52',
    'a trip says where to and when',
  );
  check((await rows.nth(0).getAttribute('data-carried')) !== null, 'an entry from before midnight is marked');
  check((await rows.nth(2).getAttribute('data-tick')) === '6950', 'each entry carries its tick');
  await page.screenshot({ path: join(out, 'follow-day-log-1280.png') });
  await page.evaluate(() => {
    window.__picked = [];
    window.__day.onPick = (i) => window.__picked.push(i);
  });
  await rows.nth(3).locator('button').click();
  await page.focus(`${card} [data-log] li:nth-child(2) button`);
  await page.keyboard.press('Enter');
  check(
    JSON.stringify(await page.evaluate(() => window.__picked)) === '[3,1]',
    'a click or Enter on an entry chooses it',
  );
  await page.evaluate(
    (v) =>
      window.__day.show({ ...v, status: 'loading', rows: [], current: null, note: 'Reading their day from the log.' }),
    view,
  );
  check(
    (await page.locator(`${card} [data-note]`).innerText()) === 'Reading their day from the log.',
    'the card says it is reading',
  );
  await page.evaluate(() => window.__day.show({ status: 'unavailable' }));
  check(await visible(page, `${card} [data-day]`), 'a page with no log goes back to the schedule');
  await context.close();
}
{
  const { context, page } = await open('tier=low&still&t=12&attract=0', DESKTOP);
  const card = '#follow';
  check(!(await visible(page, card)), 'no card until someone is followed');
  check(await page.evaluate(() => window.__following.start(5)), 'the page can follow a resident it is told of');
  await settle(page, 300);
  check(await visible(page, card), 'the card shows');
  await page.locator(`${card} [data-stop]`).click();
  check(!(await visible(page, card)), 'the card’s button stops following');
  // From the keyboard, the card's button stops it and focus goes to a control, not the page; a region always in the page says who.
  await page.evaluate(() => window.__following.start(5));
  await settle(page, 300);
  check(
    /^Following .+\.$/.test(await page.locator('body > [role=status].sr-only').first().textContent()),
    'a live region says who is followed',
  );
  await page.focus(`${card} [data-stop]`);
  await page.keyboard.press('Enter');
  check(!(await visible(page, card)), 'Enter on the card’s button stops following');
  check((await active(page)) === 'settings-button', 'focus goes to a control when the card goes');
  check(
    (await page.locator('body > [role=status].sr-only').first().textContent()) === '',
    'the live region is cleared',
  );
  for (const [what, act] of [
    [
      'a right drag',
      async () => {
        await page.mouse.move(640, 360);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(700, 380, { steps: 4 });
        await page.mouse.up({ button: 'right' });
      },
    ],
    [
      'a shift drag',
      async () => {
        await page.keyboard.down('Shift');
        await page.mouse.move(640, 360);
        await page.mouse.down();
        await page.mouse.move(700, 380, { steps: 4 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
      },
    ],
    ['a pan key', async () => page.keyboard.press('w')],
    ['the reset key', async () => page.keyboard.press('0')],
  ]) {
    await page.evaluate(() => window.__following.start(5));
    await settle(page, 200);
    await act();
    await settle(page, 200);
    check(!(await visible(page, card)), `${what} lets go`);
  }
  // The key list names the gesture.
  await page.keyboard.press('?');
  const groups = await page.locator('[data-keys] h3').allTextContents();
  check(groups.includes('Following'), 'the key list has a Following group');
  await context.close();
}
{
  // A resident the city does not have is said so, and the page carries on as it was.
  const { context, page } = await open('tier=low&still&t=12&follow=99999999', DESKTOP);
  check(!(await visible(page, '#follow')), 'a resident who does not exist gets no card');
  check(
    /no resident 99999999/.test(await page.locator('.toast').first().innerText()),
    'the page says there is no such resident',
  );
  await context.close();
}
{
  // Attract mode goes on turning the view round the one being followed, and a phone has room for the card.
  const { context, page } = await open('tier=low&t=12&follow=3&attract=2', DESKTOP);
  await settle(page, 2500);
  const first = await page.evaluate(() => window.__camera.state().azimuth);
  await settle(page, 1500);
  check((await page.evaluate(() => window.__camera.state().azimuth)) !== first, 'attract mode still turns the view');
  check(await visible(page, '#follow'), 'and the follow is kept');
  await context.close();
  const phone = await open('tier=low&still&t=12&follow=3&attract=0', PHONE);
  await settle(phone.page, 1000);
  const box = await phone.page.locator('#follow').boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= PHONE.width, 'the card fits on a phone');
  await phone.page.screenshot({ path: join(out, 'follow-day-360.png') });
  await phone.context.close();
}

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
