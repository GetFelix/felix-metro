// A resident's day as the log tells it: the trips they made and the places they stayed, each with the tick the sim
// wrote it at. Nothing here is predicted from their schedule, so a trip that left late or a change of route shows as it
// happened.
import type { KeyframeResident, TickRecord } from './city';
import { TICKS_PER_DAY } from './clock';
import { activityWords, dayTime } from './follow';

/** Ticks past the end of a day that are read too, so a trip that left before midnight shows where it arrived. */
export const SLACK = 240;

interface Entry {
  /** The tick a click seeks to: when it began, or the start of the day for one that began before it. */
  tick: number;
  /** It began before the day did. */
  carried: boolean;
}

/** A trip from the tick it left. */
export interface TripEntry extends Entry {
  kind: 'trip';
  car: boolean;
  /** The tick of the arrival, or null when the log has none yet. */
  arrived: number | null;
  /** The lot reached. */
  lot: number | null;
  /** What they went there to do, as the log numbers activities. */
  activity: number | null;
}

/** Time spent inside a building, from the arrival until the next trip leaves. */
export interface StayEntry extends Entry {
  kind: 'stay';
  lot: number;
  activity: number | null;
  /** The tick the next trip left, or null when the log has none yet. */
  left: number | null;
}

/** The route changed on the way. */
export interface ReplanEntry extends Entry {
  kind: 'replan';
}

export type DayEntry = TripEntry | StayEntry | ReplanEntry;

/** The index of the day a tick is in, counted from 0. */
export const dayOf = (tick: number): number => Math.floor(tick / TICKS_PER_DAY);

type Fact = Extract<TickRecord['events'][number], { type: 'trip' | 'replan' | 'arrived' | 'activity' }>;

interface Stored {
  epoch: number;
  tick: number;
  district: number;
  facts: Fact[];
}

/**
 * What the log says about one resident. Records are taken in any order and any number of times: a record is kept once
 * per district and tick, the newest epoch winning. A restarted sim's newer epoch starts again from an earlier tick, so
 * it also supersedes every older-epoch record at or after its first tick, as a seek's search orders the log by epoch and
 * then tick. A day read from history and the same records arriving live make one day.
 */
export class DayLog {
  /** By district, then tick. */
  private readonly stored: Map<number, Stored>[] = [];
  /** The first tick seen of each epoch, in any district: where a newer epoch begins over an older one. */
  private readonly starts = new Map<number, number>();
  /** Where the resident was at each keyframe tick: their entry in whichever district's keyframe lists them. */
  private readonly frames = new Map<number, { epoch: number; at: KeyframeResident }>();

  constructor(readonly resident: number) {}

  /** Take in a record; whether it told anything new about the resident. */
  add(record: TickRecord): boolean {
    const { district, epoch, tick } = record;
    const first = this.starts.get(epoch);
    if (first === undefined || tick < first) this.starts.set(epoch, tick);
    const mine = (this.stored[district] ??= new Map());
    let changed = false;
    const had = mine.get(tick);
    if (!had || epoch > had.epoch) {
      let facts: Fact[] | null = null;
      for (const e of record.events) {
        if (
          (e.type === 'trip' || e.type === 'replan' || e.type === 'arrived' || e.type === 'activity') &&
          e.resident === this.resident
        ) {
          (facts ??= []).push(e);
        }
      }
      if (had || facts) {
        mine.set(tick, { epoch, tick, district, facts: facts ?? [] });
        changed = true;
      }
    }
    const at = record.keyframe?.residents?.find((r) => r.id === this.resident);
    const frame = this.frames.get(tick);
    if (at && (!frame || epoch > frame.epoch)) {
      this.frames.set(tick, { epoch, at });
      changed = true;
    }
    return changed;
  }

  /** Whether a newer epoch has begun at or before `tick`, which makes the older one's record not the log's. */
  private superseded(epoch: number, tick: number): boolean {
    for (const [e, first] of this.starts) if (e > epoch && first <= tick) return true;
    return false;
  }

