// The city as the log tells it: what each district's records add up to. Buildings are the generated city's plus the
// ones `built` and `demolished` events and keyframes change; trips are handed on to whatever draws them.
import type { City } from './layout';

/** A building kind that means the lot is empty. */
export const NO_BUILDING = 65535;

/** What a `road` event or a keyframe's road list says happened to a segment, as the sim writes it. */
export const ROAD_CLOSED = 0;
export const ROAD_OPENED = 1;
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
interface RoadEvent {
  type: 'road';
  segment: number;
  change: number;
}
interface SpeedEvent {
  type: 'speed';
  ticksPerSecond: number;
}
/** The events this page acts on; the rest of what a record carries is ignored. */
export type TickEvent = TripEvent | BuildingEvent | RoadEvent | SpeedEvent | { type: 'other' };

export interface TickRecord {
  kind: 'tick';
  epoch: number;
  district: number;
  tick: number;
  speed: number;
  keyframeOffset: number;
  wallUs: number;
  keyframe: { buildings: [number, number, number][]; roads?: [number, number][] } | null;
  events: TickEvent[];
}

/** A trip made into something that can be placed at a tick. Freed by whoever stops using it. */
export interface Journey {
  arrive(): number;
  positionAt(tick: number, out: Uint32Array): void;
  free(): void;
}

/** What turns a `trip` event into a {@link Journey}: core's `Metro`. */
export interface Trips {
  trip(resident: number, vehicle: number, depart: number, route: Uint32Array): Journey | undefined;
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

export class CityState {
  /** Lots that differ from the generated city. */
  readonly built = new Map<number, Building>();
  /** Segments closed, added or removed since the city was generated, by segment: a `ROAD_*` change. */
  readonly roads = new Map<number, number>();
  /** The district whose record last said something about a segment, so its keyframe can replace the entry. */
  private readonly roadDistrict = new Map<number, number>();
  /** The newest tick of each district. */
  readonly ticks: number[];
  /** The sim epoch of each district's newest record. */
  private readonly epochs: number[];
  /** The sim's ticks a second, from the newest record. */
  speed = 4;
  /** Trips the log described that no record has said arrived, by resident. */
  readonly voyages = new Map<number, Voyage>();
  /** Voyages a resident's next trip replaced before they arrived; still drawn until they do. */
  private readonly finishing: Voyage[] = [];
  /** Trips whose legs matched no route of their resident; zero unless the sim and this page disagree. */
  unplaced = 0;
  /** Told when a lot's building changes, with `null` for the generated one. */
  onLot: ((lot: number, building: Building | null) => void) | null = null;
  /** Told when a voyage is replaced or ends, just before its journey is freed. */
  onVoyageEnd: ((voyage: Voyage) => void) | null = null;
  /** Told what became of every record handed to {@link apply}, for checking the order a district was followed in. */
  onRecord: ((district: number, tick: number, result: 'applied' | 'seen' | 'gap') => void) | null = null;

  constructor(
    private readonly city: City,
    private readonly trips: Trips,
    districts: number,
  ) {
    this.ticks = Array<number>(districts).fill(-1);
    this.epochs = Array<number>(districts).fill(-1);
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
    this.epochs[d] = record.epoch;
    this.ticks[d] = record.tick;
    this.speed = record.speed;
    if (record.keyframe) this.keyframe(d, record.keyframe.buildings, record.keyframe.roads ?? []);
    for (const e of record.events) {
      if (e.type === 'trip') {
        const t = e;
        const journey = this.trips.trip(t.resident, t.vehicle, t.depart, Uint32Array.from(t.route.flat()));
        if (!journey) {
          this.unplaced++;
          continue;
        }
        const old = this.voyages.get(t.resident);
        if (old) this.finishing.push(old);
        this.voyages.set(t.resident, { resident: t.resident, vehicle: t.vehicle, depart: t.depart, journey });
      } else if (e.type === 'built' || e.type === 'demolished') {
        this.set(
          e.lot,
          e.type === 'built' ? { kind: e.kind, rotation: e.rotation } : { kind: NO_BUILDING, rotation: 0 },
        );
      } else if (e.type === 'road') {
        this.road(d, e.segment, e.change);
      } else if (e.type === 'speed') {
        this.speed = e.ticksPerSecond;
      }
    }
    return 'applied';
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
  private keyframe(district: number, diffs: [number, number, number][], roads: [number, number][]): void {
    const listed = new Set(diffs.map((b) => b[0]));
    for (const lot of [...this.built.keys()]) {
      if (this.city.lots[lot]?.district === district && !listed.has(lot)) this.set(lot, null);
    }
    for (const [lot, kind, rotation] of diffs) this.set(lot, { kind, rotation });
    for (const segment of [...this.roads.keys()]) {
      if (this.roadDistrict.get(segment) === district) this.roads.delete(segment);
    }
    for (const [segment, change] of roads) {
      this.roads.set(segment, change);
      this.roadDistrict.set(segment, district);
    }
  }

  // Opening a closed road and removing an added one put it back as generated, which is no entry.
  private road(district: number, segment: number, change: number): void {
    const was = this.roads.get(segment);
    if (change === ROAD_OPENED && was === ROAD_CLOSED) this.roads.delete(segment);
    else if (change === ROAD_REMOVED && was === ROAD_ADDED) this.roads.delete(segment);
    else this.roads.set(segment, change);
    this.roadDistrict.set(segment, district);
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
