// The city as the log tells it: what each district's records add up to. Buildings are the generated city's plus the
// ones `built` and `demolished` events and keyframes change; trips are handed on to whatever draws them.
import type { City } from './layout';

/** A building kind that means the lot is empty. */
export const NO_BUILDING = 65535;

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
interface SpeedEvent {
  type: 'speed';
  ticksPerSecond: number;
}
/** The events this page acts on; the rest of what a record carries is ignored. */
export type TickEvent = TripEvent | BuildingEvent | SpeedEvent | { type: 'other' };

export interface TickRecord {
  kind: 'tick';
  epoch: number;
  district: number;
  tick: number;
  speed: number;
  keyframeOffset: number;
  wallUs: number;
  keyframe: { buildings: [number, number, number][] } | null;
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
  /** The newest tick of each district. */
  readonly ticks: number[];
  /** The sim's ticks a second, from the newest record. */
  speed = 4;
  /** Trips the log described that no record has said arrived, by resident. */
  readonly voyages = new Map<number, Voyage>();
  /** Trips whose legs matched no route of their resident; zero unless the sim and this page disagree. */
  unplaced = 0;
  /** Told when a lot's building changes, with `null` for the generated one. */
  onLot: ((lot: number, building: Building | null) => void) | null = null;
  /** Told when a voyage is replaced or ends, just before its journey is freed. */
  onVoyageEnd: ((voyage: Voyage) => void) | null = null;

  constructor(
    private readonly city: City,
    private readonly trips: Trips,
    districts: number,
  ) {
    this.ticks = Array<number>(districts).fill(-1);
  }

  /** The newest tick every district has, or -1 until each has one. */
  get latest(): number {
    return Math.min(...this.ticks);
  }

  /** Take one district's record. A record at or before the district's newest tick is one already seen. */
  apply(record: TickRecord): void {
    const d = record.district;
    if (d >= this.ticks.length || record.tick <= this.ticks[d]!) return;
    this.ticks[d] = record.tick;
    this.speed = record.speed;
    if (record.keyframe) this.keyframe(d, record.keyframe.buildings);
    for (const e of record.events) {
      if (e.type === 'trip') {
        const t = e;
        const journey = this.trips.trip(t.resident, t.vehicle, t.depart, Uint32Array.from(t.route.flat()));
        if (!journey) {
          this.unplaced++;
          continue;
        }
        const old = this.voyages.get(t.resident);
        if (old) this.end(old);
        this.voyages.set(t.resident, { resident: t.resident, vehicle: t.vehicle, depart: t.depart, journey });
      } else if (e.type === 'built' || e.type === 'demolished') {
        this.set(
          e.lot,
          e.type === 'built' ? { kind: e.kind, rotation: e.rotation } : { kind: NO_BUILDING, rotation: 0 },
        );
      } else if (e.type === 'speed') {
        this.speed = e.ticksPerSecond;
      }
    }
  }

  /** Forget voyages that have arrived by `tick`. */
  retire(tick: number): void {
    for (const [resident, v] of this.voyages) {
      if (v.journey.arrive() <= tick) {
        this.voyages.delete(resident);
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
  private keyframe(district: number, diffs: [number, number, number][]): void {
    const listed = new Set(diffs.map((b) => b[0]));
    for (const lot of [...this.built.keys()]) {
      if (this.city.lots[lot]?.district === district && !listed.has(lot)) this.set(lot, null);
    }
    for (const [lot, kind, rotation] of diffs) this.set(lot, { kind, rotation });
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
