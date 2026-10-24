// Cars and walkers for the voyages the log describes: where each one is at a fractional tick, and a pool of models to
// stand in for them.
import type * as THREE from 'three';
import type { Voyage } from './city';

/** Tiles from the road's centre line to a car's lane and to a walker's pavement. */
export const LANE = 0.17;
export const PAVEMENT = 0.38;

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

/** A model standing in for a voyage. */
export interface Figure {
  o: THREE.Object3D;
  /** Walking animation, for people. */
  mixer?: THREE.AnimationMixer;
}

/** What the scene makes figures from. */
export interface Fleet {
  car(kind: number): Figure;
  person(resident: number): Figure;
}

interface Slot {
  figure: Figure;
  kind: string;
  heading: number;
  voyage: Voyage;
}

export class Traffic {
  private readonly slots = new Map<number, Slot>();
  private readonly free = new Map<string, Figure[]>();
  private readonly a = new Uint32Array(2);
  private readonly b = new Uint32Array(2);
  private readonly from = [0, 0];
  private readonly to = [0, 0];
  private readonly pose: Pose = { x: 0, z: 0, heading: 0 };

  /** Voyages left without a model by the last update, because it had made its share of new ones. */
  waiting = 0;
  /** Voyages left undrawn by the last update because `cap` models were already in use. */
  capped = 0;
  /** Most models in use at once. Models already drawn stay until their voyage ends, so lowering it drains. */
  cap = Infinity;
  private made = 0;

  /**
   * `half` is how far tile 0 sits from the middle of the map, in tiles. An update makes at most `newPerUpdate` models
   * the pool cannot supply: a seek into a busy hour can ask for hundreds at once, and making them all would hold the
   * frame for seconds. The rest are made by the updates after it.
   */
  constructor(
    private readonly fleet: Fleet,
    private readonly half: number,
    private readonly newPerUpdate = 16,
  ) {}

  /** Models in use right now. */
  get drawn(): number {
    return this.slots.size;
  }

  /** Where each model in use stands, in tiles from the middle of the map. */
  where(): { resident: number; car: boolean; x: number; z: number }[] {
    return [...this.slots].map(([resident, { figure, kind }]) => ({
      resident,
      car: kind !== 'walk',
      x: figure.o.position.x,
      z: figure.o.position.z,
    }));
  }

  /** Give a voyage's model back, such as when it arrives. */
  release(voyage: Voyage): void {
    const slot = this.slots.get(voyage.resident);
    // A resident's next trip can be asked to stand down while the one before it is still drawn.
    if (!slot || slot.voyage !== voyage) return;
    this.slots.delete(voyage.resident);
    slot.figure.o.visible = false;
    const pool = this.free.get(slot.kind) ?? [];
    pool.push(slot.figure);
    this.free.set(slot.kind, pool);
  }

  /** Place every voyage under way at tick `tick`, a fraction, and move walkers' legs on by `dt` seconds. */
  update(tick: number, dt: number, voyages: Iterable<Voyage>): void {
    const whole = Math.floor(tick);
    const f = tick - whole;
    this.waiting = 0;
    this.capped = 0;
    this.made = 0;
    for (const v of voyages) {
      if (tick < v.depart || tick >= v.journey.arrive()) {
        this.release(v);
        continue;
      }
      v.journey.positionAt(whole, this.a);
      v.journey.positionAt(whole + 1, this.b);
      let slot = this.slots.get(v.resident);
      if (slot && slot.voyage !== v) continue;
      if (!slot) {
        // First come, first drawn: nearest-to-camera would need a sort a frame.
        if (this.slots.size >= this.cap) {
          this.capped++;
          continue;
        }
        const taken = this.take(v);
        if (!taken) {
          this.waiting++;
          continue;
        }
        slot = taken;
      }
      const on = v.vehicle === 0;
      this.from[0] = this.a[0]! / 1000 - this.half;
      this.from[1] = this.a[1]! / 1000 - this.half;
      this.to[0] = this.b[0]! / 1000 - this.half;
      this.to[1] = this.b[1]! / 1000 - this.half;
      const pose = poseBetween(this.from, this.to, f, on ? PAVEMENT : LANE, slot.heading, this.pose);
      slot.heading = pose.heading;
      slot.figure.o.position.set(pose.x, on ? 0 : 0.036, pose.z);
      slot.figure.o.rotation.y = pose.heading;
      slot.figure.mixer?.update(dt);
    }
  }

  private take(v: Voyage): Slot | null {
    const kind = v.vehicle === 0 ? 'walk' : `car${v.vehicle}`;
    let figure = this.free.get(kind)?.pop();
    if (!figure) {
      if (this.made >= this.newPerUpdate) return null;
      this.made++;
      figure = v.vehicle === 0 ? this.fleet.person(v.resident) : this.fleet.car(v.vehicle);
    }
    figure.o.visible = true;
    const slot = { figure, kind, heading: 0, voyage: v };
    this.slots.set(v.resident, slot);
    return slot;
  }
}
