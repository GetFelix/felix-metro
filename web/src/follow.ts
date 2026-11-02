// Following one resident: who they are, what their day has them doing at a tick, and where the camera goes.
// A resident is known by their number alone, never by the district or the instance slot they happen to be drawn in,
// so a follow holds across district crossings, seeks and rewinds: every frame it asks the state on screen again.
import type { Voyage } from './city';
import type { CameraRig } from './camera';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './clock';

export type Activity = 'home' | 'work' | 'school' | 'shop' | 'leisure';
export type Archetype = 'office' | 'shift' | 'shopkeeper' | 'student' | 'retiree' | 'night';

/** A stretch of the day spent at one lot, ending when the resident sets off for the next block. */
export interface Block {
  activity: Activity;
  lot: number;
  /** The tick of the day they leave. */
  leave: number;
}

/** A resident as core describes them from the seed: the same day, every day. */
export interface Profile {
  id: number;
  name: string;
  archetype: Archetype;
  home: number;
  /** The kind of car they drive, 1 to 6. */
  vehicle: number;
  blocks: Block[];
}

const ARCHETYPES: Record<Archetype, string> = {
  office: 'Office worker',
  shift: 'Shift worker',
  shopkeeper: 'Shopkeeper',
  student: 'Student',
  retiree: 'Retiree',
  night: 'Night worker',
};

const ACTIVITIES: Record<Activity, { here: string; to: string }> = {
  home: { here: 'At home', to: 'home' },
  work: { here: 'At work', to: 'work' },
  school: { here: 'At school', to: 'school' },
  shop: { here: 'Shopping', to: 'the shops' },
  leisure: { here: 'In the park', to: 'the park' },
};

/** Home between 22:00 and 06:00 is asleep, as the keyframe's counts have it. */
const BEDTIME = 22 * TICKS_PER_HOUR;
const WAKING = 6 * TICKS_PER_HOUR;

/** The profile core's `Metro.profile` wrote, or null when it is `undefined` (no such resident) or not one. */
export function parseProfile(json: string | undefined): Profile | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Profile;
    const known = (a: unknown) => typeof a === 'string' && a in ACTIVITIES;
    if (!(raw.archetype in ARCHETYPES) || !Array.isArray(raw.blocks) || raw.blocks.length === 0) return null;
    if (!raw.blocks.every((b) => known(b.activity) && Number.isInteger(b.lot) && Number.isInteger(b.leave)))
      return null;
    return raw;
  } catch {
    return null;
  }
}

export function archetypeLabel(archetype: Archetype): string {
  return ARCHETYPES[archetype];
}

