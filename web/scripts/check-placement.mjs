// Two builders edit the same live city at once and each sees what the other did, through the page's own build and
// demolish tools. Page A signs in as `mayor` and uses the mouse, page B as `architect` and uses touch; a third page
// signs in as `viewer`, who may watch but not build. A builds on one lot while B builds on another, both then try
// the same lot at the same moment (one build wins and the other is told so), A takes down B's building, and a page
// held at an earlier moment is checked to be off until Back to live. Then A lays harbor's one road over the cleared
// ground with the road tool, both pages draw it with the cars and ambient life running, and B takes it away again
// with two taps. Whatever was built is taken down at the end.
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
let step = 'starting';
let stepAt = Date.now();
const progress = (what) => {
  step = what;
  stepAt = Date.now();
};
const check = (ok, what) => {
  progress(what);
  if (!ok) problems.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const pages = [];
/** `work`, or `fallback` once `ms` have passed: a page whose renderer is hung can leave a Playwright call pending for good. */
const within = (ms, work, fallback) => {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, ms, fallback)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};
let failing = false;
const fail = async (message) => {
  // Two waits can fail together (Promise.all); the first one reports.
  if (failing) return new Promise(() => {});
  failing = true;
  console.error(message);
  for (const [i, page] of pages.entries())
    await within(
      10_000,
      page
        .screenshot({ path: join(out, `failure-${i}-${page.label.replace(/\W+/g, '-')}.png`), timeout: 5000 })
        .catch(() => {}),
    );
  await within(
    10_000,
    browser.close().catch(() => {}),
  );
  process.exit(1);
};

/** Where the browser's CPU time went over two seconds, by process: a spinning renderer and a spinning GPU look different. */
const busy = () =>
  within(
    10_000,
    (async () => {
      const cdp = await browser.newBrowserCDPSession();
      try {
        const sample = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
        const before = await sample();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return (await sample())
          .map((q) => {
            const was = before.find((o) => o.id === q.id)?.cpuTime ?? q.cpuTime;
            return `${q.type}#${q.id} ${Math.round(((q.cpuTime - was) / 2) * 100)}%`;
          })
          .join(', ');
      } finally {
        await cdp.detach().catch(() => {});
      }
    })().catch((e) => `no process info: ${e.message}`),
    'no process info',
  );

/**
 * Every Playwright call on a hung renderer can stay pending for good, whatever its own timeout says. Node's timers still
 * run, so a step that makes no progress for STALL_MS fails the run with the step it stopped at.
 */
const STALL_MS = 6 * MINUTE;
setInterval(async () => {
  if (failing || Date.now() - stepAt < STALL_MS) return;
  console.log(`browser cpu: ${await busy()}`);
  await fail(`no progress for ${STALL_MS / MINUTE} minutes; last step: ${step}`);
}, 15_000).unref();

/**
 * Software WebGL draws every page on one GPU process, and a page that is drawing keeps a loading one from ever drawing.
 * So the open pages park their frames while another loads. They stay signed in and live.
 */
const parkFrames = () => {
  const real = window.requestAnimationFrame.bind(window);
  const parked = [];
  let held = false;
  window.requestAnimationFrame = (cb) => (held ? (parked.push(cb), 0) : real(cb));
  window.__holdFrames = (on) => {
    held = on;
    if (!on) for (const cb of parked.splice(0)) real(cb);
  };
};
const holdFrames = (on) =>
  Promise.all(
    pages.map((page) =>
      within(
        5000,
        page
          .evaluate((h) => window.__holdFrames(h), on)
          .then(
            () => true,
            () => true,
          ),
        null,
      ).then((done) => done ?? console.log(`${page.label}: frames not ${on ? 'parked' : 'released'} in 5 s`)),
    ),
  );

/**
 * A page signed in as `who`, once its city is drawn and the live connection has caught up. A page that does not get
 * there in READY_MS is thrown away and opened again; a page that is really broken fails every try, and the failure says
 * what the page was doing. The deadline is ours, not Playwright's: on CI a renderer has hung outright (its connection
 * went quiet and nginx dropped it a minute later), and the Playwright calls on it never returned or timed out.
 */
