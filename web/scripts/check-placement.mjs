// Two builders edit the same live city at once and each sees what the other did, through the page's own build and
// demolish tools. Page A signs in as `mayor` and uses the mouse, page B as `architect` and uses touch; a third page
// signs in as `viewer`, who may watch but not build. A builds on one lot while B builds on another, both then try
// the same lot at the same moment (one build wins and the other is told so), A takes down B's building, and a page
// held at an earlier moment is checked to be off until Back to live. Whatever was built is taken down at the end.
//
// Usage: node scripts/check-placement.mjs <page url without a hash> <out dir>, against the running dev stack, whose
// seed was told METRO_BUILDERS=mayor,architect. IDP_URL (default http://127.0.0.1:9400) mints the tokens.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { withTrace } from './url.mjs';

const [pageUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: check-placement.mjs <page url> <out dir>');
mkdirSync(out, { recursive: true });
const CITY = 'harbor';
const appUrl = `${withTrace(pageUrl)}#${CITY}`;
const IDP = process.env.IDP_URL ?? 'http://127.0.0.1:9400';
const MINUTE = 60_000;
const TREE_FIRST = 38;
const NO_BUILDING = 65535;
const isEmpty = (kind) => kind === null || kind === NO_BUILDING || kind >= TREE_FIRST;

const token = async (sub) => (await (await fetch(`${IDP}/token?sub=${sub}&aud=felix-metro`)).json()).id_token;
const [mayor, architect, viewer] = await Promise.all(['mayor', 'architect', 'viewer'].map(token));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const pages = [];
const fail = async (message) => {
  console.error(message);
  for (const [i, page] of pages.entries())
    await page.screenshot({ path: join(out, `failure-${i}.png`) }).catch(() => {});
  await browser.close();
  process.exit(1);
};

/** A page signed in as `who`, once its city is drawn and the live connection has caught up. */
async function open(name, who, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...options });
  await context.addInitScript((t) => sessionStorage.setItem('metro.token', t), who);
  const page = await context.newPage();
  page.label = name;
  page.on('pageerror', (e) => problems.push(`${name}: page error: ${e}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`${name} console: ${m.text()}`));
  pages.push(page);
  await page.goto(appUrl, { waitUntil: 'load', timeout: 5 * MINUTE });
  await page
    .waitForFunction(() => window.__ready === true && window.__build && Number.isFinite(window.__live?.tick), null, {
      polling: 250,
      timeout: 5 * MINUTE,
    })
    .catch(() => fail(`${name}: the city was never drawn`));
  return { context, page };
}

const state = (page) => page.evaluate(() => window.__build.state());
const kindOn = (page, lot) => page.evaluate((l) => window.__build.kindOn(l), lot);
const until = (page, fn, arg, what, timeout = 2 * MINUTE) =>
  page.waitForFunction(fn, arg, { polling: 250, timeout }).catch(() => fail(`${page.label}: ${what}`));
/** Two frames on, so the camera has been placed and the lots' screen positions are current. */
const frames = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/**
 * Hold `tool` over `lot` and use it: with the mouse, or with a tap. Resolves with the state once the city has answered,
 * which the number of answers moves past.
 */
async function use(page, tool, lot, { kind = null, touch = false } = {}) {
  await page.evaluate((l) => window.__build.focus(l), lot);
  await frames(page);
  const at = await page.evaluate((l) => window.__build.screenOf(l), lot);
  if (!at) await fail(`${page.label}: lot ${lot} is not on screen`);
  const before = (await state(page)).answered;
  const button = tool === 'build' ? '#build-button' : '#demolish-button';
  if ((await state(page)).tool !== tool) await page.click(button);
  await until(page, (t) => window.__build.state().tool === t, tool, `the ${tool} tool was not picked`);
  if (kind !== null) await page.selectOption('#build-kind', String(kind));
  if (touch) {
    await page.touchscreen.tap(at.x, at.y);
  } else {
    await page.mouse.move(at.x, at.y);
    await until(page, (l) => window.__build.state().preview?.lot === l, lot, `the pointer never found lot ${lot}`);
    await page.mouse.click(at.x, at.y);
  }
  return before;
}

/** Wait for the answer to the command sent when `answered` stood at `before`. */
async function answer(page, before) {
  await until(page, (n) => window.__build.state().answered > n, before, 'the city never answered');
  return state(page);
}

// 1. A sign-in that may not build is told so, and no key or button gives it a tool.
{
  const { context, page } = await open('viewer', viewer);
  await until(page, () => window.__build.state().unavailable !== null, null, 'the viewer was never judged');
  const s = await state(page);
  check(/cannot build/.test(s.unavailable ?? ''), `a viewer is told: ${s.unavailable}`);
  check((await page.getAttribute('#build-button', 'aria-disabled')) === 'true', 'a viewer’s build button is off');
  await page.keyboard.press('b');
  check(
    (await state(page)).tool === null && !(await page.locator('#build-panel').isVisible()),
    'B gives a viewer no tool',
  );
  await context.close();
  pages.pop();
}

// 2. Two builders. Pick two bare lots in the development area from what A sees.
const a = await open('A (mayor, mouse)', mayor);
const b = await open('B (architect, touch)', architect, { hasTouch: true });
for (const { page } of [a, b]) {
  await until(page, () => window.__build.state().unavailable === null, null, 'the builder was never allowed');
}
const bare = await a.page.evaluate(() =>
  window.__build.development().filter((lot) => {
    const kind = window.__build.kindOn(lot);
    return kind === null || kind === 65535 || kind >= 38;
  }),
);
if (bare.length < 3) await fail(`only ${bare.length} bare lots in the development area`);
const [lotA, lotB, lotC] = bare;
const HOUSE = 21;
const SHOP = 3;
console.log(`building on lots ${lotA} (A), ${lotB} (B) and ${lotC} (both)`);

// 3. Both build at once, each on its own lot.
{
  const [beforeA, beforeB] = await Promise.all([
    use(a.page, 'build', lotA, { kind: HOUSE }),
    use(b.page, 'build', lotB, { kind: SHOP, touch: true }),
  ]);
  const [sa, sb] = await Promise.all([answer(a.page, beforeA), answer(b.page, beforeB)]);
  check(sa.status === 'Built.', `A is told: ${sa.status}`);
  check(sb.status === 'Built.', `B is told: ${sb.status}`);
  await a.page.screenshot({ path: join(out, 'a-built.png') });
  for (const { page } of [a, b]) {
    await until(
      page,
      ([la, lb, ka, kb]) => window.__build.kindOn(la) === ka && window.__build.kindOn(lb) === kb,
      [lotA, lotB, HOUSE, SHOP],
      'one of the buildings never showed',
    );
  }
  check(true, 'each page shows both buildings, its own and the other builder’s');
}

// 4. Both go for the same lot at the same moment. One wins; the other is told, in words, and nothing stays pending.
{
  const [beforeA, beforeB] = await Promise.all([
    use(a.page, 'build', lotC, { kind: HOUSE }),
    use(b.page, 'build', lotC, { kind: SHOP, touch: true }),
  ]);
  const [sa, sb] = await Promise.all([answer(a.page, beforeA), answer(b.page, beforeB)]);
  const told = [sa.status, sb.status];
  check(told.includes('Built.'), `one of the two is told: ${told.join(' / ')}`);
  const loser = told.find((t) => t !== 'Built.');
  check(
    loser === undefined || /Someone built there first|already a building/.test(loser),
    `the other is told in plain words: ${loser}`,
  );
  check(sa.pending === 0 && sb.pending === 0, 'nothing is left pending');
  await Promise.all(
    [a, b].map(({ page }) =>
      until(
        page,
        (l) => ![null, 65535].includes(window.__build.kindOn(l)) && window.__build.kindOn(l) < 38,
        lotC,
        'lot C never showed a building',
      ),
    ),
  );
  const [ka, kb] = await Promise.all([kindOn(a.page, lotC), kindOn(b.page, lotC)]);
  check(ka === kb && !isEmpty(ka), `both pages show the same building on lot ${lotC} (${ka}, ${kb})`);
}

// 5. A takes down B's building; B sees it go. A second try on the empty lot is turned away before it is sent.
{
  const beforeA = await use(a.page, 'demolish', lotB);
  const sa = await answer(a.page, beforeA);
  check(sa.status === 'Taken down.', `A is told: ${sa.status}`);
  await until(
    b.page,
    (l) => {
      const k = window.__build.kindOn(l);
      return k === null || k === 65535 || k >= 38;
    },
    lotB,
    'B never saw its building go',
  );
  check(true, 'B sees A take its building down');
  await a.page.mouse.move(1, 1);
  const at = await a.page.evaluate((l) => window.__build.screenOf(l), lotB);
  await a.page.mouse.move(at.x, at.y);
  await until(a.page, (l) => window.__build.state().preview?.lot === l, lotB, 'A’s pointer never found the empty lot');
  const preview = (await state(a.page)).preview;
  check(
    !preview.ok && /nothing here/.test(preview.why),
    `a demolish on bare ground is refused in the page: ${preview.why}`,
  );
  const before = (await state(a.page)).answered;
  await a.page.mouse.click(at.x, at.y);
  const s = await state(a.page);
  check(s.pending === 0 && s.answered === before && /nothing here/.test(s.status), 'the refused demolish was not sent');
}

// 6. Held at an earlier moment, the tools are off and say why; Back to live brings them back.
{
  const { page } = a;
  await page.keyboard.press('b');
  check((await state(page)).tool === 'build', 'the B key picks the build tool at the live tip');
  const tick = await page.evaluate(() => Math.max(0, Math.floor(window.__live.tick) - 400));
  await page.evaluate((t) => window.__metro.seek(t), tick);
  await until(page, () => window.__build.state().unavailable !== null, null, 'the tools stayed on in the past');
  const s = await state(page);
  check(/Go back to live/.test(s.unavailable), `in the past the tools say: ${s.unavailable}`);
  check(s.tool === null, 'the tool in hand is put away on leaving the live city');
  check((await page.getAttribute('#build-button', 'aria-disabled')) === 'true', 'the build button is off in the past');
  await page.keyboard.press('b');
  check((await state(page)).tool === null, 'the B key picks nothing in the past');
  await page.screenshot({ path: join(out, 'a-past.png') });
  await page.click('#back-live');
  await until(
    page,
    () => window.__build.state().unavailable === null,
    null,
    'the tools never came back after Back to live',
    3 * MINUTE,
  );
  check(true, 'Back to live turns the tools back on');
}

// 7. Take down what the check built, so the city is as it was found.
for (const lot of [lotA, lotC]) {
  if (isEmpty(await kindOn(a.page, lot))) continue;
  const before = await use(a.page, 'demolish', lot);
  const s = await answer(a.page, before);
  check(s.status === 'Taken down.', `lot ${lot} is taken down again: ${s.status}`);
}
await Promise.all(
  [a, b].map(({ page }) =>
    until(
      page,
      (ls) =>
        ls.every((l) => {
          const k = window.__build.kindOn(l);
          return k === null || k === 65535 || k >= 38;
        }),
      [lotA, lotB, lotC],
      'the lots were not left bare',
    ),
  ),
);
await b.page.screenshot({ path: join(out, 'b-final.png') });

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('two builders edited at once and saw each other’s changes');
