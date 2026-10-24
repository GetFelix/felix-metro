import * as THREE from 'three';
import { createCamera, startIntro } from './camera';
import { createHud } from './hud';
import { parseParams, type Tier } from './params';
import { createPost, passesFor } from './post';
import { createQuality, settingsFor } from './quality';
import { createRenderer } from './renderer';
import { createCity, move } from './scene';
import init, { generate, Metro } from './core/felix_metro_core.js';
import { parseCity, type City } from './layout';
import { beforeSignIn, fetchOidc, signIn } from './auth';
import { CityState, type Building } from './city';
import { TickClock, cityTime } from './clock';
import { connectLive } from './live';
import { Gateway, GatewayError } from './gateway';
import { SeekError, Seeker, fold, type SeekResult } from './seek';
import { createLoader, type Loader } from './loader';
import { createPicker } from './picker';
import { displayName } from './registry';
import { Traffic } from './traffic';

declare global {
  interface Window {
    /** True once the first frame is drawn with every model loaded. */
    __ready?: boolean;
    /** Tier history and GPU memory per tier, for the CI step-down check. Only set under ?slow or ?hud. */
    /** The live city's state, for the CI check and for looking at it from the console. */
    __live?: {
      tick: number;
      speed: number;
      voyages: number;
      /** Trips from the log that matched no route of their resident; zero when the sim and this page agree. */
      unplaced: number;
      /** Where each car and walker drawn now stands, in tiles from the middle of the map. */
      where(): { resident: number; car: boolean; x: number; z: number }[];
      /** Put the camera low beside the first car drawn. */
      closeUp(): boolean;
    };
    /** What became of each record the page took, as `[district, tick, result]`; only under ?trace. */
    __trace?: [number, number, string][];
    /** The seek behind a page opened with ?at: the tick shown, and the ms to find and fold the city, and the ms after that to its first frame. */
    __seek?: {
      tick: number;
      seekMs: number;
      drawMs: number | null;
      reads: number;
      /** The newest tick each district was folded to; every one is `tick` when the fold is whole. */
      ticks: number[];
    };
    /** Seeking in the open page, for the CI check and the console; the timeline will call the same thing. */
    __metro?: {
      /** Open the history connection ahead of the first seek. */
      prepare(): Promise<void>;
      /** Draw the city at `tick`; resolves after the first frame that shows it. */
      seek(tick: number): Promise<{
        tick: number;
        requested: number;
        exact: boolean;
        /** Each district's folded tick, and the offset of its record at `tick`. */
        ticks: number[];
        offsets: number[];
        buildings: number;
        sig: string;
        ms: number;
        /** The part of `ms` spent finding and folding, before the city was drawn. */
        seekMs: number;
        reads: number;
        stats: { readMs: number; slowestMs: number; pageSize: number };
      }>;
      /** The state the live connection feeds: its districts' ticks and buildings. */
      live(): { ticks: number[]; buildings: number; sig: string };
    };
    __quality?: {
      history: readonly Tier[];
      memory: { tier: Tier; textures: number; geometries: number }[];
    };
  }
}

/** Whether the connection is down; the clock runs on its own meanwhile. */
interface Link {
  down: boolean;
}

/**
 * Sign in at the gateway and follow the city's log; `null` when nothing here answers like a gateway or the city is
 * refused, so the page still draws the city, without its people. A gateway that is there but cannot be reached right now is not that: the
 * page shows `Reconnecting…` and keeps trying, and the city fills in when it gets through.
 */
async function follow(
  city: City,
  metro: Metro,
  name: string,
  districts: number,
  gateway: string | null,
  pill: HTMLElement,
  loader: Loader,
  trace: boolean,
): Promise<{ state: CityState; link: Link } | null> {
  const url = gateway ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const state = new CityState(city, metro, districts * districts);
  const link: Link = { down: false };
  const oidc = await fetchOidc(gateway ? url.replace(/^ws/, 'http').replace(/\/ws$/, '/') : location.origin + '/');
  if (!oidc) return null;
  if (trace) {
    window.__trace = [];
    state.onRecord = (d, t, r) => window.__trace!.push([d, t, r]);
  }
  const picker = createPicker(name, DEFAULT_DISTRICTS);
  const live = await connectLive({
    url,
    oidc,
    city: name,
    state,
    onDistrict: (d) => loader.ready(d),
    onCities: (cities) => picker.update(cities),
    onRefused: () => {
      pill.classList.add('hidden');
      document.getElementById('notice')!.classList.remove('hidden');
    },
    onStatus: (status) => {
      link.down = status !== 'live';
      pill.textContent = link.down ? 'Reconnecting…' : 'LIVE';
      pill.classList.toggle('late', link.down);
      pill.classList.remove('hidden');
    },
  });
  // Closing the sockets by hand, not leaving it to the browser, so the gateway sees the city's subscriptions end.
  addEventListener('pagehide', () => live.close());
  // A page restored from the back-forward cache has closed sockets and a stale city; a fresh load is the way back.
  addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
  return live.refused ? null : { state, link };
}

