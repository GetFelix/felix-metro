// The city's ambient life: shop windows, chimney smoke, birds on roofs, traffic lights, a garbage truck and delivery vans.
// The sim logs none of it, so every function here takes the tick and the city's seed and nothing else: no wall clock and
// no Math.random. The same tick gives the same picture whether it was reached by playing, seeking or rewinding.
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';
import { unitHash } from './daylight';
import { LANE, poseBetween } from './traffic';

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** 0 before `start`, 1 after `start + fade`. */
const ramp = (hour: number, start: number, fade: number) => smooth(clamp01((hour - start) / fade));

/** A number for a seed string, so a city's ambient life is its own. */
export function seedNumber(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return h | 0;
}

/** A fixed number in [0, 1) for a seed and two integers. `a` is usually a lot, a node or a day. */
export const roll = (seed: number, a: number, b = 0) => unitHash((seed ^ Math.imul(a, 0x27d4eb2f)) | 0, b);

/** The hour of the day, 0 to 24, for a tick. */
export function hourOf(tick: number): number {
  return ((((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY) / TICKS_PER_DAY) * 24;
}

/** The day a tick falls in, counted from 0. */
export const dayOf = (tick: number) => Math.floor(tick / TICKS_PER_DAY);

const FADE = 1 / 6; // ten city minutes

// ---------- shops ----------

/**
 * How lit a shop's window is, 0 to 1. Each shop opens between 07:30 and 09:30 and closes between 18:00 and 22:00,
 * at an hour fixed by its lot.
 */
export function shopOpen(hour: number, seed: number, lot: number): number {
  const open = 7.5 + 2 * roll(seed, lot, 1);
  const close = 18 + 4 * roll(seed, lot, 2);
  return ramp(hour, open, FADE) * (1 - ramp(hour, close, FADE));
}

// ---------- chimneys ----------

/** Ticks a puff takes to rise and thin out. */
export const SMOKE_TICKS = 20;

/** How hard a stack is smoking, 0 to 1: from about 06:00 to the end of the working day, at hours fixed by the lot. */
export function smokeLevel(hour: number, seed: number, lot: number): number {
  const on = 5.5 + 1.5 * roll(seed, lot, 3);
  const off = 16.5 + 2 * roll(seed, lot, 4);
  return ramp(hour, on, 0.25) * (1 - ramp(hour, off, 0.25));
}

/** How far through its rise puff `i` of `n` is, 0 to 1, spread evenly and offset by lot so stacks do not breathe together. */
export function puffAge(tick: number, seed: number, lot: number, i: number, n: number): number {
  const a = tick / SMOKE_TICKS + i / n + roll(seed, lot, 5);
  return a - Math.floor(a);
}

// ---------- birds ----------

/** The share of roofs a flock settles on. */
export const ROOST_SHARE = 0.3;
const FLIGHT_HOURS = 0.12;

export const hasRoost = (seed: number, lot: number) => roll(seed, lot, 8) < ROOST_SHARE;

export interface Visit {
  /** The flock is on the roof or in the air over it. */
  here: boolean;
  /** 0 when the flock first appears, 1 once it has landed. */
  landing: number;
  /** 0 while it sits, 1 when it has flown off. */
  leaving: number;
}

/** A flock lands between 05:00 and 06:00 and flies off between 07:00 and 08:30; the flights take about seven minutes. */
export function birdVisit(hour: number, seed: number, lot: number): Visit {
  const arrive = 5 + roll(seed, lot, 6);
  const leave = 7 + 1.5 * roll(seed, lot, 7);
  const landing = clamp01((hour - arrive) / FLIGHT_HOURS);
  const leaving = clamp01((hour - leave) / FLIGHT_HOURS);
  return { here: hour >= arrive && leaving < 1, landing, leaving };
}

// ---------- traffic lights ----------

/** Ticks a full signal cycle takes. */
export const SIGNAL_TICKS = 32;
export type Light = 'green' | 'amber' | 'red';

/** The two roads of a crossing: one runs north to south, the other east to west. */
export interface Signal {
  ns: Light;
  ew: Light;
}

const phase = (t: number, from: number): Light => {
  const p = t - from;
  return p >= 0 && p < 13 ? 'green' : p >= 13 && p < 15 ? 'amber' : 'red';
};

/** The lights at crossing `node` at `tick`. One road is green for 13 ticks, amber for 2, and the other has its turn. */
export function signalAt(tick: number, seed: number, node: number): Signal {
  const t = (((tick + roll(seed, node, 9) * SIGNAL_TICKS) % SIGNAL_TICKS) + SIGNAL_TICKS) % SIGNAL_TICKS;
  return { ns: phase(t, 0), ew: phase(t, 16) };
}

// ---------- roads and routes ----------

/** The road tiles and which of them touch what. Tiles are numbered in the order the city lists its roads. */
export interface Roads {
  x: Int32Array;
  z: Int32Array;
  /** The tiles a road tile leads to. */
  next: number[][];
  /** The lot beside each tile that has a building to start or end a trip at, or -1. */
  door: Int32Array;
  /** The tile is on a commercial street: a shop stands beside it. */
  shopping: Uint8Array;
}

export interface RoadTile {
  x: number;
  z: number;
}
export interface LotTile {
  id: number;
  x: number;
  z: number;
  /** The lot has a building a truck or a van can start from. */
  building: boolean;
  /** The lot is a shop or an office whose street is a delivery round. */
  commercial: boolean;
}

const key = (x: number, z: number) => x * 65536 + z;
const STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function buildRoads(roads: readonly RoadTile[], lots: readonly LotTile[]): Roads {
  const index = new Map<number, number>();
  roads.forEach((r, i) => index.set(key(r.x, r.z), i));
  const at = new Map<number, LotTile>();
  for (const l of lots) at.set(key(l.x, l.z), l);
  const door = new Int32Array(roads.length).fill(-1);
  const shopping = new Uint8Array(roads.length);
  const next = roads.map((r, i) => {
    const out: number[] = [];
    for (const [dx, dz] of STEPS) {
      const j = index.get(key(r.x + dx, r.z + dz));
      if (j !== undefined) out.push(j);
      const lot = at.get(key(r.x + dx, r.z + dz));
      if (lot?.building && door[i]! < 0) door[i] = lot.id;
      if (lot?.commercial) shopping[i] = 1;
    }
    return out;
  });
  return {
    x: Int32Array.from(roads, (r) => r.x),
    z: Int32Array.from(roads, (r) => r.z),
    next,
    door,
    shopping,
  };
}

/** A drive along the roads, from a lot's door to a lot's door, with the times each tile is reached and left. */
export interface Route {
  tiles: number[];
  /** Ticks after the start at which the vehicle reaches tile `i` and sets off from it again. */
  arrive: number[];
  leave: number[];
  /** Ticks the whole drive takes. */
  total: number;
}

export interface RouteSpec {
  /** A number in [0, 1) for step `i`. */
  pick(i: number): number;
  start: number;
  steps: number;
  ticksPerTile: number;
  /** Ticks to stand at a tile reached on step `i`. */
  dwell(tile: number, i: number): number;
  /** Prefer tiles this says yes to when a junction offers a choice. */
  prefer?(tile: number): boolean;
}

/** A walk over the roads that never turns round except at a dead end. */
export function makeRoute(roads: Roads, spec: RouteSpec): Route {
  const tiles = [spec.start];
  const arrive = [0];
  const leave = [0];
  let previous = -1;
  let t = 0;
  for (let i = 1; i <= spec.steps; i++) {
    const here = tiles[tiles.length - 1]!;
    let options = roads.next[here]!.filter((j) => j !== previous);
    if (options.length === 0) options = roads.next[here]!;
    if (options.length === 0) break;
    const liked = spec.prefer ? options.filter(spec.prefer) : [];
    const from = liked.length ? liked : options;
    const to = from[Math.min(from.length - 1, Math.floor(spec.pick(i) * from.length))]!;
    previous = here;
    t = leave[leave.length - 1]! + spec.ticksPerTile;
    tiles.push(to);
    arrive.push(t);
    leave.push(t + spec.dwell(to, i));
  }
  return { tiles, arrive, leave, total: leave[leave.length - 1]! };
}

export interface Placed {
  x: number;
  z: number;
  heading: number;
  /** 1 on the road, falling to 0 as it goes into a lot. */
  size: number;
}

// Scratch for routePose, which runs for every vehicle every frame.
const FROM = [0, 0];
const TO = [0, 0];
const DOOR: RoadTile = { x: 0, z: 0 };

/** Ticks a vehicle takes to come out of or go into a lot's door. */
const DOOR_TICKS = 2;

/**
 * Where the route's vehicle is `t` ticks after it set off, in tiles from the city's north-west corner, or false before
 * and after the drive. Standing at a stop keeps the heading it arrived with.
 */
export function routePose(
  roads: Roads,
  route: Route,
  t: number,
  /** Writes where lot `id` stands into `at`, or returns false when there is no such lot. */
  lot: (id: number, at: RoadTile) => boolean,
  out: Placed,
) {
  const { tiles, arrive, leave } = route;
  if (tiles.length < 2 || !(t >= 0 && t < route.total)) return false;
  let lo = 0;
  let hi = tiles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arrive[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const a = FROM;
  const b = TO;
  const at = (j: number, to: number[]) => {
    to[0] = roads.x[tiles[j]!]!;
    to[1] = roads.z[tiles[j]!]!;
  };
  if (t < leave[i]! || i === tiles.length - 1) {
    // Standing at tile i; the heading is the one it drove in with (or out with, from the first tile).
    const j = Math.max(1, i);
    at(j - 1, a);
    at(j, b);
    poseBetween(a, b, i === 0 ? 0 : 1, LANE, 0, out);
  } else {
    at(i, a);
    at(i + 1, b);
    poseBetween(a, b, (t - leave[i]!) / (arrive[i + 1]! - leave[i]!), LANE, 0, out);
  }
  const into = Math.max(0, 1 - Math.min(t, route.total - t) / DOOR_TICKS);
  out.size = 1 - into;
  if (into > 0) {
    const end = t < route.total / 2 ? tiles[0]! : tiles[tiles.length - 1]!;
    if (lot(roads.door[end]!, DOOR)) {
      const dx = DOOR.x - out.x;
      const dz = DOOR.z - out.z;
      let turn = Math.atan2(dx, dz) - out.heading;
      turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
      out.heading += into * turn;
      out.x += into * dx;
      out.z += into * dz;
    }
  }
  return true;
}

// ---------- the truck and the vans ----------

/**
 * The model of each vehicle kind, kind `k` being entry `k - 1`. Kinds 1 to 6 are the sim's (core's `CAR_KINDS`), so
 * the van is the delivery model the sim already draws for kind 6. Only the garbage truck, kind 7, is the page's own,
 * and a kind the sim logs never reaches it.
 */
export const CAR_MODELS = ['sedan', 'taxi', 'suv', 'van', 'hatchback-sports', 'delivery', 'garbage-truck'] as const;
export const VAN_KIND = 6;
export const TRUCK_KIND = 7;
/** The most vans in a day's plan; a tier uses the first few. */
export const MAX_VANS = 6;

export interface Round {
  kind: number;
  /** The tick of the day the round begins. */
  start: number;
  route: Route;
}

const TRUCK_TICKS_PER_TILE = 4;
const VAN_TICKS_PER_TILE = 3;

/** The start tiles a vehicle can come out of: one with a lot's door beside it. */
const starts = (roads: Roads, only?: (tile: number) => boolean) => {
  const found: number[] = [];
  roads.door.forEach((d, i) => d >= 0 && (!only || only(i)) && found.push(i));
  return found;
};

/**
 * The day's rounds. The garbage truck sets off between 06:00 and 07:30 and stops every fourth tile; each van sets off
 * between 08:00 and 13:00 on a commercial street and stops at the shops it passes. All of it comes from the seed and
 * the day, so a day replays exactly.
 */
export function planDay(roads: Roads, seed: number, day: number): Round[] {
  const rounds: Round[] = [];
  const key = (n: number) => roll(seed, day, 100 + n);
  const lots = starts(roads);
  const shopStarts = starts(roads, (i) => roads.shopping[i] === 1);
  if (lots.length) {
    const start = lots[Math.floor(key(0) * lots.length)]!;
    rounds.push({
      kind: TRUCK_KIND,
      start: Math.round((6 + 1.5 * key(1)) * TICKS_PER_HOUR),
      route: makeRoute(roads, {
        pick: (i) => roll(seed, day * 1000 + i, 200),
        start,
        steps: 120,
        ticksPerTile: TRUCK_TICKS_PER_TILE,
        dwell: (_tile, i) => (i % 4 === 0 ? 4 : 0),
      }),
    });
  }
  const pool = shopStarts.length ? shopStarts : lots;
  if (!pool.length) return rounds;
  for (let v = 0; v < MAX_VANS; v++) {
    const k = (n: number) => roll(seed, day * 1000 + v * 50 + n, 300 + v);
    rounds.push({
      kind: VAN_KIND,
      start: Math.round((8 + 5 * key(10 + v)) * TICKS_PER_HOUR),
      route: makeRoute(roads, {
        pick: (i) => k(i),
        start: pool[Math.floor(key(20 + v) * pool.length)]!,
        steps: 150,
        ticksPerTile: VAN_TICKS_PER_TILE,
        dwell: (tile, i) => (roads.shopping[tile] === 1 && i % 3 === 0 ? 8 : 0),
        prefer: (tile) => roads.shopping[tile] === 1,
      }),
    });
  }
  return rounds;
}