const READY_MS = 120_000;
const OPEN_TRIES = 3;
async function open(name, who, options = {}) {
  for (let attempt = 1; ; attempt++) {
    await holdFrames(true);
    const started = Date.now();
    progress(`opening ${name}`);
    let context = null;
    let page = null;
    // An attempt we gave up on may still finish loading; it closes itself and its errors no longer count.
    let dead = false;
    const load = async () => {
      const mine = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...options });
      context = mine;
      if (dead) return mine.close().then(() => 'abandoned');
      await mine.addInitScript((t) => sessionStorage.setItem('metro.token', t), who);
      await mine.addInitScript(parkFrames);
      const tab = await mine.newPage();
      page = tab;
      if (dead) return mine.close().then(() => 'abandoned');
      page.label = name;
      page.crashed = false;
      page.on('crash', () => (page.crashed = true));
      page.on('pageerror', (e) => !dead && problems.push(`${name}: page error: ${e}`));
      page.on('console', (m) => m.type() === 'error' && console.log(`${name} console: ${m.text()}`));
      await page.goto(appUrl, { waitUntil: 'load', timeout: READY_MS });
      await page.waitForFunction(
        () => window.__ready === true && window.__build && Number.isFinite(window.__live?.tick),
        null,
        { polling: 250, timeout: Math.max(1000, READY_MS - (Date.now() - started)) },
      );
      return null;
    };
    const why = await within(
      READY_MS + 10_000,
      load().catch((e) => String(e?.message ?? e).split('\n')[0]),
      'no answer from the browser',
    );
    if (why !== null) dead = true;
    if (why === null) {
      await holdFrames(false);
      progress(`opened ${name}`);
      console.log(`opened ${name} in ${Date.now() - started} ms${attempt > 1 ? ` (try ${attempt})` : ''}`);
      pages.push(page);
      return { context, page };
    }
    // Say what the page was doing, without waiting on a page whose main thread may be stuck.
    const seen = page
      ? await within(
          5000,
          page.evaluate(() => ({ ready: window.__ready, build: !!window.__build, tick: window.__live?.tick })),
          'no answer from the page',
        ).catch((e) => String(e))
      : 'no page yet';
    console.log(
      `${name}: not drawn within ${READY_MS / 1000} s (try ${attempt}): ${why}; crashed=${page?.crashed} ${JSON.stringify(seen)}`,
    );
    console.log(`${name}: browser cpu: ${await busy()}`);
    if (attempt === OPEN_TRIES) {
      if (page) pages.push(page);
      await fail(`${name}: the city was never drawn`);
    }
    await within(
      10_000,
      context?.close().catch(() => {}),
    );
  }
}

const state = (page) => page.evaluate(() => window.__build.state());
const kindOn = (page, lot) => page.evaluate((l) => window.__build.kindOn(l), lot);
const HUNG = Symbol('hung');
const until = (page, fn, arg, what, timeout = 2 * MINUTE) => {
  progress(`${page.label}: waiting until ${what}`);
  return within(timeout + 10_000, page.waitForFunction(fn, arg, { polling: 250, timeout }), HUNG).then(
    (done) => {
      if (done === HUNG) return fail(`${page.label}: ${what} (the page stopped answering)`);
      progress(`${page.label}: ${what} was met`);
      return done;
    },
    (e) => fail(`${page.label}: ${what} (${String(e?.message ?? e).split('\n')[0]}; crashed=${page.crashed})`),
  );
};
/** Two frames on, so the camera has been placed and the lots' screen positions are current. */
const frames = (page) =>
  within(
    MINUTE,
    page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))),
    HUNG,
  ).then((done) => (done === HUNG ? fail(`${page.label}: no frame was drawn in a minute`) : done));

/**
 * Hold `tool` over `lot` and use it: with the mouse, or with a tap. Resolves with the state once the city has answered,
 * which the number of answers moves past.
 */