/**
 * Sign in on a connection of its own for reading history, so a seek never waits behind the live subscriptions. `null`
 * when nothing here answers like a gateway.
 */
async function openHistory(name: string, districts: number, gateway: string | null): Promise<Seeker | null> {
  const url = gateway ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const oidc = await fetchOidc(gateway ? url.replace(/^ws/, 'http').replace(/\/ws$/, '/') : location.origin + '/');
  if (!oidc) return null;
  // A session lets four reads wait at once, so a seek's reads spread over several. The gateway caps sessions per
  // person, so the ones it refuses are left out and the seek uses the rest.
  const token = await signIn(oidc);
  const tried = await Promise.allSettled(
    Array.from({ length: HISTORY_SESSIONS }, () => Gateway.connect(url, name, token)),
  );
  const sessions = tried.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (sessions.length === 0) throw new Error('the gateway would not open a session to read history');
  return new Seeker(sessions, districts * districts);
}

/** A short word on screen for something that did not work out, gone after a few seconds. */
function note(text: string): void {
  const el = document.createElement('p');
  el.style.cssText =
    'position:fixed;left:16px;bottom:16px;margin:0;padding:8px 12px;border-radius:8px;background:#000c;color:#fff;font:14px sans-serif;pointer-events:none';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

/** What to tell a person when a moment could not be opened. */
function whyNot(err: unknown): string {
  if (err instanceof SeekError && err.reason === 'unretained') return 'That moment is no longer kept.';
  if (err instanceof SeekError && err.reason === 'future') return 'That moment has not happened yet.';
  return 'That moment could not be opened.';
}

/** Buildings as one string, so two states can be compared without listing them. */
function signature(built: ReadonlyMap<number, Building>): string {
  const parts = [...built].sort((a, b) => a[0] - b[0]).map(([lot, b]) => `${lot}:${b.kind}:${b.rotation}`);
  let h = 5381;
  for (const c of parts.join(',')) h = (Math.imul(h, 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(16);
}

/** How long ago a wall time was, in the words the page uses for it. */
function ago(wallUs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - wallUs / 1000) / 60_000));
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} m ago`;
}

/** Connections history is read over. */
const HISTORY_SESSIONS = 6;

/** Districts on a side when `?districts` does not say. */
const DEFAULT_DISTRICTS = 2;

async function main() {
  const returned = beforeSignIn();
  const {
    frozenHour,
    still,
    tier: urlTier,
    ui,
    hud: showHud,
    slow,
    layout,
    seed,
    districts,
    live: wantLive,
    gateway,
    at,
    trace,
  } = parseParams(returned?.search ?? location.search, returned?.hash ?? location.hash);
  if (!ui) document.querySelectorAll('.chip').forEach((e) => e.classList.add('hidden'));
  // Switching city is a new page: its sockets close with the old one and nothing of it is left to tear down.
  addEventListener('hashchange', () => {
    if (parseParams(location.search, location.hash).seed !== seed) location.reload();
  });
  const loaderRoot = document.getElementById('loader')!;
  const showLoader = layout === 'city' && wantLive && ui;
  const loader: Loader = showLoader
    ? createLoader(loaderRoot, districts, seed)
    : { ready: () => {}, done: () => loaderRoot.classList.add('hidden') };
  if (!showLoader) loaderRoot.classList.add('hidden');

  let post: ReturnType<typeof createPost> | null = null;
  let hour = 18.5;
  let apply: (tier: Tier) => void = () => {};
  const quality = createQuality({ url: urlTier, still, onChange: (t) => apply(t) });

  const renderer = createRenderer(quality.tier);
  let city: City | null = null;
  let state: CityState | null = null;
  let link: Link = { down: false };
  /** The tick the city is held at when it was opened in the past, with no live connection. */
  let pastTick: number | null = null;
  let seekDone = 0;
  /** The history connection, opened by the first seek and kept for the ones after it. */
  let history: Promise<Seeker | null> | null = null;
  const seeker = () => (history ??= openHistory(seed, districts, gateway));
  const showPast = (result: SeekResult) => {
    pill.textContent = `Earlier · ${ago(result.districts[0]!.records.at(-1)!.wallUs)}`;
    pill.classList.add('late');
    pill.classList.remove('hidden');
    if (!result.exact) note('That exact moment is missing; showing the closest one before it.');
  };
  /** Told the frame after the city changed has been drawn. */
  const frameWaiters: (() => void)[] = [];
  const pill = document.getElementById('pill')!;
  if (layout === 'city') {
    await init();
    city = parseCity(generate(seed, districts));
    document.title = `Felix Metro: ${seed}`;
    document.getElementById('subtitle')!.textContent = displayName(seed);
    let past: { state: CityState; result: SeekResult; seekMs: number } | null = null;
    if (at !== null && !wantLive) note('Opening an earlier moment needs the live connection.');
    if (wantLive && at !== null) {
      try {
        const started = performance.now();
        const opened = await seeker();
        if (!opened) throw new Error('nothing here answers like a gateway');
        const result = await opened.seek(at);
        const folded = new CityState(city, new Metro(seed, districts), districts * districts);
        fold(folded, result);
        for (let d = 0; d < districts * districts; d++) loader.ready(d);
        past = { state: folded, result, seekMs: performance.now() - started };
      } catch (err) {
        // A moment the city does not hold, or no way to ask: show it live instead.
        console.warn('the city could not be opened at that moment', err);
        note(`${whyNot(err)} Showing the city live.`);
        history = null;
      }
    }
    if (past) {
      state = past.state;
      pastTick = past.result.tick;
      seekDone = performance.now();
      window.__seek = {
        tick: past.result.tick,
        seekMs: past.seekMs,
        drawMs: null,
        reads: (await seeker())!.stats.reads,
        ticks: [...past.state.ticks],
      };
      showPast(past.result);
    } else if (wantLive) {
      const joined = await follow(city, new Metro(seed, districts), seed, districts, gateway, pill, loader, trace);
      state = joined?.state ?? null;
      link = joined?.link ?? link;
      if (!joined) for (let d = 0; d < districts * districts; d++) loader.ready(d);
    }
  }
  const span = city ? Math.max(1, city.tiles / 17) : 1;
  const { camera, controls } = city
    ? createCamera(renderer.domElement, span * 1.2, new THREE.Vector3())
    : createCamera(renderer.domElement);
  const drawn: ReadonlyMap<number, Building> = new Map(state?.built);
  const { scene, cars, people, glows, setTime, setShadows, fleet, setLot } = await createCity(
    renderer,
    quality.tier,
    city,
    state !== null,
    drawn,
  );
  const hud = showHud ? createHud(renderer, quality) : null;

  // A tier change rebuilds the post chain; shadows and resolution follow the same settings.
  apply = (tier) => {
    const s = settingsFor(tier);
    post?.dispose();
    renderer.setPixelRatio(Math.min(devicePixelRatio, s.pixelRatioCap));
    setShadows(s.shadows, s.shadowMapSize);
    post = createPost(renderer, scene, camera, passesFor(tier), glows);
    setTime(hour, post.bloom);
  };

  const slider = document.getElementById('hour') as HTMLInputElement;
  const clockTicks = new TickClock();
  /** The buildings on screen, to work out what a different state changes. */
  const shown = new Map(drawn);
  const showLot = (lot: number, b: Building | null) => {
    void setLot(lot, b);
    if (b) shown.set(lot, b);
    else shown.delete(lot);
  };
  /** The state the live connection feeds, which keeps taking records while the page is held in the past. */
  const liveState = state;
  const traffic = state && fleet ? new Traffic(fleet, city ? (city.tiles - 1) / 2 : 0) : null;
  if (state && traffic) {
    // The sun follows the tick the page draws, so the slider is only a readout.
    slider.disabled = true;
    document.getElementById('timeline')!.dataset.live = '';
    state.onLot = showLot;
    for (const [lot, b] of state.changesSince(drawn)) showLot(lot, b);
    state.onVoyageEnd = (v) => traffic.release(v);
    hour = cityTime(Math.max(0, state.latest - 1)).hour;
  }
  hour = frozenHour ?? (state ? hour : parseFloat(slider.value));
  slider.value = String(hour);
  slider.addEventListener('input', () => {
    hour = parseFloat(slider.value);
    setTime(hour, post!.bloom);
  });
  post = createPost(renderer, scene, camera, passesFor(quality.tier), glows);
  setTime(hour, post.bloom);

  addEventListener('visibilitychange', () => quality.restartWindow());

  // Memory is read once per tier, after that tier has rendered, so freed passes show up as lower counts.
  const memory: NonNullable<Window['__quality']>['memory'] = [];
  if (slow || showHud) window.__quality = { history: quality.history, memory };

  const clock = new THREE.Clock();
  let last = performance.now();
  let shownHour = NaN;
  const day = document.getElementById('day')!;
  if (state && traffic) {
    window.__live = {
      tick: NaN,
      speed: state.speed,
      voyages: 0,
      unplaced: 0,
      where: () => traffic.where(),
      closeUp() {
        const car = traffic.where().find((w) => w.car);
        if (!car) return false;
        controls.target.set(car.x, 0.1, car.z);
        camera.position.set(car.x + 1.1, 0.55, car.z + 1.1);
        return true;
      },
    };
  }
  if (state && traffic && city) {
    const metro = new Metro(seed, districts);
    const summary = (s: CityState) => ({ ticks: [...s.ticks], buildings: s.built.size, sig: signature(s.built) });
    /** Draw `next` in place of the state on screen, which is let go; the live one keeps filling in the background. */
    const swap = (next: CityState, tick: number) => {
      const old = state!;
      if (old !== liveState) old.retire(Infinity);
      else for (const v of old.active()) traffic.release(v);
      old.onLot = null;
      old.onVoyageEnd = null;
      for (const [lot, b] of next.changesSince(shown)) showLot(lot, b);
      next.onLot = showLot;
      next.onVoyageEnd = (v) => traffic.release(v);
      state = next;
      pastTick = tick;
    };
    window.__metro = {
      async prepare() {
        await seeker();
      },
      async seek(tick) {
        const started = performance.now();
        try {
          const opened = await seeker();
          if (!opened) throw new Error('nothing here answers like a gateway');
          const result = await opened.seek(tick);
          const next = new CityState(city!, metro, districts * districts);
          fold(next, result);
          const seekMs = performance.now() - started;
          swap(next, result.tick);
          showPast(result);
          await new Promise<void>((done) => frameWaiters.push(done));
          return {
            tick: result.tick,
            requested: result.requested,
            exact: result.exact,
            ticks: [...next.ticks],
            offsets: result.districts.map((d) => d.offset),
            buildings: next.built.size,
            sig: signature(next.built),
            ms: performance.now() - started,
            seekMs,
            reads: opened.stats.reads,
            stats: { ...opened.stats },
          };
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) note(whyNot(err));
          if (err instanceof GatewayError && err.code === 'closed') history = null;
          throw err;
        }
      },
      live: () => summary(liveState!),
    };
  }
  let intro: ReturnType<typeof startIntro> | null = null;
  function frame() {
    const now = performance.now();
    if (intro && !intro.step(now)) intro = null;
    const frameMs = now - last;
    last = now;
    quality.tick(frameMs);
    hud?.frame(frameMs);
    if (slow) for (const end = performance.now() + slow; performance.now() < end; );
    const dt = still ? 0 : Math.min(clock.getDelta(), 0.05);
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    if (state && traffic && window.__live) {
      // The clock runs on real time even when frames are slow, so it stays with the sim.
      const tick = pastTick ?? clockTicks.advance(Math.min(1, frameMs / 1000), state.latest, state.speed, link.down);
      if (!Number.isNaN(tick)) {
        state.retire(Math.floor(tick));
        traffic.update(tick, still ? 0 : dt, state.active());
        const time = cityTime(tick);
        if (frozenHour === null && !(Math.abs(time.hour - shownHour) <= 0.004)) {
          shownHour = hour = time.hour;
          setTime(hour, post!.bloom);
          day.textContent = `Day ${time.day}`;
        }
        Object.assign(window.__live, {
          tick,
          speed: state.speed,
          voyages: state.voyages.size,
          unplaced: state.unplaced,
        });
      }
    }
    controls.update();
    post!.render(controls.target);
    for (const done of frameWaiters.splice(0)) done();
    // A live state the page has left keeps taking records; let its finished trips go.
    if (liveState && liveState !== state) liveState.retire(liveState.latest);
    if (window.__quality && memory[memory.length - 1]?.tier !== quality.tier) {
      const { textures, geometries } = renderer.info.memory;
      memory.push({ tier: quality.tier, textures, geometries });
    }
    requestAnimationFrame(frame);
  }
  move(cars, 0, true);
  move(people, 0, false);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (city && !still && frozenHour === null && !reduced) intro = startIntro(camera, controls, performance.now());
  frame();
  if (window.__seek) window.__seek.drawMs = performance.now() - seekDone;
  document.body.dataset.ready = '1';
  window.__ready = true;
  loader.done(state !== null && showLoader);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post!.resize();
  });
}

main().catch((err) => {
  console.error('the city could not start', err);
  document.getElementById('loader')?.classList.add('hidden');
  const note = document.createElement('p');
  note.style.cssText = 'position:fixed;inset:auto 16px 16px;margin:0;color:#fff;font:14px sans-serif';
  note.textContent = 'The city could not start. Reload to try again.';
  document.body.append(note);
});
