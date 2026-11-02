import * as THREE from 'three';
import { createCamera, startIntro, type CameraRig } from './camera';
import { cityBounds } from './camera-math';
import { createHud } from './ui/hud';
import { hintDue } from './ui/hint';
import { ATTRACT_RATE, createAttract } from './attract';
import { momentLink } from './moments';
import { PHOTO_CLASS, createPhoto } from './ui/photo';
import { createFollowCard, isFollowKey, isStopKey } from './ui/follow-card';
import { Following } from './follow';
import { DayPanel, type DayView } from './day-panel';
import { bindTap } from './tap';
import { createShare } from './ui/share';
import { isPlayKey } from './ui/keys';
import { parseParams, type Tier } from './params';
import { createPost, passesFor } from './post';
import { createQuality, settingsFor } from './quality';
import { createRenderer } from './renderer';
import { createCity, move } from './scene';
import init, { chapter as chapterJson, generate, Metro } from './core/felix_metro_core.js';
import { parseCity, type City } from './layout';
import { RoadsOnScreen } from './roads-drawn';
import { beforeSignIn, fetchOidc, signIn } from './auth';
import { CityState, ROAD_ADDED, syncRoads, type Building, type TickRecord } from './city';
import { TICKS_PER_HOUR, TickClock, cityTime } from './clock';
import { connectLive, onOldLog } from './live';
import { Gateway, GatewayError } from './gateway';
import { Playback, handOver } from './playback';
import { IDLE_MS, SeekError, Seeker, fold, tryFoldMore, type SeekResult } from './seek';
import { neighbours } from './rewind';
import { rateText, shuttle, shuttleKey, type ShuttleKey } from './shuttle';
import { Latest } from './scrub';
import { agoText, createGuess, createTimeline, moveRange, stepTick, clampTick, type Range } from './timeline';
import { createLoader, type Loader } from './ui/loader';
import { createPicker } from './ui/picker';
import { createShell, type Shell } from './ui/shell';
import { createStatsPanel, type StatsPanel } from './ui/stats';
import { createStats, type CityStats } from './stats';
import { createSound } from './ui/sound';
import { createSoundscape } from './soundscape';
import { intoThePast, startsRewind, whooshDue } from './soundscape-mix';
import { createStatus, type Status } from './ui/status';
import { createBuildBar } from './ui/build-bar';
import { Placement, type CommandLink } from './placement';
import { createPlacementView } from './placement-view';
import { note, toast } from './ui/toast';
import { goalsView, readChapter, type Chapter } from './goals';
import { councilView, fitCouncil, renderCouncil, TALL_SCREEN, type CouncilEvent } from './council';
import { policyRows, USUAL_POLICY, type PolicyEvent } from './policy';
import { money } from './money';
import { displayName } from './registry';
import { Traffic } from './traffic';
import { sample, type Path } from './capture';

declare global {
  interface Window {
    /** True once the first frame is drawn with every model loaded. */
    __ready?: boolean;
    /** The camera, for the CI checks and the console. */
    __camera?: CameraRig;
    /** Tier history and GPU memory per tier, for the CI step-down check. Only set under ?slow or ?hud. */
    /** The live city's state, for the CI check and for looking at it from the console. */
    __live?: {
      tick: number;
      speed: number;
      voyages: number;
      /** Trips from the log that matched no route of their resident; zero when the sim and this page agree. */
      unplaced: number;
      /** Cars and walkers drawn now, and voyages left undrawn by the tier's cap. */
      movers: number;
      capped: number;
      /** Frames a second, smoothed. */
      fps: number;
      /** Where each car and walker drawn now stands, in tiles from the middle of the map. */
      where(): { resident: number; car: boolean; x: number; z: number; heading: number }[];
      /** Put the camera low beside the first car drawn. */
      closeUp(): boolean;
    };
    /** The city stats for the state and tick on screen, as the panel shows them. */
    __stats?: () => CityStats | null;
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
      /** Draw the city at `tick`; resolves after the first frame that shows it, or with `draw` false as soon as it is on screen. */
      seek(
        tick: number,
        draw?: boolean,
      ): Promise<{
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
        /** The ms until the first frame is drawn with every car and walker of the moment placed. */
        settledMs: number;
        reads: number;
        stats: { readMs: number; slowestMs: number; pageSize: number };
      }>;
      /** The state the live connection feeds: its districts' ticks and buildings. */
      live(): { ticks: number[]; buildings: number; sig: string };
      /** The state on screen: its folded ticks, building count and signature, the tick held in the past or null, and whether it is the live one. */
      shown(): { ticks: number[]; buildings: number; sig: string; past: number | null; live: boolean };
      /** Whether the playback session is open ahead of a Play, and a way to close it as idleness would. */
      warm(): boolean;
      closeWarm(): void;
      /** Whether the history sessions have been asked for. */
      historyOpen(): boolean;
      /** Read the span the timeline covers now. */
      refresh(): Promise<void>;
      /** Hold each scrub seek this many ms before it is shown; 0 for none. */
      holdSeeks(ms: number): void;
      /** Play or pause from the past on screen; false when there is nothing to play. */
      play(): Promise<boolean>;
      /** Press J, K or L from the past on screen; false when there is nothing to play. */
      shuttle(key: 'j' | 'k' | 'l'): Promise<boolean>;
      /** The playback behind the past on screen: where it started, every record it applied, and the tick it joined live at. */
      playback(): {
        playing: boolean;
        /** Multiples of the city's speed, negative while rewinding. */
        rate: number | null;
        catchingUp: boolean;
        head: number | null;
        started: number | null;
        joined: number | null;
        /** Whether the playback has its session; the tick drawn, which can run ahead of the head before it. */
        attached: boolean;
        /** performance.now() when the playback began, got its session and first applied a record. */
        marks: { began: number; attached: number | null; applied: number | null } | null;
        shown: number | null;
        /** The live tip when it joined. */
        tipAtJoin: number | null;
        /** The live tip now, and the records queued ahead of the playhead per district. */
        tail: number | null;
        queued: number[];
        applied: [number, number, string][];
      };
    };
    /** Frame-by-frame drawing for the clip job; only under ?capture&trace. */
    __capture?: {
      /** The city's side in tiles. */
      tiles: number;
      /** Where the camera stands and looks and how far the tick runs, by video time in ms. */
      setPath(path: Path): void;
      /** The newest tick the live city has reached, however far the clip has drawn. */
      latest(): number;
      /** Draw the frame at video time `tMs` and say what is in it. */
      frame(tMs: number): Promise<CaptureFrame>;
    };
    /** The building tools, for the CI checks and the console: what is held, what the pointer would do, and where lots are on screen. */
    __build?: {
      state(): {
        tool: string | null;
        kind: number;
        /** Why the tools cannot be used now, or null. */
        unavailable: string | null;
        /** The lot under the pointer and whether the tool would take it. */
        preview: { lot: number; ok: boolean; why: string | null } | null;
        /** What the road tool would do where it points, and its first end once picked. */
        road: {
          kind: string;
          a: number | null;
          b: number | null;
          segment: number | null;
          ok: boolean;
          why: string | null;
        } | null;
        roadStart: number | null;
        /** Commands sent and not yet answered, and what the panel says. */
        pending: number;
        /** Commands answered so far, by the city or by the page turning one away, and commands sent. */
        answered: number;
        sent: number;
        status: string;
      };
      /** The lots set aside for builders. */
      development(): number[];
      /** The kind standing on a lot in the live city, or null. */
      kindOn(lot: number): number | null;
      /** Where a lot's middle is on the canvas, or null when it is out of view. */
      screenOf(lot: number): { x: number; y: number } | null;
      /** Put the camera over a lot. */
      focus(lot: number): void;
      /** Every road a builder added in the live city, live or taken away. */
      roads(): { segment: number; a: number; b: number; removed: boolean }[];
      /** The road tiles drawn now, as `[x, z]`. */
      drawnRoads(): [number, number][];
      /** A node's map tile, and where it is on the canvas, or null when it is out of view. */
      node(node: number): [number, number] | null;
      screenOfNode(node: number): { x: number; y: number } | null;
      screenOfTile(x: number, z: number): { x: number; y: number } | null;
      /** Put the camera over a map tile. */
      focusTile(x: number, z: number): void;
    };
    /** Following a resident, for the CI checks and the console; absent where there is no city. */
    __following?: {
      /** The resident followed, or null. */
      resident(): number | null;
      start(resident: number): boolean;
      stop(): void;
      /** Where a car or walker drawn now is on the screen, in CSS pixels, or null when it is not drawn. */
      screenOf(resident: number): { x: number; y: number } | null;
    };
    /** The follow card's list of a day, for the CI checks: draw a view on the card and hear which row was chosen. */
    __day?: { show(view: DayView | null): void; onPick: ((index: number) => void) | null };
    /** The settings sheet, key list and first-visit tip, for the CI check and the console; null when the overlay is off. */
    __ui?: Shell;
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
  status: Status,
  loader: Loader,
  trace: boolean,
): Promise<{ state: CityState; link: Link; commands: CommandLink } | null> {
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
  onOldLog(() => {
    const notice = document.getElementById('notice')!;
    notice.textContent =
      'This city’s log was written before the compact tick layout and can’t be read. Start a fresh city.';
    notice.classList.remove('hidden');
  });
  const live = await connectLive({
    url,
    oidc,
    city: name,
    state,
    onDistrict: (d) => loader.ready(d),
    onCities: (cities) => picker.update(cities),
    onRefused: () => status.refused(),
    onStatus: (connection) => {
      link.down = connection !== 'live';
      status.link(link.down);
    },
  });
  // Closing the sockets by hand, not leaving it to the browser, so the gateway sees the city's subscriptions end.
  addEventListener('pagehide', () => live.close());
  // A page restored from the back-forward cache has closed sockets and a stale city; a fresh load is the way back.
  addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
  return live.refused ? null : { state, link, commands: live.commands };
}

