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
import { TICKS_PER_HOUR, TickClock, cityTime } from './clock';
import { connectLive } from './live';
import { Gateway, GatewayError } from './gateway';
import { SeekError, Seeker, fold, tryFoldMore, type SeekResult } from './seek';
import { Latest } from './scrub';
import { agoText, createTimeline, stepTick, clampTick, type Range } from './timeline';
import { createLoader, type Loader } from './loader';
import { createPicker } from './picker';
import { displayName } from './registry';
import { Traffic } from './traffic';
import { sample, type Path } from './capture';

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
      where(): { resident: number; car: boolean; x: number; z: number; heading: number }[];
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
        /** The ms until every car and walker of the moment has a model, which is after the first frame. */
        settledMs: number;
        reads: number;
        stats: { readMs: number; slowestMs: number; pageSize: number };
      }>;
      /** The state the live connection feeds: its districts' ticks and buildings. */
      live(): { ticks: number[]; buildings: number; sig: string };
      /** The state on screen: its folded ticks, building count and signature, the tick held in the past or null, and whether it is the live one. */
      shown(): { ticks: number[]; buildings: number; sig: string; past: number | null; live: boolean };
      /** Whether the history sessions have been asked for. */
      historyOpen(): boolean;
      /** Read the span the timeline covers now. */
      refresh(): Promise<void>;
      /** Hold each scrub seek this many ms before it is shown; 0 for none. */
      holdSeeks(ms: number): void;
    };
    /** Frame-by-frame drawing for the clip job; only under ?capture&trace. */
    __capture?: {
      /** The city's side in tiles. */
      tiles: number;
      /** Where the camera stands and looks and how far the tick runs, by video time in ms. */
      setPath(path: Path): void;
      /** Draw the frame at video time `tMs` and say what is in it. */
      frame(tMs: number): Promise<CaptureFrame>;
    };
    __quality?: {
      history: readonly Tier[];
      memory: { tier: Tier; textures: number; geometries: number }[];
    };
  }
}

