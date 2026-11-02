// The city as the log tells it: what each district's records add up to. Buildings are the generated city's plus the
// ones `built` and `demolished` events and keyframes change; trips are handed on to whatever draws them.
import { WINDOW, progress } from './construction';
import type { City } from './layout';

/** A building kind that means the lot is empty. */
export const NO_BUILDING = 65535;

/** What a `roadwork` event or a keyframe's road list says a builder did to a segment. */
export const ROAD_ADDED = 2;
export const ROAD_REMOVED = 3;

interface TripEvent {
  type: 'trip';
  resident: number;
  vehicle: number;
  depart: number;
  route: [number, number][];
}
interface BuildingEvent {
  type: 'built' | 'demolished';
  lot: number;
  kind: number;
  rotation: number;
}
/** A road a builder added (`ROAD_ADDED`) or took away (`ROAD_REMOVED`), between nodes `a` and `b`. */
interface RoadworkEvent {
  type: 'roadwork';
  segment: number;
  change: number;
  a: number;
  b: number;
}
/** A vehicle moved to `node` and sent on a new route, because a road on its old one was taken away. */
interface ReplanEvent {
  type: 'replan';
  resident: number;
  vehicle: number;
  node: number;
  route: [number, number][];
}
interface SpeedEvent {
  type: 'speed';
  ticksPerSecond: number;
}
/** What became of a builder's command: `result` 0 is applied, anything else a refusal (core/src/record.rs). */
export interface CommandEvent {
  type: 'command';
  principal: string;
  name: string;
  id: number;
  result: number;
}
interface LedgerEvent {
  type: 'ledger';
  reason: number;
  earned: number;
  spent: number;
}
interface BalanceEvent {
  type: 'balance';
  amount: number;
}
/** The events this page acts on; the rest of what a record carries is ignored. */
export type TickEvent =
  | TripEvent
  | BuildingEvent
  | RoadworkEvent
  | ReplanEvent
  | SpeedEvent
  | CommandEvent
  | LedgerEvent
  | BalanceEvent
  | { type: 'other' };

export interface TickRecord {
  kind: 'tick';
  epoch: number;
  district: number;
  tick: number;
  speed: number;
  keyframeOffset: number;
  wallUs: number;
  /** `roads` rows are `[segment, change, a, b]`, for every road a builder added in the district, live or removed. */
  keyframe: { buildings: [number, number, number][]; roads?: [number, number, number, number][] } | null;
  events: TickEvent[];
}

/** A trip made into something that can be placed at a tick. Freed by whoever stops using it. */
export interface Journey {
  arrive(): number;
  positionAt(tick: number, out: Uint32Array): void;
  /** Writes the ids of the lot the trip leaves and the lot it enters. */
  lots(out: Uint32Array): void;
  free(): void;
}

/** What turns a `trip` or `replan` event into a {@link Journey}: core's `Metro`. */
export interface Trips {
  trip(resident: number, vehicle: number, depart: number, route: Uint32Array): Journey | undefined;
  /** A replanned trip from `node`; without it every `replan` is counted unplaced. */
  replan?(resident: number, vehicle: number, depart: number, node: number, route: Uint32Array): Journey | undefined;
  /** Give the routes the roads builders added, as {@link CityState.builtRoads} lists them. */
  setRoads?(roads: Uint32Array): void;
}

/** A road a builder added: whether it is still there, and the nodes it joins. */
export interface BuiltRoad {
  change: number;
  a: number;
  b: number;
}

const NO_ROADS = new Uint32Array(0);
/** The built roads each `Trips` was last given. Several states can share one `Metro`, so it is tracked per `Metro`. */
const given = new WeakMap<Trips, Uint32Array>();
const refused = new WeakMap<Trips, Uint32Array>();

/**
 * Give `trips` the roads of `roads` unless it has them already. Trips on a built segment resolve only once the
 * `Metro` knows that segment. Returns false when the `Metro` would not take them.
 */