/** A tick of the day as `07:15`. */
export function dayTime(tickOfDay: number): string {
  const minutes = Math.floor((tickOfDay % TICKS_PER_DAY) / 4);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The block a resident is in at `tick`, or on the road to. Block `i` ends at its `leave`, so the blocks that have
 * ended today say how far the day has got; the day closes, so what follows the last block is the first.
 */
export function blockAt(profile: Profile, tick: number): number {
  const time = tick % TICKS_PER_DAY;
  return profile.blocks.filter((b) => b.leave <= time).length % profile.blocks.length;
}

/** The trip a resident is on at the tick: whether it is by car, and the lot it ends at. */
export interface Trip {
  car: boolean;
  to: number;
}

export interface Doing {
  /** What they are doing now, as a short phrase. */
  text: string;
  /** The block they are in, or null on the road. */
  block: number | null;
  /** The lot to look at: the one they are in, or the one they are headed for. */
  lot: number;
}

/**
 * What a resident is doing at `tick`. On the road the trip says so; indoors the schedule does, which is the only
 * record of where they are between trips. A resident whose log has no trip for them yet is placed by the schedule too.
 */
export function doing(profile: Profile, tick: number, trip: Trip | null): Doing {
  if (trip) {
    const arriving = profile.blocks.find((b) => b.lot === trip.to);
    const place = arriving ? ACTIVITIES[arriving.activity].to : 'their next stop';
    return { text: `${trip.car ? 'Driving' : 'Walking'} to ${place}`, block: null, lot: trip.to };
  }
  const block = blockAt(profile, tick);
  const b = profile.blocks[block]!;
  const time = tick % TICKS_PER_DAY;
  const asleep = b.activity === 'home' && (time >= BEDTIME || time < WAKING);
  return { text: asleep ? 'Asleep at home' : ACTIVITIES[b.activity].here, block, lot: b.lot };
}

export interface Row {
  /** What the block is. */
  label: string;
  /** The name of the place, when the lot has one. */
  place: string | null;
  /** When they leave. */
  until: string;
}

/** The day's blocks in order, for the card. */
export function schedule(profile: Profile, placeName: (lot: number) => string | null): Row[] {
  return profile.blocks.map((b) => ({
    label: ACTIVITIES[b.activity].here,
    place: placeName(b.lot),
    until: dayTime(b.leave),
  }));
}

/** What the card shows. */
export interface CardView {
  resident: number;
  name: string;
  kind: string;
  doing: string;
  rows: Row[];
  /** The row of the block they are in, or null on the road. */
  current: number | null;
}

/** How far from the ground the camera stands when a follow starts, at most: close enough to see a walker. */
const FOLLOW_DISTANCE = 14;

export interface Deps {
  /** Core's `Metro.profile`. */
  profile(resident: number): string | undefined;
  /** The city's lots by id, in tiles from the north-west corner, with a name where they have one. */
  lots: readonly { x: number; z: number; name?: string | null }[];
  /** How far tile 0 sits from the middle of the map, in tiles. */
  half: number;
  rig: Pick<CameraRig, 'moveTo' | 'track' | 'view'>;
  /** Where a trip stands at a tick, whether or not it is drawn. */
  positionOf(voyage: Voyage, tick: number): { x: number; z: number } | null;
  /** Keep a resident drawn however many movers the tier allows, or null for none. */
  pin(resident: number | null): void;
  /** Draw the card, or take it away on null. */
  show(card: CardView | null): void;
}

export class Following {
  private profile: Profile | null = null;
  /** The camera has not been brought to them yet. */
  private arriving = false;
  private keepView = false;
  private shown = '';
  private readonly ends = new Uint32Array(2);

  constructor(private readonly deps: Deps) {}

  /** The resident followed, or null. */
  get resident(): number | null {
    return this.profile?.id ?? null;
  }

  /**
   * Follow `resident`; false, with nothing changed, when the city has no such resident. `keepView` leaves the
   * distance and angles as they are, for a link that carries its own view.
   */
  start(resident: number, keepView = false): boolean {
    const profile = parseProfile(this.deps.profile(resident));
    if (!profile) return false;
    this.profile = profile;
    this.arriving = true;
    this.keepView = keepView;
    this.shown = '';
    this.deps.pin(resident);
    return true;
  }

  stop(): void {
    if (!this.profile) return;
    this.profile = null;
    this.deps.pin(null);
    this.deps.show(null);
  }

  /**
   * Move the camera and the card on to `tick`. `voyageAt` finds the trip a resident is on in the state on screen,
   * which a seek or a rewind replaces, so nothing from an earlier state is kept.
   */
  frame(tick: number, voyageAt: (resident: number, tick: number) => Voyage | undefined): void {
    const profile = this.profile;
    if (!profile) return;
    const voyage = voyageAt(profile.id, tick);
    let trip: Trip | null = null;
    if (voyage) {
      voyage.journey.lots(this.ends);
      trip = { car: voyage.vehicle !== 0, to: this.ends[1]! };
    }
    const now = doing(profile, tick, trip);
    // Their place on the road is asked of the traffic at this tick, which does not depend on what is drawn.
    const spot = voyage ? this.deps.positionOf(voyage, tick) : null;
    const lot = this.deps.lots[now.lot];
    const at = spot ?? (lot ? { x: lot.x - this.deps.half, z: lot.z - this.deps.half } : null);
    if (at) this.look(at.x, at.z);
    const key = `${now.text}|${now.block}`;
    if (key === this.shown) return;
    this.shown = key;
    this.deps.show({
      resident: profile.id,
      name: profile.name,
      kind: archetypeLabel(profile.archetype),
      doing: now.text,
      rows: schedule(profile, (l) => this.deps.lots[l]?.name ?? null),
      current: now.block,
    });
  }

  private look(x: number, z: number): void {
    const rig = this.deps.rig;
    if (!this.arriving) return rig.track(x, z);
    this.arriving = false;
    const v = rig.view();
    rig.moveTo({ x, z }, this.keepView ? v.distance : Math.min(v.distance, FOLLOW_DISTANCE), v.azimuth, v.polar, {
      ease: !this.keepView,
    });
  }
}