async function use(page, tool, lot, { kind = null, touch = false, confirm = false } = {}) {
  progress(`${page.label}: ${tool} on lot ${lot}`);
  await page.evaluate((l) => window.__build.focus(l), lot);
  await frames(page);
  const at = await page.evaluate((l) => window.__build.screenOf(l), lot);
  if (!at) await fail(`${page.label}: lot ${lot} is not on screen`);
  const { answered: before, sent } = await state(page);
  const button = tool === 'build' ? '#build-button' : '#demolish-button';
  if ((await state(page)).tool !== tool) await page.click(button);
  await until(page, (t) => window.__build.state().tool === t, tool, `the ${tool} tool was not picked`);
  if (kind !== null) await page.selectOption('#build-kind', String(kind));
  if (touch) {
    if (!confirm) {
      await page.touchscreen.tap(at.x, at.y);
    } else {
      // A touch demolish picks the building with the first tap and takes it down with the second, which must come within
      // a few seconds of the first (the page drops an unconfirmed pick after 5 s). On a slow runner every round trip to
      // the page takes seconds, so taps go out back to back at the place the first one found, with a short wait for the
      // command. A tap that came late only picks again, and the next one sends.
      const first = Date.now();
      await page.touchscreen.tap(at.x, at.y);
      await until(page, (l) => window.__build.state().preview?.lot === l, lot, `the first tap never picked lot ${lot}`);
      const picked = await state(page);
      check(picked.sent === sent && picked.pending === 0, 'the first tap of a touch demolish sends nothing');
      const TAPS = 8;
      for (let tap = 0; tap < TAPS; tap++) {
        await page.touchscreen.tap(at.x, at.y);
        const went = await within(
          5000,
          page
            .waitForFunction((n) => window.__build.state().sent > n, sent, { polling: 100, timeout: 1200 })
            .then(
              () => true,
              () => false,
            ),
          false,
        );
        console.log(
          `tap ${tap + 2} of the demolish, ${Date.now() - first} ms after the first: ${went ? 'sent' : 'not sent'}`,
        );
        if (went) break;
        if (tap === TAPS - 1)
          await fail(
            `${page.label}: no tap confirmed the demolish: ${JSON.stringify(await within(5000, state(page), null))}`,
          );
      }
    }
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
  check(/can only watch/.test(s.unavailable ?? ''), `a viewer is told: ${s.unavailable}`);
  check((await page.getAttribute('#build-button', 'aria-disabled')) === 'true', 'a viewer’s build button is off');
  await page.keyboard.press('b');
  check(
    (await state(page)).tool === null && !(await page.locator('#build-panel').isVisible()),
    'B gives a viewer no tool',
  );
  await within(
    10_000,
    context.close().catch(() => {}),
  );
  pages.pop();
}

// 2. Two builders. Pick two bare lots in the development area from what A sees.
// One after the other, so the first is parked while the second loads.
const b = await open('B (architect, touch)', architect, { hasTouch: true });
const a = await open('A (mayor, mouse)', mayor);
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
  const before = await state(a.page);
  await a.page.mouse.click(at.x, at.y);
  const s = await state(a.page);
  check(
    s.pending === 0 && s.sent === before.sent && s.answered === before.answered + 1 && /nothing here/.test(s.status),
    'the refused demolish was turned away in the page and not sent',
  );
}