  /**
   * The day from tick `from` up to, not including, `to`: what began in it, and what was going on when it began. What
   * the log has after `to` still closes an entry, so a trip that left before midnight shows its arrival.
   */
  entries(from: number, to: number): DayEntry[] {
    const stored = this.stored
      .flatMap((byTick) => [...byTick.values()])
      .filter((s) => s.tick >= from && !this.superseded(s.epoch, s.tick))
      .sort((a, b) => a.tick - b.tick || a.district - b.district);
    const out: DayEntry[] = [];
    let stay: StayEntry | null = null;
    let trip: TripEntry | null = null;
    let arrivedBy: TripEntry | null = null;

    // The keyframe says what they were doing as the first tick ended, so a trip or an arrival in that tick speaks for itself.
    const spoken = stored.some(
      (s) => s.tick === from && s.facts.some((f) => f.type === 'trip' || f.type === 'arrived'),
    );
    const frame = this.frames.get(from);
    const opening = frame && !this.superseded(frame.epoch, from) ? frame.at : null;
    if (opening && !spoken) {
      if (opening.activity !== undefined && opening.lot !== undefined) {
        stay = { kind: 'stay', tick: from, carried: true, lot: opening.lot, activity: opening.activity, left: null };
        out.push(stay);
      } else if (opening.vehicle !== undefined) {
        trip = {
          kind: 'trip',
          tick: from,
          carried: true,
          car: opening.vehicle !== 0,
          arrived: null,
          lot: null,
          activity: null,
        };
        out.push(trip);
      }
    }

    for (const { tick, facts } of stored) {
      for (const fact of facts) {
        const inDay = tick < to;
        if (fact.type === 'trip') {
          if (stay) stay.left = tick;
          stay = null;
          trip = {
            kind: 'trip',
            tick,
            carried: false,
            car: fact.vehicle !== 0,
            arrived: null,
            lot: null,
            activity: null,
          };
          if (inDay) out.push(trip);
        } else if (fact.type === 'arrived') {
          if (trip) {
            trip.arrived = tick;
            trip.lot = fact.lot;
          }
          arrivedBy = trip;
          trip = null;
          stay = { kind: 'stay', tick, carried: false, lot: fact.lot, activity: null, left: null };
          if (inDay) out.push(stay);
        } else if (fact.type === 'activity') {
          if (stay) stay.activity = fact.kind;
          if (arrivedBy) arrivedBy.activity = fact.kind;
          arrivedBy = null;
        } else if (inDay) {
          out.push({ kind: 'replan', tick, carried: false });
        }
      }
    }
    return out;
  }
}

/** One line of the panel. */
export interface DayRow {
  kind: DayEntry['kind'];
  /** Where a click seeks. */
  tick: number;
  /** It began before the day did, so `tick` is the day's start. */
  carried: boolean;
  /** What they did, such as "Drove to work". */
  text: string;
  /** The name of the place, when the lot has one. */
  place: string | null;
  /** The times, such as "08:02 to 08:19". */
  when: string;
}

/**
 * The entries as the panel words them. `placeName` gives the name of a lot, where it has one. A trip with no arrival is
 * under way only while the day is still going (`live`); in a day that is over the log simply has no arrival for it.
 */
export function rows(entries: readonly DayEntry[], placeName: (lot: number) => string | null, live = true): DayRow[] {
  return entries.map((e): DayRow => {
    if (e.kind === 'replan') {
      return {
        kind: 'replan',
        tick: e.tick,
        carried: false,
        text: 'Changed route',
        place: null,
        when: dayTime(e.tick),
      };
    }
    if (e.kind === 'stay') {
      const words = activityWords(e.activity);
      return {
        kind: 'stay',
        tick: e.tick,
        carried: e.carried,
        text: words?.here ?? 'Indoors',
        place: placeName(e.lot),
        when: span(e.carried, e.tick, e.left),
      };
    }
    const done = e.arrived !== null;
    const past = done || !live;
    const verb = e.car ? (past ? 'Drove' : 'Driving') : past ? 'Walked' : 'Walking';
    const to = activityWords(e.activity)?.to;
    return {
      kind: 'trip',
      tick: e.tick,
      carried: e.carried,
      text: to ? `${verb} to ${to}` : verb,
      place: e.lot === null ? null : placeName(e.lot),
      when: span(e.carried, e.tick, e.arrived),
    };
  });
}

function span(carried: boolean, from: number, to: number | null): string {
  if (carried) return to === null ? 'from earlier' : `until ${dayTime(to)}`;
  return to === null ? `from ${dayTime(from)}` : `${dayTime(from)} to ${dayTime(to)}`;
}

/** The row they are in at `tick`: the last stay or trip begun by then, or null before the first. */
export function currentRow(list: readonly DayRow[], tick: number): number | null {
  let at: number | null = null;
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    if (r.kind !== 'replan' && r.tick <= tick) at = i;
  }
  return at;
}