/** Where the gateway is and how to sign in to it, or `null` when nothing here answers like one. */
async function reach(gateway: string | null) {
  const url = gateway ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const oidc = await fetchOidc(gateway ? url.replace(/^ws/, 'http').replace(/\/ws$/, '/') : location.origin + '/');
  return oidc ? { url, oidc } : null;
}

/**
 * A history reader on connections of its own, so a seek never waits behind the live subscriptions. The sessions are
 * opened by the first seek and closed after a while idle, so a page not seeking holds none of the gateway's
 * per-person sessions. `null` when nothing here answers like a gateway.
 */
async function openHistory(name: string, districts: number, gateway: string | null): Promise<Seeker | null> {
  const reached = await reach(gateway);
  if (!reached) return null;
  const { url, oidc } = reached;
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

/** How far from the middle of the view, in pixels, `F` looks for someone to follow. */
const KEY_PICK_PX = 160;

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
    cam,
    follow: followParam,
    attract: attractSeconds,
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
  // The capture job needs the page as it draws, with nothing to dismiss, so it gets no controls and no tip.
  const stats: StatsPanel | null =
    ui && !capture && layout === 'city' ? createStatsPanel(() => shell?.isOpen ?? false) : null;
  const shell: Shell | null = stats ? createShell(quality, stats) : null;
  // The sound has no audio context until its button is first used, and none at all without the button.
  const soundscape = createSoundscape();
  const sound = shell
    ? createSound(
        soundscape,
        shell.tools,
        // The message would wait unseen under photo mode and show up after it.
        (text) => document.body.classList.contains(PHOTO_CLASS) || note(text),
        () => shell.isOpen,
      )
    : null;
  let lastWhoosh: number | null = null;
  /** The rewind sweep, at most once in a while however often a rewind is asked for. */
  const whoosh = () => {
    const now = performance.now();
    if (!soundscape.on || !whooshDue(lastWhoosh, now)) return;
    lastWhoosh = now;
    sound?.whoosh();
  };

  const renderer = createRenderer(quality.tier);
  let city: City | null = null;
  /** The chapter this city plays, if its seed names one. */
  let chapter: Chapter | null = null;
  let state: CityState | null = null;
  let link: Link = { down: false };
  /** How commands leave the page, once the live connection exists. */
  let commands: CommandLink | null = null;
  /** The tick the city is held at when it was opened in the past, with no live connection. */
  let pastTick: number | null = null;
  let seekDone = 0;
  let seekInfo: NonNullable<Window['__seek']> | null = null;
  /** The test hooks on `window` are for the CI checks and the console: they are installed under ?trace and in dev builds. */
  const hooks = trace || import.meta.env.DEV;
  if (hooks && shell) window.__ui = shell;
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
  /** Shows the city at a tick as the timeline would, once it can seek; null before that and on a page with no history. */
  let seekTo: ((tick: number) => void) | null = null;
  /** Keeps the building tools in step with the pointer and the page; set when there are tools. */
  let placementFrame: (() => void) | null = null;
  /** Whether a building tool is in hand, when a click on the city is the tool's and not a follow's. */
  let toolHeld: () => boolean = () => false;
  /** Resolves when no scrub seek is waiting or running; the clip job draws a frame only after it. */
  let scrubSettled: () => Promise<void> = async () => {};
  /** Moves a playback on and says which tick it draws, or null when nothing is playing. */
  let playFrame: ((dt: number) => number | null) | null = null;
  /** Called after each timer step of a playback, to notice its failure or its arrival at the tip. */
  let playbackTimer: (() => void) | null = null;
  /** Told the frame after the city changed has been drawn. */
  const frameWaiters: (() => void)[] = [];
  const status = createStatus();
  if (layout === 'city') {
    await init();
    city = parseCity(generate(seed, districts));
    chapter = readChapter(chapterJson(seed));
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
      seekInfo = {
        tick: past.result.tick,
        seekMs: past.seekMs,
        drawMs: null,
        reads: (await seeker())!.stats.reads,
        ticks: [...past.state.ticks],
      };
      if (hooks) window.__seek = seekInfo;
      shownResult = past.result;
      if (!past.result.exact) note('That exact moment is missing; showing the closest one before it.');
    } else if (wantLive) {
      hasLive = true;
      const joined = await follow(city, new Metro(seed, districts), seed, districts, gateway, status, loader, trace);
      state = joined?.state ?? null;
      link = joined?.link ?? link;
      commands = joined?.commands ?? null;
      if (!joined) for (let d = 0; d < districts * districts; d++) loader.ready(d);
    }
  }
  const span = city ? Math.max(1, city.tiles / 17) : 1;
  const { camera, controls } = city
    ? createCamera(renderer.domElement, span * 1.2, new THREE.Vector3(), cityBounds(city.tiles))
    : createCamera(renderer.domElement);
  if (hooks) window.__camera = controls;
  // A shared view replaces the opening drift.
  const sharedView = cam !== null && controls.setState(cam, { ease: false });
  const drawn: ReadonlyMap<number, Building> = new Map(state?.built);
  /** The city's residents as core describes them, made when first asked: a page with no log and no follow never builds it. */
  let residentsMetro: Metro | null = null;
  const residents = () => (residentsMetro ??= new Metro(seed, districts));
  const {
    scene,
    construction,
    ambient,
    cars,
    people,
    glows,
    setTime,
    setShadows,
    fleet,
    pick,
    setLot,
    setRoads,
    lots,
    previewBuilding,
  } = await createCity(renderer, quality.tier, city, state !== null, drawn);
  const hud = showHud ? createHud(renderer, quality) : null;

  // A tier change rebuilds the post chain; shadows and resolution follow the same settings.
  apply = (tier) => {
    shell?.refresh();
    const s = settingsFor(tier);
    post?.dispose();
    renderer.setPixelRatio(Math.min(devicePixelRatio, s.pixelRatioCap));
    setShadows(s.shadows, s.shadowMapSize);
    construction.setEffects(tier !== 'low');
    ambient?.setTier(s.ambient);
    if (traffic) traffic.cap = s.movers;
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
  /** Core's city with the roads drawn now, for their tiles and for the road tool's checks. */
  const roadMetro = city && state ? new Metro(seed, districts) : null;
  const roadsOnScreen = roadMetro ? new RoadsOnScreen(roadMetro, city!.roads, setRoads) : null;
  /** Draw the roads of `s` in place of those on screen: a road laid, taken away, or a rewind past one. */
  const showRoads = (s: CityState) => void roadsOnScreen?.show(s);
  /** The state the live connection feeds, which keeps taking records while the page is held in the past. */
  const liveState = state;
  const traffic = state && fleet ? new Traffic(fleet, city ? (city.tiles - 1) / 2 : 0, city?.lots ?? []) : null;
  if (traffic) traffic.cap = settingsFor(quality.tier).movers;
  if (traffic && ambient) traffic.extras = (f) => ambient.place(f);
  if (state && traffic) {
    // The sun follows the tick the page draws, so the slider is only a readout.
    slider.disabled = true;
    document.getElementById('timeline')!.dataset.live = '';
    state.onLot = showLot;
    for (const [lot, b] of state.changesSince(drawn)) showLot(lot, b);
    const first = state;
    showRoads(first);
    first.onRoads = () => showRoads(first);
    state.onVoyageEnd = (v) => traffic.release(v);
    hour = cityTime(Math.max(0, state.latest - 1)).hour;
  }
  // The tick on screen, as the numbers of the stats panel are read for: null before the first frame has one.
  const readStats = city ? createStats(city) : null;
  const statsNow = (): CityStats | null => {
    if (!readStats) return null;
    const tick = liveInfo?.tick;
    const folded = state && tick !== undefined && !Number.isNaN(tick);
    return readStats(folded ? state : null, folded ? Math.floor(tick) : 0);
  };
  let statsAt = 0;
  // Drawn at once when switched on, so the panel is never up empty while a slow first frame is awaited.
  const showStats = () => {
    const read = statsNow();
    if (read) stats?.show(read);
  };
  stats?.onChange((on) => {
    statsAt = 0;
    if (on) showStats();
  });
  if (hooks) window.__stats = statsNow;
  hour = frozenHour ?? (state ? hour : parseFloat(slider.value));
  slider.value = String(hour);
  slider.addEventListener('input', () => {
    hour = parseFloat(slider.value);
    soundscape.setHour(hour);
    setTime(hour, post!.bloom);
  });
  post = createPost(renderer, scene, camera, passesFor(quality.tier), glows);
  setTime(hour, post.bloom);
  soundscape.setHour(hour);

  addEventListener('visibilitychange', () => quality.restartWindow());

  // Memory is read once per tier, after that tier has rendered, so freed passes show up as lower counts.
  const memory: NonNullable<Window['__quality']>['memory'] = [];
  if (slow || showHud) window.__quality = { history: quality.history, memory };

  const clock = new THREE.Clock();
  let last = performance.now();
  let smoothed = 60;
  let shownHour = NaN;
  const day = document.getElementById('day')!;
  const fundsChip = document.getElementById('funds-chip')!;
  const fundsText = document.getElementById('funds')!;
  let fundsShown: number | null = null;
  const councilChip = document.getElementById('council-chip')!;
  let councilShown: CouncilEvent | null = null;
  let policyShown: PolicyEvent | null = null;
  let councilFunds: number | null = null;
  let liveInfo: NonNullable<Window['__live']> | null = null;
  if (state && traffic) {
    liveInfo = {
      tick: NaN,
      speed: state.speed,
      voyages: 0,
      unplaced: 0,
      movers: 0,
      capped: 0,
      fps: 0,
      where: () => traffic.where(),
      closeUp() {
        const car = traffic.where().find((w) => w.car);
        if (!car) return false;
        controls.moveTo(car, 1.6, Math.PI / 4, 1.29, { ease: false });
        return true;
      },
    };
    if (hooks) window.__live = liveInfo;
  }
  if (state && traffic && city) {
    const metro = residents();
    const summary = (s: CityState) => ({ ticks: [...s.ticks], buildings: s.built.size, sig: signature(s.built) });
    /** Draw `next` in place of the state on screen, which is let go; the live one keeps filling in the background. */
    const swap = (next: CityState, tick: number | null) => {
      const old = state!;
      if (old !== liveState) old.retire(Infinity);
      else for (const v of old.active()) traffic.release(v);
      old.onLot = null;
      old.onRoads = null;
      old.onVoyageEnd = null;
      for (const [lot, b] of next.changesSince(shown)) showLot(lot, b);
      next.onLot = showLot;
      // A state folded afresh from a keyframe has the roads of its tick, so a rewind takes away a road laid after it.
      showRoads(next);
      next.onRoads = () => showRoads(next);
      next.onVoyageEnd = (v) => traffic.release(v);
      state = next;
      pastTick = tick;
    };

    /** The past state on screen being played forward, or null. */
    let playback: Playback | null = null;
    /** Bumped when playback ends or the page leaves the past, so a start still opening its session can tell. */
    let playMark = 0;
    let opening = false;
    const replay: {
      started: number | null;
      joined: number | null;
      tip: number | null;
      applied: [number, number, string][];
    } = {
      started: null,
      joined: null,
      tip: null,
      applied: [],
    };
    // The playback's own session is closed by hand, so the gateway sees its subscriptions end.
    addEventListener('pagehide', () => {
      playMark++;
      playback?.close();
      playback = null;
    });
    /** The seek a stopped playback started from, to give back if the scrub that stopped it comes to nothing. */
    let resumeFrom: SeekResult | null = null;
    const stopPlayback = () => {
      playMark++;
      if (!playback) return;
      playback.close();
      playback = null;
      // The state is further on than the seek that made it.
      resumeFrom = shownResult;
      shownResult = null;
    };
    /** A scrub that ended without drawing anything leaves the past on screen: let Play start from it again. */
    const keepPlayable = () => {
      if (shownResult === null && !playback && pastTick !== null) shownResult = resumeFrom;
      resumeFrom = null;
    };
    /** A session opened ahead for playback, so Back to live does not wait to connect. */
    let warm: Gateway | null = null;
    let warming: Promise<Gateway | null> | null = null;
    let warmIdle: ReturnType<typeof setTimeout> | null = null;
    const connectPlayback = async (): Promise<Gateway | null> => {
      const reached = await reach(gateway);
      if (!reached) return null;
      return Gateway.connect(reached.url, seed, await signIn(reached.oidc));
    };
    const dropWarm = () => {
      if (warmIdle) clearTimeout(warmIdle);
      warmIdle = null;
      warm?.close();
      warm = null;
    };
    /** Open the playback session while the past is on screen. It stays for as long as the past does. */
    const prewarm = () => {
      if (warmIdle) clearTimeout(warmIdle);
      warmIdle = null;
      if (!hasLive || warming || playback || warm?.alive) return;
      warm = null;
      warming = connectPlayback()
        .catch(() => null)
        .then((s) => {
          warming = null;
          if (!s) return null;
          if (pastTick === null) {
            s.close();
            return null;
          }
          warm = s;
          return s;
        });
    };
    /** Back on the live city, the session is let go after the history sessions' idle time. */
    const releaseWarm = () => {
      if (warmIdle || !warm) return;
      warmIdle = setTimeout(dropWarm, IDLE_MS);
    };
    addEventListener('pagehide', dropWarm);
    /** The warm session if there is one, else a new one; null when nothing answers. */
    const takeSession = async (): Promise<Gateway | null> => {
      if (warm?.alive) {
        const s = warm;
        warm = null;
        return s;
      }
      warm = null;
      if (warming) {
        const s = await warming;
        if (s && warm === s) {
          warm = null;
          return s;
        }
      }
      return connectPlayback();
    };
    /** Begin a playback of `target` from `from`; with no `session` yet it races on until {@link attachSession}. */
    let held: Gateway | null = null;
    const startPlayback = (target: CityState, from: SeekResult, session: Gateway | null): Playback => {
      if (hooks) {
        replay.started = from.tick;
        replay.joined = null;
        replay.tip = null;
        replay.applied = [];
        target.onRecord = (d, t, r) => replay.applied.push([d, t, r]);
      }
      held = session;
      const p = new Playback(session, target, from, {
        tail: () => liveState!.latest,
        onFail: (err) => console.warn('playback could not go on', err),
        fresh: () => new CityState(city!, metro, districts * districts),
        onState: (next, seek) => {
          next.onRecord = state!.onRecord;
          swap(next, seek.tick);
          // Space after a failed scrub starts from the state on screen, not from the seek it began at.
          shownResult = seek;
        },
        hourAt: async (tick, signal) => {
          const s = await seeker();
          if (!s) throw new Error('nothing here answers like a gateway');
          return s.peek(tick, { signal });
        },
        oldest: () => range?.oldest ?? 0,
        onEdge: () => note('That is as far back as the city goes.'),
        release: () => {
          held?.close();
          held = null;
        },
      });
      playback = p;
      // A captured clip steps the playback itself, one frame at a time, so wall-clock time cannot make it jump.
      if (!capture) p.run(() => playbackTimer?.());
      return p;
    };
    /** Play from the past on screen; null when it cannot be, or when the page moved on while the session opened. */
    const openPlayback = async (): Promise<Playback | null> => {
      if (playback) return playback;
      const from = shownResult;
      if (!hasLive || !from || pastTick === null || opening) return null;
      const mark = playMark;
      const target = state!;
      opening = true;
      let session: Gateway | null = null;
      try {
        session = await takeSession();
        if (!session || mark !== playMark || state !== target) return null;
        const opened = session;
        session = null;
        return startPlayback(target, from, opened);
      } catch (err) {
        console.warn('the city could not be played from there', err);
        return null;
      } finally {
        session?.close();
        opening = false;
      }
    };
    /** How long a race to live waits for its session before the live city is shown instead. */
    const RACE_OPEN_MS = 1500;
    /** Race to live with no session open yet: the tick drawn runs on, and the records follow once one is. */
    const raceUnattached = (from: SeekResult) => {
      const p = startPlayback(state!, from, null);
      p.catchUp();
      const timer = setTimeout(() => {
        if (playback === p && !p.attached) snapLive();
      }, RACE_OPEN_MS);
      const attach = (s: Gateway | null) => {
        clearTimeout(timer);
        if (playback !== p || !s) {
          s?.close();
          if (playback === p) snapLive();
          return;
        }
        held = s;
        p.attach(s);
      };
      takeSession().then(attach, () => attach(null));
    };
    /** Show the live city at once, in place of the past. */
    const snapLive = () => {
      cancelAhead();
      stopPlayback();
      resumeFrom = null;
      swap(liveState!, null);
      shownResult = null;
      releaseWarm();
    };
    /** Whether Space or Play has anything to do: not while racing to live, when no control is shown. */
    const canToggle = () => hasLive && pastTick !== null && scrubTarget === null && !playback?.catchingUp;
    const togglePlay = async (): Promise<boolean> => {
      if (!canToggle()) return false;
      if (playback) {
        playback.paused = !playback.paused;
        if (playback.paused) readAhead();
        return true;
      }
      const p = await openPlayback();
      if (!p) return false;
      p.paused = false;
      return true;
    };

    /**
     * Apply a J, K or L press from the past on screen: a playback is opened if there is none, and its rate and direction
     * follow the key. Rewinding does not need records from the session, but going forward again does.
     */
    const shuttleBy = async (key: ShuttleKey, quiet = false): Promise<boolean> => {
      if (!canToggle()) return false;
      let p = playback;
      if (!p) {
        p = await openPlayback();
        if (!p) return false;
        // The past on screen was paused before there was a playback to say so.
        p.paused = true;
      }
      const next = shuttle({ rate: p.rate, paused: p.paused }, key);
      if (!quiet && startsRewind(p, next)) whoosh();
      p.rate = next.rate;
      p.paused = next.paused;
      if (next.paused) readAhead();
      return true;
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
    /** A scrub into the past is waiting to be shown, and then plays the whoosh. */
    let whooshOnShown = false;
    /** The drag in progress has already asked for its whoosh. */
    let dragWhooshed = false;
    const goLive = () => {
      whooshOnShown = false;
      scrubLatest.cancel();
      scrubTarget = null;
      if (!hasLive) {
        // Nothing live feeds a page opened at a moment; opening it again without one is the way back.
        const url = new URL(location.href);
        url.searchParams.delete('at');
        url.searchParams.delete('cam');
        location.assign(url);
        return;
      }
      // A seek still running was dropped above; with nothing past drawn there is nothing to swap back.
      if (pastTick === null) return;
      if (playback?.catchingUp) return;
      // Within a second of the tip there is nothing worth racing.
      const from = playback?.head ?? pastTick;
      if (liveState!.latest - from <= Math.max(LIVE_SNAP_TICKS, liveState!.speed)) return snapLive();
      // The city races forward from where it is, then joins the live one; with no way to play it, it shows at once.
      if (playback) return playback.catchUp();
      if (!opening && shownResult) return raceUnattached(shownResult);
      const mark = playMark;
      void openPlayback().then((p) => {
        if (mark !== playMark) return;
        if (p) p.catchUp();
        else if (!opening && !playback && pastTick !== null) snapLive();
      });
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
      prewarm();
      readAhead();
    };
    /** Once the past has rested on screen, the hours either side are read into the seeker's cache. */
    let ahead: { timer: ReturnType<typeof setTimeout>; stop: AbortController } | null = null;
    const AHEAD_MS = 400;
    const cancelAhead = () => {
      if (!ahead) return;
      clearTimeout(ahead.timer);
      ahead.stop.abort();
      ahead = null;
    };
    const readAhead = () => {
      cancelAhead();
      const stop = new AbortController();
      const timer = setTimeout(async () => {
        const s = opened;
        if (!s || pastTick === null || scrubTarget !== null || !range) return;
        for (const tick of neighbours(pastTick, range.oldest, tipTick())) {
          if (stop.signal.aborted || pastTick === null) return;
          await s.prefetch(tick, stop.signal);
        }
      }, AHEAD_MS);
      ahead = { timer, stop };
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
        const result = await s.seekOrNewest(tick);
        if (holdSeeks > 0) await new Promise((done) => setTimeout(done, holdSeeks));
        // Back to live came while this seek ran: what it found is no longer wanted.
        if (!current()) return keepPlayable();
        try {
          place(result);
          resumeFrom = null;
          if (whooshOnShown) whoosh();
          whooshOnShown = false;
        } catch (err) {
          // The state on screen may be half drawn; the next seek starts from a fresh one.
          shownResult = null;
          resumeFrom = null;
          throw err;
        }
      } catch (err) {
        whooshOnShown = false;
        if (!current()) return keepPlayable();
        keepPlayable();
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
    const go = (tick: number, moving: boolean, repeat = false) => {
      if (!range) return;
      // A drag is judged against the bar it began on, so releasing at its right end goes live however far the tip moved.
      const bounds = moveRange(bar.held, range, tipTick());
      const tip = bounds.newest;
      const to = clampTick(bounds, tick);
      // The tip is the live city: a step or a release within a city minute of it is going back to it.
      if (hasLive && !moving && to >= tip - LIVE_SNAP_TICKS) return goLive();
      // The whoosh waits for the seek to show something, so a seek that fails is silent. A drag or a held key makes one.
      if (intoThePast(handleAt(), to) && !repeat && !(moving && dragWhooshed)) {
        whooshOnShown = true;
        dragWhooshed = moving;
      }
      stopPlayback();
      cancelAhead();
      scrubTarget = to;
      preview(to);
      scrubLatest.want(to, moving);
    };
    seekTo = (tick) => {
      void (async () => {
        if (!range) await refreshRange();
        if (!range) return note('The timeline is not available yet. Try again in a moment.');
        // An entry from before the oldest moment the log keeps goes to that oldest moment, which the person should be told.
        if (tick < range.oldest) note('That moment is no longer kept. Showing the oldest one.');
        go(tick, false);
      })();
    };
    const rewindFromLive = async () => {
      if (!hasLive || scrubTarget !== null) return;
      if (!range) await refreshRange();
      if (!range || pastTick !== null) return;
      go(stepTick({ oldest: range.oldest, newest: tipTick() }, handleAt(), -1, false), false);
      // A drag or another step since stops playbacks, which moves the mark; then the rewind is no longer wanted.
      const mark = playMark;
      await scrubLatest.settled();
      if (mark === playMark && scrubTarget === null && pastTick !== null) await shuttleBy('j', true);
    };
    let refresher: ReturnType<typeof setInterval> | null = null;
    const bar = createTimeline(document.getElementById('scrub')!, {
      onMove: (tick, phase) => {
        go(tick, phase === 'drag');
        if (phase !== 'drag') dragWhooshed = false;
      },
      onStep: (direction, big, repeat) => {
        if (range) go(stepTick({ oldest: range.oldest, newest: tipTick() }, handleAt(), direction, big), false, repeat);
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
    status.onBackToLive(goLive);
    status.onPlay(() => void togglePlay());
    addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (!isPlayKey(e, target, shell?.isOpen ?? false) || !canToggle()) return;
      e.preventDefault();
      void togglePlay();
    });
    addEventListener('keydown', (e) => {
      const key = shuttleKey(e);
      if (!key || e.repeat || (shell?.isOpen ?? false)) return;
      if (pastTick === null) {
        // J from the live city steps back and starts rewinding from there.
        if (key !== 'j') return;
        e.preventDefault();
        void rewindFromLive();
        return;
      }
      if (!canToggle()) return;
      e.preventDefault();
      void shuttleBy(key);
    });
    let barShown = false;
    const guess = createGuess();
    timelineFrame = (tick) => {
      const tip = tipTick();
      // Until the span is read the bar has just the live tip.
      const usable = range === null ? hasLive && tip >= 0 : tip > range.oldest;
      if (usable !== barShown) {
        barShown = usable;
        bar.show(usable);
        timelineEl.toggleAttribute('data-scrub', usable);
        // A first visit gets one tip, once there is a timeline to drag.
        if (hintDue(usable, pastTick !== null || scrubTarget !== null)) shell?.offerHint();
      }
      const inPast = pastTick !== null || scrubTarget !== null;
      syncRefresh(bar.dragging || inPast);
      const at = Math.min(scrubTarget ?? pastTick ?? tick, tip);
      if (usable)
        bar.update({
          ready: range !== null,
          oldest: range ? range.oldest : guess.oldest(tip),
          newest: tip,
          at,
          live: !inPast,
        });
      status.past(inPast);
      if (inPast) {
        status.playLabel(playback && !playback.paused ? 'Pause' : 'Play');
        status.playHidden(!hasLive || (playback?.catchingUp ?? false));
        status.ago(usable ? agoText(tip - at) : 'Earlier');
        // Plain 1x forward is what Play already says; any other pace or direction is named.
        status.rate(playback && !playback.paused && playback.rate !== 1 ? rateText(playback.rate) : '');
      }
    };
    /** Notice a failure or the tip after the playback moved on; the tick to draw, or null when nothing is playing. */
    const checkPlayback = (): number | null => {
      const p = playback;
      if (!p) return null;
      if (p.failure || state !== p.state) {
        if (p.failure)
          note(p.restarted ? 'The city restarted. Showing it live.' : 'Playback stopped. Showing the city live.');
        snapLive();
        return null;
      }
      if (p.atTip) {
        // The live clock carries on from the tick drawn, so the cars under way do not jump.
        handOver(p, clockTicks);
        replay.joined = Math.floor(p.head);
        replay.tip = liveState!.latest;
        snapLive();
        return null;
      }
      pastTick = Math.floor(p.shown);
      return p.shown;
    };
    // Frames only draw the playback's state; the timer in startPlayback moves it on, so a slow renderer does not slow it.
    playFrame = (dt) => {
      if (capture) {
        if (captureDt > 0) playback?.advance(captureDt);
        captureDt = 0;
      } else if (dt > 0) playback?.step();
      return checkPlayback();
    };
    playbackTimer = checkPlayback;
    // A page opened in the past already has its history open, and no live tip to show the bar with.
    if (!hasLive) {
      void (async () => {
        await new Promise<void>((done) => frameWaiters.push(done));
        void refreshRange();
      })();
    }
    const metroHooks: NonNullable<Window['__metro']> = {
      async prepare() {
        await (await seeker())?.warm();
      },
      async seek(tick, draw = true) {
        const started = performance.now();
        stopPlayback();
        try {
          const opened = await seeker();
          if (!opened) throw new Error('nothing here answers like a gateway');
          const result = await opened.seek(tick);
          const next = new CityState(city!, metro, districts * districts);
          fold(next, result);
          const seekMs = performance.now() - started;
          swap(next, result.tick);
          shownResult = result;
          prewarm();
          if (!result.exact) note('That exact moment is missing; showing the closest one before it.');
          const report = (drawnMs: number) => ({
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
          });
          if (!draw) return report(seekMs);
          await new Promise<void>((done) => frameWaiters.push(done));
          const drawnMs = performance.now() - started;
          return report(drawnMs);
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) note(whyNot(err));
          if (err instanceof GatewayError && err.code === 'closed') dropHistory();
          throw err;
        }
      },
      live: () => summary(liveState!),
      shown: () => ({ ...summary(state!), past: pastTick, live: state === liveState, speed: state!.speed }),
      historyOpen: () => history !== null,
      refresh: refreshRange,
      holdSeeks: (ms) => {
        holdSeeks = ms;
      },
      play: () => togglePlay(),
      shuttle: (key) => shuttleBy(key),
      warm: () => warm?.alive === true,
      closeWarm: dropWarm,
      playback: () => ({
        playing: playback !== null && !playback.paused,
        rate: playback?.rate ?? null,
        catchingUp: playback?.catchingUp ?? false,
        head: playback?.head ?? null,
        started: replay.started,
        joined: replay.joined,
        tipAtJoin: replay.tip,
        attached: playback?.attached ?? false,
        marks: playback?.marks ?? null,
        shown: playback?.shown ?? null,
        tail: liveState?.latest ?? null,
        queued: playback?.queued ?? [],
        applied: replay.applied,
      }),
    };
    if (hooks) window.__metro = metroHooks;
  }
  if (shell && city && layout === 'city') {
    const lotsOf = city.lots;
    const placement = new Placement({
      ground: () => ({ city: city!, built: liveState?.built ?? new Map(), roads: liveState?.roads }),
      link: commands,
      // The live city is on screen only when the page is not in, or going to, an earlier moment.
      atTip: () => liveState !== null && state === liveState && pastTick === null && scrubTarget === null,
      wantsLive: wantLive,
      facing: (lot) => lotsOf[lot]?.facing ?? 0,
      roadCheck: (a, b) => {
        // The tools are only up at the live tip, where the roads drawn are the live city's.
        if (!roadMetro || !liveState || !syncRoads(roadMetro, liveState.builtRoads())) return 1;
        return roadMetro.roadCheck(a, b);
      },
    });
    toolHeld = () => placement.tool !== null;
    const bar = createBuildBar(shell.tools, placement, () => shell.isOpen);
    if (liveState) liveState.onCommand = (e) => placement.result(e.id, e.result);
    const view = liveState
      ? createPlacementView({
          dom: renderer.domElement,
          camera,
          scene,
          city,
          placement,
          ground: () => ({ city: city!, built: liveState.built, roads: liveState.roads }),
          lots,
          previewBuilding,
        })
      : null;
    placementFrame = () => {
      bar.sync();
      view?.update();
    };
    if (hooks && view) {
      window.__build = {
        state: () => {
          const preview = placement.preview();
          const road = placement.roadPreview();
          return {
            tool: placement.tool,
            kind: placement.kind,
            unavailable: placement.unavailable(),
            preview: preview && {
              lot: preview.lot,
              ok: preview.check.ok,
              why: preview.check.ok ? null : preview.check.why,
            },
            road: road && {
              kind: road.kind,
              a: road.kind === 'remove' ? null : road.a,
              b: road.kind === 'lay' ? road.b : null,
              segment: road.kind === 'remove' ? road.segment : null,
              ok: road.check.ok,
              why: road.check.ok ? null : road.check.why,
            },
            roadStart: placement.roadStart,
            pending: placement.pending,
            answered: placement.answered,
            sent: placement.sent,
            status: placement.status.state === 'idle' ? '' : placement.status.text,
          };
        },
        development: () => [...city!.development],
        kindOn: (lot) => liveState?.built.get(lot)?.kind ?? lotsOf[lot]?.kind ?? null,
        screenOf: (lot) => view.screenOf(lot),
        focus: (lot) => {
          const [x, z] = lots.centre(lot);
          controls.moveTo({ x, z }, 9, Math.PI / 4, 0.9, { ease: false });
        },
        roads: () =>
          [...(liveState?.roads ?? [])].map(([segment, r]) => ({
            segment,
            a: r.a,
            b: r.b,
            removed: r.change !== ROAD_ADDED,
          })),
        drawnRoads: () => (roadsOnScreen?.tiles ?? city!.roads).map((r) => [r.x, r.z]),
        node: (node) => city!.nodes[node] ?? null,
        screenOfNode: (node) => {
          const at = city!.nodes[node];
          return at ? view.screenOfTile(at[0], at[1]) : null;
        },
        screenOfTile: (x, z) => view.screenOfTile(x, z),
        focusTile: (x, z) => {
          const half = (city!.tiles - 1) / 2;
          controls.moveTo({ x: x - half, z: z - half }, 9, Math.PI / 4, 0.9, { ease: false });
        },
      };
    }
  }
  const dom = renderer.domElement;
  const card = shell
    ? createFollowCard(() => following?.stop(), {
        step: (delta) => dayPanel?.step(delta),
        pick: (index) => {
          window.__day?.onPick?.(index);
          dayPanel?.pick(index);
        },
      })
    : null;
  if (hooks && card) window.__day = { show: (view) => card.showDay(view), onPick: null };
  const following = city
    ? new Following({
        profile: (resident) => residents().profile(resident),
        lots: city.lots,
        half: (city.tiles - 1) / 2,
        rig: controls,
        positionOf: (voyage, tick, into) => traffic?.positionOf(voyage, tick, into) ?? null,
        pin: (resident) => {
          if (traffic) traffic.pinned = resident;
        },
        show: (view) => card?.show(view),
        onFollow: (resident) => {
          dayPanel?.follow(resident);
          if (resident === null) card?.showDay(null);
        },
      })
    : null;
  /** Listeners for the records the live city takes in, which keep a day that is still going current. */
  const recordListeners = new Set<(record: TickRecord) => void>();
  if (liveState && hasLive) liveState.onApplied = (record) => recordListeners.forEach((listener) => listener(record));
  // A resident's day is read from the log. A page with no log has no day panel to ask, so the card lists the schedule.
  const dayPanel =
    following && city && state
      ? new DayPanel({
          scan: async (from, to, visit, signal) => {
            const s = await seeker();
            if (!s) throw new Error('nothing here answers like a gateway');
            await s.scan(from, to, visit, { signal });
          },
          span: async () => (await seeker())?.retained() ?? null,
          live: (listener) => {
            recordListeners.add(listener);
            return () => recordListeners.delete(listener);
          },
          tip: () => (hasLive ? (liveState?.latest ?? null) : null),
          seek: (tick) => seekTo?.(tick),
          placeName: (lot) => city!.lots[lot]?.name ?? null,
          show: (view) => card?.showDay(view),
        })
      : null;
  /** What a follow asks each frame, made once: the trip a resident is on in the state on screen, which a seek replaces. */
  const voyageAt = (resident: number, at: number) => state?.voyageAt(resident, at);
  const noVoyage = () => undefined;
  /** Follow `resident`, or say there is no such one. */
  const startFollow = (resident: number, keepView = false): boolean => {
    const ok = following?.start(resident, keepView) ?? false;
    if (!ok) note(`There is no resident ${resident} in this city.`);
    return ok;
  };
  if (following && !capture) {
    // Moving the view lets go; turning and zooming do not, so a follow can be looked at from any side.
    controls.addEventListener('steer', () => following.stop());
    // Capture phase, to see photo mode, the sheet and the city menu before they close themselves on the same key.
    addEventListener(
      'keydown',
      (e) => {
        if (following.resident === null) return;
        const menuOpen = !document.getElementById('cities')?.classList.contains('hidden');
        if (isStopKey(e, document.body.classList.contains(PHOTO_CLASS), shell?.isOpen ?? false, menuOpen))
          following.stop();
      },
      true,
    );
    if (pick) {
      const find = (at: { x: number; y: number }, slack: number) =>
        pick(camera, at.x, at.y, { width: dom.clientWidth, height: dom.clientHeight }, slack);
      // A click needs a pointer, so F is the way from the keyboard: whoever is nearest the middle of the view.
      addEventListener('keydown', (e) => {
        if (!isFollowKey(e, e.target as HTMLElement | null, shell?.isOpen ?? false)) return;
        e.preventDefault();
        const hit = find({ x: 0, y: 0 }, KEY_PICK_PX);
        if (hit) startFollow(hit.resident);
        else note('There is nobody near the middle of the view to follow.');
      });
      bindTap(dom, {
        tap: ({ at, touch }) => {
          if (toolHeld()) return;
          const hit = find(at, touch ? 28 : 16);
          if (hit) startFollow(hit.resident);
        },
        hover: (at) => {
          if (toolHeld()) return;
          dom.style.cursor = at && find(at, 16) ? 'pointer' : '';
        },
      });
    }
    if (hooks) {
      const corner = new THREE.Vector3();
      window.__following = {
        resident: () => following.resident,
        start: (resident) => startFollow(resident),
        stop: () => following.stop(),
        screenOf(resident) {
          const at = traffic?.where().find((w) => w.resident === resident);
          if (!at) return null;
          camera.updateMatrixWorld();
          corner.set(at.x, 0.1, at.z).project(camera);
          return { x: ((corner.x + 1) / 2) * dom.clientWidth, y: ((1 - corner.y) / 2) * dom.clientHeight };
        },
      };
    }
  }
  // A link that names a resident opens with the camera on them, and keeps the view it carries.
  const followed = followParam !== null && !capture && startFollow(followParam, sharedView);
  let intro: ReturnType<typeof startIntro> | null = null;
  /** Set when attract mode is on: turns the camera a frame's worth once the page has sat untouched. */
  let turnWhenIdle: ((now: number, dt: number) => void) | null = null;
  /** The tick the clip script wants drawn, or null to let the clock steer. */
  let captureTick: number | null = null;
  /** Seconds of video the next captured frame moves a playback on; the playback's own clock is not used. */
  let captureDt = 0;
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
    if (frameMs > 0) smoothed += (1000 / frameMs - smoothed) * 0.05;
    hud?.frame(frameMs);
    if (slow) for (const end = performance.now() + slow; performance.now() < end; );
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    // The camera first, so the fleet leaves out what this frame's view cannot see.
    if (capture) camera.lookAt(controls.target);
    else {
      turnWhenIdle?.(now, Math.min(0.05, frameMs / 1000));
      controls.update();
    }
    fleet?.view(camera);
    if (state && traffic && liveInfo) {
      // The clock runs on real time even when frames are slow, so it stays with the sim.
      const played = playFrame?.(still ? 0 : frameMs / 1000) ?? null;
      const tick =
        played ??
        pastTick ??
        captureTick ??
        clockTicks.advance(Math.min(1, frameMs / 1000), state.latest, state.speed, link.down);
      if (!Number.isNaN(tick)) {
        state.retire(Math.floor(tick));
        // Ambient life follows the clock the person reads: a held hour, a scrub target, or the tick on screen.
        const ambientTick = frozenHour !== null ? frozenHour * TICKS_PER_HOUR : (scrubTarget ?? tick);
        // The vans go in the fleet's round; what hangs on buildings waits for the construction update, which says
        // which lots are going up or coming down at this tick.
        ambient?.drive(ambientTick);
        traffic.update(tick, still ? 0 : dt, state.active());
        following?.frame(tick, voyageAt);
        dayPanel?.frame(tick);
        state.settle(tick);
        construction.update(tick, state.rising, state.falling);
        ambient?.decorate(ambientTick);
        const time = cityTime(scrubTarget ?? tick);
        if (frozenHour === null && !(Math.abs(time.hour - shownHour) <= 0.004)) {
          shownHour = hour = time.hour;
          soundscape.setHour(hour);
          setTime(hour, post!.bloom);
          day.textContent = `Day ${time.day}`;
        }
        const funds = state.funds;
        if (funds !== fundsShown) {
          fundsShown = funds;
          fundsChip.classList.toggle('hidden', funds === null);
          fundsChip.classList.toggle('short', funds !== null && funds < 0);
          if (funds !== null) fundsText.textContent = money(funds);
        }
        if (state.council !== councilShown || state.policy !== policyShown || (chapter && funds !== councilFunds)) {
          councilShown = state.council;
          policyShown = state.policy;
          councilFunds = funds;
          councilChip.classList.toggle('hidden', councilShown === null);
          if (councilShown) {
            const rows = policyRows(policyShown ?? USUAL_POLICY, tick);
            renderCouncil(
              councilChip,
              councilView(councilShown, city?.shore ?? null),
              window.innerHeight >= TALL_SCREEN,
              rows,
              chapter ? goalsView(chapter, councilShown, funds) : null,
            );
          }
        }
        timelineFrame?.(tick);
        Object.assign(liveInfo, {
          tick,
          speed: state.speed,
          voyages: state.voyages.size,
          unplaced: state.unplaced,
          movers: traffic.drawn,
          capped: traffic.capped,
          fps: smoothed,
        });
      }
    }
    placementFrame?.();
    // A few times a second is plenty for numbers a person reads.
    if (stats?.on && now - statsAt >= 250) {
      statsAt = now;
      showStats();
    }
    // With no log there is no tick, only the hour on the slider, and the resident is placed by their schedule.
    if (!state) following?.frame(hour * TICKS_PER_HOUR, noVoyage);
    // A frame with no tick has no update to draw a voyage that just ended away.
    traffic?.sync();
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
      latest: () => liveState?.latest ?? NaN,
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
          base ??= path.base ?? Math.floor(liveState.latest) - 1;
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
        captureDt = dt;
        draw(performance.now(), 1000 / 30, dt, false);
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
  if (shell) {
    createPhoto(() => shell.isOpen);
    // Nothing to share where no gateway feeds the page: the link opens a past tick through it.
    if (wantLive && (hasLive || pastTick !== null))
      createShare(shell.tools, () => {
        const tick = scrubTarget ?? liveInfo?.tick;
        if (tick === undefined || Number.isNaN(tick)) return null;
        // The clock coasts past the newest record while the connection is down; the log has nothing there to open.
        return momentLink(
          location.href,
          state ? Math.min(tick, state.latest) : tick,
          controls.state(),
          following?.resident ?? null,
        );
      });
  }
  if (city && !still && !reduced && !capture && attractSeconds > 0) {
    const idle = createAttract(performance.now(), attractSeconds);
    const poke = () => idle.poke(performance.now());
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'visibilitychange'])
      addEventListener(type, poke, { passive: true });
    turnWhenIdle = (now, dt) => {
      if (!intro && idle.active(now)) controls.drift(ATTRACT_RATE * dt);
    };
  }
  if (city && !still && frozenHour === null && !reduced && !capture && !sharedView && !followed)
    intro = startIntro(camera, controls, performance.now());
  if (capture) {
    controls.enabled = false;
    window.__capture = captureApi();
    draw(performance.now(), 0, 0);
  } else frame();
  if (seekInfo) seekInfo.drawMs = performance.now() - seekDone;
  document.body.dataset.ready = '1';
  window.__ready = true;
  loader.done(state !== null && showLoader);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post!.resize();
    fitCouncil(councilChip, innerHeight >= TALL_SCREEN);
  });
}

main().catch((err) => {
  console.error('the city could not start', err);
  document.getElementById('loader')?.classList.add('hidden');
  toast('The city could not start. Reload to try again.', null);
});
