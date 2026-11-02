// Cars and walkers for the voyages the log describes: where each one is at a fractional tick, handed to a fleet to draw.
import type * as THREE from 'three';
import type { Voyage } from './city';

/** Tiles from the road's centre line to a car's lane and to a walker's pavement. */
export const LANE = 0.17;
export const PAVEMENT = 0.38;
/** Ticks a trip spends turning in from the road at each end; a trip shorter than two of them gives half to each end. */
export const TURN_TICKS = 1;

/**
 * How far into its lot a trip is at `tick`: 0 on the road, 1 standing on the lot. It falls over the first ticks after
 * the trip leaves and rises over the last ticks before it arrives. A function of the tick alone, so a rewind draws
 * the same.
 */
export function doorEase(tick: number, depart: number, arrive: number): number {
  const window = Math.min(TURN_TICKS, (arrive - depart) / 2);
  if (!(window > 0)) return 0;
  return Math.max(0, 1 - Math.min(tick - depart, arrive - tick) / window);
}

/** Where a lot stands, in tiles from the city's north-west corner. */
export interface LotAt {
  x: number;
  z: number;
}

export interface Pose {
  x: number;
  z: number;
  /** Rotation about Y: 0 faces +Z, and the front turns toward +X as it grows. */
  heading: number;
}

/**
 * The pose between two positions, in tiles, `f` of the way along, kept `side` to the right of the direction of travel.
 * Standing still keeps `heading`; so does moving less than a hair, which would otherwise spin on rounding.
 */
export function poseBetween(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  f: number,
  side: number,
  heading: number,
  /** Written and returned in place of a new pose, for a caller that places many a frame. */
  out: Pose = { x: 0, z: 0, heading: 0 },
): Pose {
  const dx = b[0]! - a[0]!;
  const dz = b[1]! - a[1]!;
  const turn = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : heading;
  // Right of travel is (cos, -sin) of the heading: heading east puts the lane to the north, as the frame's traffic.
  out.x = a[0]! + dx * f + side * Math.cos(turn);
  out.z = a[1]! + dz * f - side * Math.sin(turn);
  out.heading = turn;
  return out;
}

/**
 * What draws the voyages. Each update places every car and walker once between `begin` and `end`; the fleet draws
 * what was placed, with nothing kept from the update before.
 */
export interface Fleet {
  /** Leave out what the camera cannot see, or draw everything when `camera` is null. Applies to later placements. */
  view(camera: THREE.Camera | null): void;
  /** Start a round of placements. `dt` seconds is how far the walkers' legs move on. */
  begin(dt: number): void;
  /**
   * Place a car of vehicle kind `kind` (1 to 6 from the log, 7 for the page's own garbage truck). `size` is 1 at full
   * size and 0 at nothing. `resident` is who drives it, left out for a car that is nobody's.
   */
  car(kind: number, x: number, y: number, z: number, heading: number, size: number, resident?: number): void;
  /** Place the walker `resident` is. */
  person(resident: number, x: number, y: number, z: number, heading: number, size: number): void;
  end(): void;
}

/** Where a voyage stands at a tick: the road pose, or the turn into a lot. */
export interface Placed {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** 1 at full size, shrinking to 0 as the trip turns into a lot. */
  size: number;
  /** The heading on the road, kept for when the trip stands still. */
  road: number;
}

interface Slot extends Placed {
  car: boolean;
  vehicle: number;
  voyage: Voyage;
}

export class Traffic {
  private readonly slots = new Map<number, Slot>();
  private readonly a = new Uint32Array(2);
  private readonly b = new Uint32Array(2);
  private readonly ends = new Uint32Array(2);
  private readonly from = [0, 0];
  private readonly to = [0, 0];
  private readonly pose: Pose = { x: 0, z: 0, heading: 0 };
  /** Placed after the voyages in every round, for what the page draws that the log does not describe. */
  extras: ((fleet: Fleet) => void) | null = null;
  /** A voyage was released since the fleet last drew, so it still shows one that has ended. */
  private stale = false;
  private updating = false;

  /** Voyages left undrawn by the last update because `cap` were already drawn. */
  capped = 0;
  /** A resident the cap never leaves out, such as the one the camera follows. */
  pinned: number | null = null;
  /** Most voyages drawn at once. Ones already drawn stay until their voyage ends, so lowering it drains. */
  cap = Infinity;

  /**
   * `half` is how far tile 0 sits from the middle of the map, in tiles.
   */
  constructor(
    private readonly fleet: Fleet,
    private readonly half: number,
    /** The city's lots by id, for turning into the one a trip starts or ends at. */
    private readonly lots: readonly LotAt[] = [],
  ) {}