export function syncRoads(trips: Trips, roads: Uint32Array): boolean {
  const held = given.get(trips) ?? NO_ROADS;
  if (held === roads || (held.length === 0 && roads.length === 0) || !trips.setRoads) return true;
  // A list core turned down is not tried again for every trip; core keeps the roads it had.
  if (refused.get(trips) === roads) return false;
  try {
    trips.setRoads(roads);
  } catch (err) {
    console.warn('the built roads do not fit the city', err);
    refused.set(trips, roads);
    return false;
  }
  given.set(trips, roads);
  return true;
}

/** One resident's trip, from the tick it leaves to the tick it arrives. */
export interface Voyage {
  resident: number;
  /** 0 on foot, 1 to 6 the kind of car. */
  vehicle: number;
  depart: number;
  journey: Journey;
}

export interface Building {
  kind: number;
  rotation: number;
}

/** A building that went up at `tick`, which the page draws rising until the window ends. */
export interface Rising extends Building {
  tick: number;
}

/** A building demolished at `tick`, which the page draws coming down from `from` of its height. */
export interface Falling extends Building {
  tick: number;
  from: number;
}

export class CityState {
  /**
   * Lots whose building went up within the last few ticks, by the tick of the `built` event. The log has one instant
   * per event, so this is the only record of when a building began: a keyframe lists the finished lot alone, and
   * {@link recover} fills in what it can from the records before it. A lot with no entry is drawn finished.
   */
  private drawn = -1;
  readonly rising = new Map<number, Rising>();
  /** Lots demolished within the last few ticks, with the building that stood there. */
  readonly falling = new Map<number, Falling>();
  /** Lots that differ from the generated city. */
  readonly built = new Map<number, Building>();
  /**
   * Every road a builder added, by segment, including the ones taken away again: segment ids are never reused, so
   * core needs the gaps to number the live ones.
   */
  readonly roads = new Map<number, BuiltRoad>();
  /** The district whose records tell of a segment (that of its node a), so its keyframe can replace the entry. */
  private readonly roadDistrict = new Map<number, number>();
  /** {@link builtRoads}, until the roads change. */
  private roadList: Uint32Array | null = NO_ROADS;
  /** The newest tick of each district. */
  readonly ticks: number[];
  /** The sim epoch of each district's newest record. */
  private readonly epochs: number[];
  /** The sim's ticks a second, from the newest record. */
  speed = 4;
  /**
   * Each district's share of the city's funds, or `null` before its record says. A record's `balance` sets the share
   * and a `ledger` moves it, so a state folded from a keyframe and the records after it has the funds of its tick.
   */
  private readonly shares: (number | null)[];
  /** Trips the log described that no record has said arrived, by resident. */
  readonly voyages = new Map<number, Voyage>();
  /** Voyages a resident's next trip replaced before they arrived; still drawn until they do. */
  private readonly finishing: Voyage[] = [];
  /** Trips whose legs matched no route of their resident; zero unless the sim and this page disagree. */
  unplaced = 0;
  /** Told when a builder's road is added or taken away. */
  onRoads: (() => void) | null = null;
  /** Told when a lot's building changes, with `null` for the generated one. */
  onLot: ((lot: number, building: Building | null) => void) | null = null;
  /** Told when a voyage is replaced or ends, just before its journey is freed. */
  onVoyageEnd: ((voyage: Voyage) => void) | null = null;
  /** Told of every `command` event the records carry, to answer a command this page sent. Only the live state sets it. */
  onCommand: ((event: CommandEvent) => void) | null = null;
  /** Told what became of every record handed to {@link apply}, for checking the order a district was followed in. */
  onRecord: ((district: number, tick: number, result: 'applied' | 'seen' | 'gap') => void) | null = null;