/** What a captured frame holds, to check the shot is busy. */
interface CaptureFrame {
  tick: number;
  clock: string;
  cars: number;
  walkers: number;
  carsInView: number;
  walkersInView: number;
  /** Draw calls, triangles and shader programs of the last draw, and the ms the GPU took to finish it. */
  gpu: { calls: number; triangles: number; programs: number; finishMs: number };
  /** Where the ms of this frame went: waiting for the sim, drawing, and turning the canvas into a picture. */
  spent: { waitMs: number; drawMs: number; imageMs: number };
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
 * A history reader on connections of its own, so a seek never waits behind the live subscriptions. The sessions are
 * opened by the first seek and closed after a while idle, so a page not seeking holds none of the gateway's
 * per-person sessions. `null` when nothing here answers like a gateway.
 */
async function openHistory(name: string, districts: number, gateway: string | null): Promise<Seeker | null> {
  const url = gateway ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const oidc = await fetchOidc(gateway ? url.replace(/^ws/, 'http').replace(/\/ws$/, '/') : location.origin + '/');
  if (!oidc) return null;
  const seeker = new Seeker(async () => {
    const token = await signIn(oidc);
    // The ones the gateway refuses are left out: history reads on fewer, and the live view's own session is never
    // what gives way.
    const tried = await Promise.allSettled(
      Array.from({ length: HISTORY_SESSIONS }, () => Gateway.connect(url, name, token)),
    );
    const sessions = tried.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (sessions.length === 0) throw new Error('the gateway would not open a session to read history');
    return sessions;
  }, districts * districts);
  // The gateway counts sessions until it sees them close, and a page opened next may be waiting on that.
  addEventListener('pagehide', () => seeker.close());
  return seeker;
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

/** Connections history is read over: two sessions keep eight reads in flight, and the gateway allows eight a person. */
const HISTORY_SESSIONS = 2;

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
    capture,
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
  /** The history reader, made by the first seek and kept for the ones after it. */
  let history: Promise<Seeker | null> | null = null;
  const dropHistory = () => {
    void history?.then(
      (s) => s?.close(),
      () => {},
    );
    history = null;
  };
  const seeker = () => (history ??= openHistory(seed, districts, gateway));
  /** The seeks behind the state on screen, to fold forward from, or null when it is the live one. */
  let shownResult: SeekResult | null = null;
  /** The tick the handle is at while a seek for it is waiting or running; the sun and the clock follow it. */
  let scrubTarget: number | null = null;
  /** Whether a live connection feeds this page; a page opened with ?at has none. */
  let hasLive = false;
  /** Draws the bar and the past pill from the tick on screen; set once the page can scrub. */
  let timelineFrame: ((tick: number) => void) | null = null;
  /** Resolves when no scrub seek is waiting or running; the clip job draws a frame only after it. */
  let scrubSettled: () => Promise<void> = async () => {};
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
        dropHistory();
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
      shownResult = past.result;
      if (!past.result.exact) note('That exact moment is missing; showing the closest one before it.');
    } else if (wantLive) {
      hasLive = true;
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
    const swap = (next: CityState, tick: number | null) => {
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

    /** The seeker once the first seek has opened it, for what needs it without waiting. */
    let opened: Seeker | null = null;
    const hourOf = (tick: number) => Math.floor(tick / TICKS_PER_HOUR);
    /** A release or step this close to the live tip, a city minute, goes back to live. */
    const LIVE_SNAP_TICKS = 4;
    /** What the bar spans; the newest end is the live tip while connected. */
    let range: Range | null = null;
    const tipTick = () => (hasLive ? liveState!.latest : (range?.newest ?? 0));
    const refreshing = { busy: false };
    /** Test knob: milliseconds each scrub seek waits before it is shown, to hold one in flight. */
    let holdSeeks = 0;
    const refreshRange = async () => {
      if (refreshing.busy) return;
      refreshing.busy = true;
      try {
        const s = await seeker();
        if (!s) return;
        opened = s;
        range = await s.retained();
      } catch (err) {
        console.warn('the span of the timeline could not be read', err);
        if (err instanceof GatewayError && err.code === 'closed') dropHistory();
      } finally {
        refreshing.busy = false;
      }
    };
    const goLive = () => {
      scrubLatest.cancel();
      scrubTarget = null;
      if (!hasLive) {
        // Nothing live feeds a page opened at a moment; opening it again without one is the way back.
        const url = new URL(location.href);
        url.searchParams.delete('at');
        location.assign(url);
        return;
      }
      // A seek still running was dropped above; with nothing past drawn there is nothing to swap back.
      if (pastTick === null) return;
      swap(liveState!, null);
      shownResult = null;
    };
    /** Show a seek's result unless the handle has already moved to an hour whose keyframe is on screen. */
    const place = (result: SeekResult) => {
      if (scrubTarget !== null && hourOf(result.tick) !== hourOf(scrubTarget)) {
        const kf = opened?.cachedKeyframe(scrubTarget);
        if (kf && pastTick !== null && hourOf(pastTick) === hourOf(kf.tick)) return;
      }
      if (shownResult && pastTick !== null && tryFoldMore(state!, shownResult, result)) {
        pastTick = result.tick;
      } else {
        const next = new CityState(city!, metro, districts * districts);
        fold(next, result);
        swap(next, result.tick);
      }
      shownResult = result;
    };
    /** The nearest keyframe on hand, drawn at once while the handle moves. */
    const preview = (tick: number) => {
      const kf = opened?.cachedKeyframe(tick);
      if (!kf || (pastTick !== null && hourOf(pastTick) === hourOf(kf.tick))) return;
      const next = new CityState(city!, metro, districts * districts);
      fold(next, kf);
      swap(next, kf.tick);
      shownResult = kf;
    };
    const scrubLatest = new Latest(async (tick, current) => {
      try {
        const s = await seeker();
        if (!s) throw new Error('nothing here answers like a gateway');
        opened = s;
        const result = await s.seek(tick);
        if (holdSeeks > 0) await new Promise((done) => setTimeout(done, holdSeeks));
        // Back to live came while this seek ran: what it found is no longer wanted.
        if (!current()) return;
        try {
          place(result);
        } catch (err) {
          // The state on screen may be half drawn; the next seek starts from a fresh one.
          shownResult = null;
          throw err;
        }
      } catch (err) {
        if (!current()) return;
        note(whyNot(err));
        if (err instanceof SeekError && err.reason === 'unretained') void refreshRange();
        if (err instanceof GatewayError && err.code === 'closed') dropHistory();
        if (scrubLatest.pending === null && scrubTarget === tick) scrubTarget = null;
        return;
      }
      if (scrubLatest.pending === null && scrubTarget === tick) scrubTarget = null;
    });
    scrubSettled = () => scrubLatest.settled();
    /** Where the handle is, to step from: the target if one is on its way. */
    const handleAt = () => scrubTarget ?? pastTick ?? Math.floor(liveState!.latest);
    const go = (tick: number, moving: boolean) => {
      if (!range) return;
      const tip = tipTick();
      const to = clampTick({ oldest: range.oldest, newest: tip }, tick);
      // The tip is the live city: a step or a release within a city minute of it is going back to it.
      if (hasLive && !moving && to >= tip - LIVE_SNAP_TICKS) return goLive();
      scrubTarget = to;
      preview(to);
      scrubLatest.want(to, moving);
    };
    let refresher: ReturnType<typeof setInterval> | null = null;
    const bar = createTimeline(document.getElementById('scrub')!, {
      onMove: (tick, phase) => go(tick, phase === 'drag'),
      onStep: (direction, big) => {
        if (range) go(stepTick({ oldest: range.oldest, newest: tipTick() }, handleAt(), direction, big), false);
      },
      onLive: goLive,
      // Reaching for the bar is what reads the span, once; the history sessions are not opened for a viewer who never does.
      onEngage: (on) => {
        if (on) void refreshRange();
      },
    });
    // The oldest moment moves as retention does, so the span is read again while the handle is dragged or the past is
    // shown. Hovering does not, so the history sessions can close when idle.
    const syncRefresh = (watching: boolean) => {
      if (watching === (refresher !== null)) return;
      if (refresher) clearInterval(refresher);
      refresher = null;
      if (!watching) return;
      void refreshRange();
      refresher = setInterval(() => void refreshRange(), 5000);
    };
    const timelineEl = document.getElementById('timeline')!;
    const past = document.getElementById('past')!;
    const pastAgo = document.getElementById('past-ago')!;
    document.getElementById('back-live')!.addEventListener('click', goLive);
    let barShown = false;
    let wasPast: boolean | null = null;
    let agoShown = '';
    timelineFrame = (tick) => {
      const tip = tipTick();
      // Until the span is read the bar has just the live tip.
      const usable = range === null ? hasLive : tip > range.oldest;
      if (usable !== barShown) {
        barShown = usable;
        bar.show(usable);
        timelineEl.toggleAttribute('data-scrub', usable);
      }
      const inPast = pastTick !== null || scrubTarget !== null;
      syncRefresh(bar.dragging || inPast);
      const at = Math.min(scrubTarget ?? pastTick ?? tick, tip);
      if (usable) bar.update({ oldest: range?.oldest ?? tip - 1, newest: tip, at, live: !inPast });
      if (inPast !== wasPast) {
        const first = wasPast === null;
        wasPast = inPast;
        past.classList.toggle('hidden', !inPast);
        // The live pill is shown by the connection's own status; going past hides it, coming back restores it.
        if (inPast) pill.classList.add('hidden');
        else if (!first) pill.classList.remove('hidden');
      }
      if (inPast) {
        const text = usable ? agoText(tip - at) : 'Earlier';
        if (text !== agoShown) pastAgo.textContent = agoShown = text;
      }
    };
    // A page opened in the past already has its history open, and no live tip to show the bar with.
    if (!hasLive) {
      void (async () => {
        await new Promise<void>((done) => frameWaiters.push(done));
        void refreshRange();
      })();
    }
    window.__metro = {
      async prepare() {
        await (await seeker())?.warm();
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
          shownResult = result;
          if (!result.exact) note('That exact moment is missing; showing the closest one before it.');
          await new Promise<void>((done) => frameWaiters.push(done));
          const drawnMs = performance.now() - started;
          // Cars and walkers are made a share a frame, so the city fills in over the frames after the first.
          let frames = 0;
          while (traffic.waiting > 0 && frames++ < 600) await new Promise<void>((done) => frameWaiters.push(done));
          return {
            tick: result.tick,
            requested: result.requested,
            exact: result.exact,
            ticks: [...next.ticks],
            offsets: result.districts.map((d) => d.offset),
            buildings: next.built.size,
            sig: signature(next.built),
            ms: drawnMs,
            seekMs,
            settledMs: performance.now() - started,
            reads: opened.stats.reads,
            stats: { ...opened.stats },
          };
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) note(whyNot(err));
          if (err instanceof GatewayError && err.code === 'closed') dropHistory();
          throw err;
        }
      },
      live: () => summary(liveState!),
      shown: () => ({ ...summary(state!), past: pastTick, live: state === liveState }),
      historyOpen: () => history !== null,
      refresh: refreshRange,
      holdSeeks: (ms) => {
        holdSeeks = ms;
      },
    };
  }
  let intro: ReturnType<typeof startIntro> | null = null;
  /** The tick the clip script wants drawn, or null to let the clock steer. */
  let captureTick: number | null = null;
  function frame() {
    const now = performance.now();
    draw(now, now - last, still ? 0 : Math.min(clock.getDelta(), 0.05));
    requestAnimationFrame(frame);
  }
  /** Draw one frame `dt` seconds on from the last. */
  function draw(now: number, frameMs: number, dt: number, paint = true) {
    if (intro && !intro.step(now)) intro = null;
    last = now;
    if (!capture) quality.tick(frameMs);
    hud?.frame(frameMs);
    if (slow) for (const end = performance.now() + slow; performance.now() < end; );
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    if (state && traffic && window.__live) {
      // The clock runs on real time even when frames are slow, so it stays with the sim.
      const tick =
        pastTick ??
        captureTick ??
        clockTicks.advance(Math.min(1, frameMs / 1000), state.latest, state.speed, link.down);
      if (!Number.isNaN(tick)) {
        state.retire(Math.floor(tick));
        traffic.update(tick, still ? 0 : dt, state.active());
        const time = cityTime(scrubTarget ?? tick);
        if (frozenHour === null && !(Math.abs(time.hour - shownHour) <= 0.004)) {
          shownHour = hour = time.hour;
          setTime(hour, post!.bloom);
          day.textContent = `Day ${time.day}`;
        }
        timelineFrame?.(tick);
        Object.assign(window.__live, {
          tick,
          speed: state.speed,
          voyages: state.voyages.size,
          unplaced: state.unplaced,
        });
      }
    }
    if (capture) camera.lookAt(controls.target);
    else controls.update();
    if (paint) post!.render(controls.target);
    for (const done of frameWaiters.splice(0)) done();
    // A live state the page has left keeps taking records; let its finished trips go.
    if (liveState && liveState !== state) liveState.retire(liveState.latest);
    if (window.__quality && memory[memory.length - 1]?.tier !== quality.tier) {
      const { textures, geometries } = renderer.info.memory;
      memory.push({ tier: quality.tier, textures, geometries });
    }
  }
  /** The clip script's way in: one frame at a time at a video time, the camera and the tick following the path it set. */
  function captureApi(): NonNullable<Window['__capture']> {
    let path: Path = { position: [], target: [], ticks: [] };
    let base: number | null = null;
    let lastMs: number | null = null;
    let held: { x: number; z: number } | null = null;
    let still: HTMLImageElement | null = null;
    const picture = new URLSearchParams(location.search).has('picture');
    const view = new THREE.Vector3();
    const inView = (x: number, z: number) => {
      view.set(x, 0.1, z).project(camera);
      return Math.abs(view.x) <= 1 && Math.abs(view.y) <= 1 && view.z < 1;
    };
    return {
      tiles: city?.tiles ?? 0,
      setPath(next) {
        path = next;
      },
      async frame(tMs) {
        const began = performance.now();
        await scrubSettled();
        const [cam, aim] = [sample(path.position, tMs), sample(path.target, tMs)];
        if (cam.length) camera.position.set(cam[0]!, cam[1]!, cam[2]!);
        if (aim.length) controls.target.set(aim[0]!, aim[1]!, aim[2]!);
        const follow = path.follow;
        if (follow && tMs < follow.until && traffic) {
          let cars = traffic.where().filter((w) => w.car);
          let lead = cars.find((w) => w.resident === follow.resident);
          if (!lead && held) {
            // The car has arrived; carry on behind the nearest one to where the camera was.
            const near = cars.sort(
              (a, b) => Math.hypot(a.x - held!.x, a.z - held!.z) - Math.hypot(b.x - held!.x, b.z - held!.z),
            )[0];
            if (near && Math.hypot(near.x - held.x, near.z - held.z) < 6) follow.resident = (lead = near).resident;
          }
          if (lead) {
            const [fx, fz] = [Math.sin(lead.heading), Math.cos(lead.heading)];
            const back = follow.back + (follow.backEnd - follow.back) * Math.min(1, tMs / follow.until);
            held = { x: lead.x, z: lead.z };
            const w = Math.min(1, Math.max(0, (follow.until - tMs) / follow.blend));
            const e = w * w * (3 - 2 * w);
            const mix = (a: number, b: number) => b + (a - b) * e;
            const own = [lead.x - fx * back + fz * follow.side, follow.up, lead.z - fz * back - fx * follow.side];
            const look = [lead.x + fx * follow.ahead, 0.25, lead.z + fz * follow.ahead];
            camera.position.set(
              mix(own[0]!, camera.position.x),
              mix(own[1]!, camera.position.y),
              mix(own[2]!, camera.position.z),
            );
            controls.target.set(
              mix(look[0]!, controls.target.x),
              mix(look[1]!, controls.target.y),
              mix(look[2]!, controls.target.z),
            );
          }
        }
        captureTick = null;
        if (pastTick === null && liveState && path.ticks.length) {
          base ??= Math.floor(liveState.latest) - 1;
          const want = base + sample(path.ticks, tMs)[0]!;
          // The sim runs ahead of the clip; if it has not got there yet, wait for it rather than draw a gap.
          for (let waited = 0; liveState.latest < want + 1; waited += 25) {
            if (waited > 120_000) throw new Error(`the sim did not reach tick ${Math.ceil(want)}`);
            await new Promise((done) => setTimeout(done, 25));
          }
          captureTick = want;
        }
        const waited = performance.now();
        const dt = lastMs === null ? 0 : Math.max(0, (tMs - lastMs) / 1000);
        lastMs = tMs;
        draw(performance.now(), 1000 / 30, dt, false);
        // Cars and walkers get their models a share a frame; update on, without drawing, until all of them have one.
        for (let i = 0; i < 600 && traffic && traffic.waiting > 0; i++) draw(performance.now(), 0, 0, false);
        draw(performance.now(), 0, 0);
        // With ?picture the canvas is read out now and shown as a picture under the overlay, for a machine whose GL is
        // software and too slow to screenshot.
        const canvas = renderer.domElement;
        const drawn = performance.now();
        const finishAt = performance.now();
        renderer.getContext().finish();
        const finishMs = performance.now() - finishAt;
        if (picture) {
          still ??= document.createElement('img');
          still.style.cssText = 'position:absolute;top:0;left:0;display:block;z-index:0;width:100vw;height:100vh';
          still.src = canvas.toDataURL('image/jpeg', 0.95);
          await still.decode();
          if (!still.isConnected) canvas.after(still);
          canvas.style.visibility = 'hidden';
        }
        const imaged = performance.now();
        const where = traffic?.where() ?? [];
        const cars = where.filter((w) => w.car);
        const walkers = where.filter((w) => !w.car);
        return {
          tick: window.__live?.tick ?? NaN,
          clock: document.getElementById('clock')!.textContent ?? '',
          cars: cars.length,
          walkers: walkers.length,
          carsInView: cars.filter((w) => inView(w.x, w.z)).length,
          walkersInView: walkers.filter((w) => inView(w.x, w.z)).length,
          spent: { waitMs: waited - began, drawMs: drawn - waited, imageMs: imaged - drawn },
          gpu: {
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            programs: renderer.info.programs?.length ?? 0,
            finishMs,
          },
        };
      },
    };
  }
  move(cars, 0, true);
  move(people, 0, false);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (city && !still && frozenHour === null && !reduced && !capture)
    intro = startIntro(camera, controls, performance.now());
  if (capture) {
    controls.enabled = false;
    window.__capture = captureApi();
    draw(performance.now(), 0, 0);
  } else frame();
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