  /** Voyages holding a place right now. One shrunk to nothing at a lot's door still counts, though nothing is drawn. */
  get drawn(): number {
    return this.slots.size;
  }

  /** Where each voyage drawn stands, in tiles from the middle of the map. */
  where(): { resident: number; car: boolean; x: number; z: number; heading: number }[] {
    return [...this.slots].map(([resident, { car, x, z, heading }]) => ({ resident, car, x, z, heading }));
  }

  /** Stop drawing a voyage, such as when it arrives. */
  release(voyage: Voyage): void {
    const slot = this.slots.get(voyage.resident);
    // A resident's next trip can be asked to stand down while the one before it is still drawn.
    if (!slot || slot.voyage !== voyage) return;
    this.slots.delete(voyage.resident);
    if (!this.updating) this.stale = true;
  }

  /** Draw again if a voyage was released since the last update, for a frame that has no update of its own. */
  sync(): void {
    if (this.stale) this.draw(0);
  }

  /** Place every voyage under way at tick `tick`, a fraction, and move walkers' legs on by `dt` seconds. */
  update(tick: number, dt: number, voyages: Iterable<Voyage>): void {
    this.capped = 0;
    this.updating = true;
    for (const v of voyages) {
      if (tick < v.depart || tick >= v.journey.arrive()) {
        this.release(v);
        continue;
      }
      let slot = this.slots.get(v.resident);
      if (slot && slot.voyage !== v) continue;
      if (!slot) {
        // First come, first drawn: nearest-to-camera would need a sort a frame. A resident being followed is always drawn.
        if (this.slots.size >= this.cap && v.resident !== this.pinned) {
          this.capped++;
          continue;
        }
        slot = { car: v.vehicle !== 0, x: 0, y: 0, z: 0, heading: 0, size: 1, road: 0, vehicle: v.vehicle, voyage: v };
        this.slots.set(v.resident, slot);
      }
      this.place(v, tick, slot);
    }
    this.updating = false;
    this.draw(dt);
  }

  /**
   * Where `voyage` stands at `tick`, whether or not it holds a place: the cap and the camera do not decide it. `null`
   * when the trip has not left or has arrived.
   */
  positionOf(voyage: Voyage, tick: number): Placed | null {
    if (tick < voyage.depart || tick >= voyage.journey.arrive()) return null;
    const slot = this.slots.get(voyage.resident);
    const placed: Placed = { x: 0, y: 0, z: 0, heading: 0, size: 1, road: slot?.voyage === voyage ? slot.road : 0 };
    this.place(voyage, tick, placed);
    return placed;
  }

  private place(v: Voyage, tick: number, into: Placed): void {
    const whole = Math.floor(tick);
    const f = tick - whole;
    v.journey.positionAt(whole, this.a);
    v.journey.positionAt(whole + 1, this.b);
    const on = v.vehicle === 0;
    this.from[0] = this.a[0]! / 1000 - this.half;
    this.from[1] = this.a[1]! / 1000 - this.half;
    this.to[0] = this.b[0]! / 1000 - this.half;
    this.to[1] = this.b[1]! / 1000 - this.half;
    const arrive = v.journey.arrive();
    const pose = poseBetween(this.from, this.to, f, on ? PAVEMENT : LANE, into.road, this.pose);
    into.road = pose.heading;
    let turned = doorEase(tick, v.depart, arrive);
    let heading = pose.heading;
    if (turned > 0) {
      // The lot at the end the trip is nearer: the one it left, or the one it is reaching.
      v.journey.lots(this.ends);
      const lot = this.lots[this.ends[tick - v.depart < arrive - tick ? 0 : 1]!];
      if (lot) {
        const tx = lot.x - this.half;
        const tz = lot.z - this.half;
        let turn = Math.atan2(tx - pose.x, tz - pose.z) - heading;
        turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
        heading += turned * turn;
        pose.x += turned * (tx - pose.x);
        pose.z += turned * (tz - pose.z);
      } else turned = 0;
    }
    into.size = 1 - turned;
    into.x = pose.x;
    into.y = on ? 0 : 0.036;
    into.z = pose.z;
    into.heading = heading;
  }

  private draw(dt: number): void {
    this.stale = false;
    this.fleet.begin(dt);
    for (const [resident, s] of this.slots) {
      if (s.car) this.fleet.car(s.vehicle, s.x, s.y, s.z, s.heading, s.size, resident);
      else this.fleet.person(resident, s.x, s.y, s.z, s.heading, s.size);
    }
    this.extras?.(this.fleet);
    this.fleet.end();
  }
}