  constructor(
    private readonly city: City,
    private readonly trips: Trips,
    districts: number,
  ) {
    this.ticks = Array<number>(districts).fill(-1);
    this.epochs = Array<number>(districts).fill(-1);
    this.shares = Array<number | null>(districts).fill(null);
  }

  /** The city's funds: the districts' shares added up, or `null` until every district has said what its share is. */
  get funds(): number | null {
    let total = 0;
    for (const share of this.shares) {
      if (share === null) return null;
      total += share;
    }
    return total;
  }

  /** The sim epoch of a district's newest record, or -1 before it has one. */
  epochOf(district: number): number {
    return this.epochs[district] ?? -1;
  }

  /** The newest tick every district has, or -1 until each has one. */
  get latest(): number {
    return Math.min(...this.ticks);
  }

  /**
   * Take one district's record. A record is a repeat, and ignored, when its `(epoch, district, tick)` is not newer than
   * the district's newest. A record that skips a tick without a keyframe to make up for it is a `gap`: it is not taken,
   * and the caller reads what is missing and applies it in order.
   */
  apply(record: TickRecord, allowGap = false): 'applied' | 'seen' | 'gap' {
    const result = this.fold(record, allowGap);
    this.onRecord?.(record.district, record.tick, result);
    return result;
  }

  private fold(record: TickRecord, allowGap: boolean): 'applied' | 'seen' | 'gap' {
    const d = record.district;
    if (d >= this.ticks.length) return 'seen';
    const newEpoch = record.epoch > this.epochs[d]!;
    if (record.epoch < this.epochs[d]! || (!newEpoch && record.tick <= this.ticks[d]!)) return 'seen';
    if (!newEpoch && !allowGap && !record.keyframe && this.ticks[d]! >= 0 && record.tick !== this.ticks[d]! + 1) {
      return 'gap';
    }
    // A keyframe in a state that already follows this district keeps the animations the log told of, still in their window.
    const fresh = newEpoch || this.ticks[d]! < 0;
    this.epochs[d] = record.epoch;
    this.ticks[d] = record.tick;
    this.speed = record.speed;
    if (record.keyframe) this.keyframe(d, record.keyframe.buildings, record.keyframe.roads ?? [], fresh);
    for (const e of record.events) {
      if (e.type === 'trip') {
        const t = e;
        syncRoads(this.trips, this.builtRoads());
        const journey = this.trips.trip(t.resident, t.vehicle, t.depart, Uint32Array.from(t.route.flat()));
        if (!journey) {
          this.unplaced++;
          continue;
        }
        const old = this.voyages.get(t.resident);
        if (old) this.finishing.push(old);
        this.voyages.set(t.resident, { resident: t.resident, vehicle: t.vehicle, depart: t.depart, journey });
      } else if (e.type === 'replan') {
        this.replan(e, record.tick);
      } else if (e.type === 'built' || e.type === 'demolished') {
        this.mark(e, record.tick, this.rising, this.falling);
        this.set(
          e.lot,
          e.type === 'built' ? { kind: e.kind, rotation: e.rotation } : { kind: NO_BUILDING, rotation: 0 },
        );
      } else if (e.type === 'roadwork') {
        this.road(d, e.segment, { change: e.change, a: e.a, b: e.b });
      } else if (e.type === 'speed') {
        this.speed = e.ticksPerSecond;
      } else if (e.type === 'command') {
        this.onCommand?.(e);
      } else if (e.type === 'ledger') {
        const share = this.shares[d];
        if (share !== null && share !== undefined) this.shares[d] = share + e.earned - e.spent;
      } else if (e.type === 'balance') {
        this.shares[d] = e.amount;
      }
    }
    this.prune(d);
    return 'applied';
  }