// 5b. B takes down lot C's building with two taps, and A sees it go.
{
  const before = await use(b.page, 'demolish', lotC, { touch: true, confirm: true });
  const sb = await answer(b.page, before);
  check(sb.status === 'Taken down.', `B is told: ${sb.status}`);
  await until(
    a.page,
    (l) => {
      const k = window.__build.kindOn(l);
      return k === null || k === 65535 || k >= 38;
    },
    lotC,
    'A never saw lot C’s building go',
  );
  check(true, 'A sees B take it down with a double tap');
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
// 8. A road. Harbor has one pair of crossings a road may join over the cleared ground alone, nodes 6 and 7 on the north
// edge, with tiles (17, 0) and (18, 0) between them (core/examples/fixture.rs lays the same one).
{
  const [NODE_A, NODE_B] = [6, 7];
  const TILES = [
    [17, 0],
    [18, 0],
  ];
  const drawn = (page) =>
    page.evaluate(
      (tiles) => tiles.every(([x, z]) => window.__build.drawnRoads().some(([rx, rz]) => rx === x && rz === z)),
      TILES,
    );
  const { page } = a;
  check(!(await drawn(page)), 'no road is drawn between the two crossings yet');
  await page.evaluate(([x, z]) => window.__build.focusTile(x, z), [17.5, 0]);
  await frames(page);
  await page.keyboard.press('y');
  check((await state(page)).tool === 'road', 'the Y key picks the road tool');
  /** Move the mouse over a node and wait for the tool to find it; resolves with where it is on screen. */
  const point = async (node, kind) => {
    await frames(page);
    const at = await page.evaluate((n) => window.__build.screenOfNode(n), node);
    if (!at) await fail(`node ${node} is not on screen`);
    await page.mouse.move(at.x, at.y);
    await until(
      page,
      ([n, k]) => {
        const road = window.__build.state().road;
        return road?.kind === k && (k === 'start' ? road.a : road.b) === n;
      },
      [node, kind],
      `the pointer never found node ${node}`,
    );
    return at;
  };
  let at = await point(NODE_A, 'start');
  await page.mouse.click(at.x, at.y);
  await until(
    page,
    (n) => window.__build.state().roadStart === n,
    NODE_A,
    'the first click did not pick the first end',
  );
  at = await point(NODE_B, 'lay');
  const ghost = (await state(page)).road;
  check(ghost.ok, `the road's ghost fits: ${ghost.why ?? 'ok'}`);
  await page.screenshot({ path: join(out, 'a-road-ghost.png') });
  const before = (await state(page)).answered;
  await page.mouse.click(at.x, at.y);
  const laid = await answer(page, before);
  check(laid.status === 'Road laid.', `A is told: ${laid.status}`);
  for (const p of [a, b]) {
    await until(
      p.page,
      ([x, y]) => window.__build.roads().some((r) => r.a === x && r.b === y && !r.removed),
      [NODE_A, NODE_B],
      'the road never reached the city state',
    );
    await until(
      p.page,
      (tiles) => tiles.every(([x, z]) => window.__build.drawnRoads().some(([rx, rz]) => rx === x && rz === z)),
      TILES,
      'the road was never drawn',
    );
  }
  check(true, 'both pages draw the new road');

  // Laying it again is turned away in the page, with the reason shown in the panel. The first end is picked from the
  // node itself, since the road's own tiles beside it would offer the road for taking away.
  at = await point(NODE_A, 'start');
  await page.mouse.click(at.x, at.y);
  await until(page, (n) => window.__build.state().roadStart === n, NODE_A, 'the first end was not picked again');
  await point(NODE_B, 'lay');
  const again = (await state(page)).road;
  check(!again.ok && /already joins/.test(again.why), `the same road again is refused in the page: ${again.why}`);
  check(/already joins/.test((await page.textContent('#build-why')) ?? ''), 'the panel says why');
  await page.keyboard.press('Escape');
  const dropped = await state(page);
  check(dropped.roadStart === null && dropped.tool === 'road', 'Esc drops the first end and keeps the tool');

  // The cars and the ambient life go on over the new road: the city moves on with no page error.
  const ticked = await page.evaluate(() => window.__live.tick);
  await until(page, (t) => window.__live.tick > t + 4, ticked, 'the city stopped after the road was laid');
  check(await page.evaluate(() => Number.isFinite(window.__live.movers)), 'the traffic layer is drawing');
  await page.screenshot({ path: join(out, 'a-road.png') });
  await page.keyboard.press('Escape');

  // B takes it away with a tap to pick it and a tap to confirm, and A sees it go.
  const bp = b.page;
  await bp.evaluate(([x, z]) => window.__build.focusTile(x, z), [17.5, 0]);
  if ((await state(bp)).tool !== 'road') await bp.click('#road-button');
  await until(bp, () => window.__build.state().tool === 'road', null, 'B never picked the road tool');
  await frames(bp);
  const tile = await bp.evaluate(([x, z]) => window.__build.screenOfTile(x, z), TILES[0]);
  if (!tile) await fail('the new road is not on B’s screen');
  const { answered: beforeB, sent: sentB } = await state(bp);
  await bp.touchscreen.tap(tile.x, tile.y);
  await until(bp, () => window.__build.state().road?.kind === 'remove', null, 'B’s first tap never picked the road');
  check((await state(bp)).sent === sentB, 'the first tap of a road removal sends nothing');
  // As with the demolish, a confirming tap that comes after the pick lapsed only picks again, so tap until it is answered.
  for (let tap = 0; tap < 6; tap++) {
    await bp.touchscreen.tap(tile.x, tile.y);
    const answered = await within(
      5000,
      bp
        .waitForFunction((n) => window.__build.state().answered > n, beforeB, { polling: 100, timeout: 1500 })
        .then(
          () => true,
          () => false,
        ),
      false,
    );
    if (answered) break;
  }
  const gone = await answer(bp, beforeB);
  check(gone.status === 'Road taken away.', `B is told: ${gone.status}`);
  for (const p of [a, b]) {
    await until(
      p.page,
      (tiles) => !tiles.some(([x, z]) => window.__build.drawnRoads().some(([rx, rz]) => rx === x && rz === z)),
      TILES,
      'the road was never taken off the screen',
    );
  }
  check(true, 'both pages take the road off the screen');
  await bp.keyboard.press('Escape');
  await a.page.screenshot({ path: join(out, 'a-road-gone.png') });
}

await within(
  10_000,
  b.page.screenshot({ path: join(out, 'b-final.png') }).catch(() => {}),
);

await within(
  10_000,
  browser.close().catch(() => {}),
);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('two builders edited at once and saw each other’s changes');
process.exit(0);