  // The old trip may run along a road that is gone, so it stops being drawn now rather than when it would have arrived.
  private replan(e: ReplanEvent, tick: number): void {
    const old = this.voyages.get(e.resident);
    if (old) {
      this.voyages.delete(e.resident);
      this.end(old);
    }
    for (let i = this.finishing.length - 1; i >= 0; i--) {
      const v = this.finishing[i]!;
      if (v.resident !== e.resident) continue;
      this.finishing.splice(i, 1);
      this.end(v);
    }
    syncRoads(this.trips, this.builtRoads());
    const journey = this.trips.replan?.(e.resident, e.vehicle, tick, e.node, Uint32Array.from(e.route.flat()));
    if (!journey) {
      this.unplaced++;
      return;
    }
    this.voyages.set(e.resident, { resident: e.resident, vehicle: e.vehicle, depart: tick, journey });
  }

  /**
   * The roads builders added, as `Metro.setRoads` takes them: segment, node a, node b and 1 if taken away, four numbers
   * each in segment order. The same array until the roads change.
   */
  builtRoads(): Uint32Array {
    if (this.roadList) return this.roadList;
    const ids = [...this.roads.keys()].sort((x, y) => x - y);
    const out = new Uint32Array(ids.length * 4);
    ids.forEach((id, i) => {
      const r = this.roads.get(id)!;
      out.set([id, r.a, r.b, r.change === ROAD_REMOVED ? 1 : 0], i * 4);
    });
    return (this.roadList = out);
  }

  // Remember when a lot changed, for the animation. A demolition during a rise comes down from the height reached.
  private mark(
    e: { type: 'built' | 'demolished'; lot: number; kind: number; rotation: number },
    tick: number,
    rising: Map<number, Rising>,
    falling: Map<number, Falling>,
  ): void {
    if (e.type === 'built') {
      falling.delete(e.lot);
      rising.set(e.lot, { kind: e.kind, rotation: e.rotation, tick });
    } else {
      const was = rising.get(e.lot);
      rising.delete(e.lot);
      falling.set(e.lot, { kind: e.kind, rotation: e.rotation, tick, from: was ? progress(was.tick, tick) : 1 });
    }
  }

  /**
   * Say which tick is on screen. Animations are dropped once the drawn tick is past their window, not the newest
   * record's: a burst of records (a gap filled, a hidden tab, a link that came back) must not drop a building before
   * it is drawn rising.
   */
  settle(drawn: number): void {
    this.drawn = Math.floor(drawn);
    for (let d = 0; d < this.ticks.length; d++) this.prune(d);
  }

  // Entries stay a little past their window. Nothing is dropped before the drawn tick is known: the newest record can
  // be tens of ticks ahead of it, since the playback timer applies records between frames.
  private prune(district: number): void {
    const done = (lot: number, at: number) =>
      this.city.lots[lot]?.district === district && this.drawn >= 0 && at + WINDOW + 2 <= this.drawn;
    for (const [lot, r] of this.rising) if (done(lot, r.tick)) this.rising.delete(lot);
    for (const [lot, f] of this.falling) if (done(lot, f.tick)) this.falling.delete(lot);
  }

  /**
   * Take the start ticks the records before a keyframe tell of, for a state folded from that keyframe. A building that
   * went up or came down in the few ticks before a keyframe is listed there as it stands, so a seek to a tick inside
   * its window reads those records (oldest first) to find when it began. An entry the state already has, or one the
   * state's lot no longer matches, is left alone.
   */
  recover(before: readonly TickRecord[]): void {
    const rising = new Map<number, Rising>();
    const falling = new Map<number, Falling>();
    for (const r of before) {
      for (const e of r.events)
        if (e.type === 'built' || e.type === 'demolished') this.mark(e, r.tick, rising, falling);
    }
    for (const [lot, r] of rising) {
      const now = this.built.get(lot);
      if (now?.kind === r.kind && now.rotation === r.rotation && !this.rising.has(lot) && !this.falling.has(lot)) {
        this.rising.set(lot, r);
      }
    }
    for (const [lot, f] of falling) {
      if (this.built.get(lot)?.kind === NO_BUILDING && !this.rising.has(lot) && !this.falling.has(lot)) {
        this.falling.set(lot, f);
      }
    }
    for (let d = 0; d < this.ticks.length; d++) if (this.ticks[d]! >= 0) this.prune(d);
  }

  /** Every voyage to draw: those under way and those a later trip replaced that have yet to arrive. */
  *active(): Iterable<Voyage> {
    yield* this.finishing;
    yield* this.voyages.values();
  }

  /** Forget voyages that have arrived by `tick`. */
  retire(tick: number): void {
    for (const [resident, v] of this.voyages) {
      if (v.journey.arrive() <= tick) {
        this.voyages.delete(resident);
        this.end(v);
      }
    }
    for (let i = this.finishing.length - 1; i >= 0; i--) {
      const v = this.finishing[i]!;
      if (v.journey.arrive() <= tick) {
        this.finishing.splice(i, 1);
        this.end(v);
      }
    }
  }

  private end(voyage: Voyage): void {
    this.onVoyageEnd?.(voyage);
    voyage.journey.free();
  }

  // A keyframe lists every lot of its district that differs from the generated city, so a lot it leaves out is the
  // generated one again.
  private keyframe(
    district: number,
    diffs: [number, number, number][],
    roads: [number, number, number, number][],
    fresh: boolean,
  ): void {
    const listed = new Set(diffs.map((b) => b[0]));
    // The keyframe says what stands, not when it went up, so a fresh fold starts with none. A state that has followed
    // the log keeps what it knows; the drawn tick ends those.
    if (fresh) {
      for (const lot of [...this.rising.keys()])
        if (this.city.lots[lot]?.district === district) this.rising.delete(lot);
      for (const lot of [...this.falling.keys()])
        if (this.city.lots[lot]?.district === district) this.falling.delete(lot);
    }
    for (const lot of [...this.built.keys()]) {
      if (this.city.lots[lot]?.district === district && !listed.has(lot)) this.set(lot, null);
    }
    for (const [lot, kind, rotation] of diffs) this.set(lot, { kind, rotation });
    // The keyframe lists every road of the district, so one it leaves out was never built as of its tick.
    const listedRoads = new Set(roads.map((r) => r[0]));
    for (const segment of [...this.roads.keys()]) {
      if (this.roadDistrict.get(segment) === district && !listedRoads.has(segment)) {
        this.roads.delete(segment);
        this.roadDistrict.delete(segment);
        this.roadsChanged();
      }
    }
    for (const [segment, change, a, b] of roads) this.road(district, segment, { change, a, b });
  }

  private road(district: number, segment: number, road: BuiltRoad): void {
    this.roadDistrict.set(segment, district);
    const was = this.roads.get(segment);
    if (was?.change === road.change && was.a === road.a && was.b === road.b) return;
    this.roads.set(segment, road);
    this.roadsChanged();
  }

  private roadsChanged(): void {
    this.roadList = null;
    this.onRoads?.();
  }

  private set(lot: number, building: Building | null): void {
    const was = this.built.get(lot);
    if (building === null ? was === undefined : was?.kind === building.kind && was.rotation === building.rotation)
      return;
    if (building === null) this.built.delete(lot);
    else this.built.set(lot, building);
    this.onLot?.(lot, building);
  }

  /** The changes since `snapshot`, a copy of {@link built} taken earlier, for a drawing that began from it. */
  changesSince(snapshot: ReadonlyMap<number, Building>): [number, Building | null][] {
    const out: [number, Building | null][] = [];
    for (const [lot, b] of this.built) {
      const was = snapshot.get(lot);
      if (!was || was.kind !== b.kind || was.rotation !== b.rotation) out.push([lot, b]);
    }
    for (const lot of snapshot.keys()) if (!this.built.has(lot)) out.push([lot, null]);
    return out;
  }
}
