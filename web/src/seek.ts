// Time travel: finding the city at any retained tick. Each district's log holds one record per tick, so the record for
// tick T is found by reads that correct an estimate, its header names the keyframe it folds from, and the records
// from that keyframe to T are read in ranges and folded in order.
import type { CityState, TickRecord } from './city';
import { GatewayError, type Gateway } from './gateway';
import { keyframeOffset, parse } from './live';
import { TICKS_PER_HOUR } from './clock';

const STREAM = 'events';

/** The part of a gateway session a seek needs; the history connection is one. */
export type History = Pick<Gateway, 'read' | 'stateGet'>;

/** Records kept by offset, for the reads a later seek in the same neighbourhood would repeat. */
const RECORD_CACHE = 4096;
/** Keyframes kept by hour: a few city days of every district. */
const KEYFRAME_CACHE = 1024;
/** A search that has not found its record in this many reads is not converging; the log is not what was assumed. */
const MAX_PROBES = 48;

export class SeekError extends Error {
  override name = 'SeekError';
  constructor(
    readonly reason: 'unretained' | 'future' | 'broken',
    message: string,
    /** The nearest tick that can be shown. */
    readonly nearest?: number,
  ) {
    super(message);
  }
}

interface Known {
  offset: number;
  record: TickRecord;
}

/** A district's keyframe hour, the cache key: keyframes land on every 240th tick. */
const hourOf = (tick: number) => Math.floor(tick / TICKS_PER_HOUR);

export interface SeekStats {
  /** Reads sent to the gateway. */
  reads: number;
  /** Records answered from the cache. */
  hits: number;
}

export class Seeker {
  readonly stats: SeekStats = { reads: 0, hits: 0 };
  private readonly records = new Map<string, Known>();
  private readonly keyframes = new Map<string, Known>();
  /** The oldest offset retention has left, by district; 0 until a read says otherwise. */
  private readonly oldest: number[];

  constructor(
    private readonly history: History,
    private readonly districts: number,
  ) {
    this.oldest = Array<number>(districts).fill(0);
  }

  /** The oldest and newest tick every district can show. */
  async retained(): Promise<{ oldest: number; newest: number }> {
    const ends = await Promise.all(
      Array.from({ length: this.districts }, async (_, d) => {
        const newest = await this.locate(d, Infinity);
        const first = await this.at(d, this.oldest[d]!);
        if (!newest || !first) throw new SeekError('broken', `district ${d} has no records`);
        return { oldest: first.record.tick, newest: newest.record.tick };
      }),
    );
    return {
      oldest: Math.max(...ends.map((e) => e.oldest)),
      newest: Math.min(...ends.map((e) => e.newest)),
    };
  }

  /**
   * Every district's records from its keyframe up to `tick`, in order, ready for {@link fold}. Throws a
   * {@link SeekError} when `tick` is not retained or has not happened.
   */
  async seek(tick: number): Promise<TickRecord[][]> {
    return Promise.all(Array.from({ length: this.districts }, (_, d) => this.district(d, tick)));
  }

  private async district(d: number, tick: number): Promise<TickRecord[]> {
    const target = await this.locate(d, tick);
    const nearest = (rec: Known | null) => rec?.record.tick;
    if (!target) {
      const first = await this.at(d, this.oldest[d]!);
      throw new SeekError('unretained', `tick ${tick} is no longer kept`, nearest(first));
    }
    if (target.record.tick !== tick) {
      throw new SeekError('future', `tick ${tick} has not happened yet`, target.record.tick);
    }
    let keyframe = await this.at(d, target.record.keyframeOffset);
    if (keyframe?.offset !== target.record.keyframeOffset) keyframe = await this.firstKeyframe(d, tick);
    if (!keyframe?.record.keyframe) throw new SeekError('broken', `district ${d} has no keyframe for tick ${tick}`);
    this.keyframes.set(`${d}:${hourOf(keyframe.record.tick)}`, keyframe);
    trim(this.keyframes, KEYFRAME_CACHE);
    return this.range(d, keyframe.offset, target.offset + 1);
  }

  /** Retention took the keyframe `tick` names: the oldest one left, which is the next hour boundary after the oldest record. */
  private async firstKeyframe(d: number, tick: number): Promise<Known | null> {
    const first = await this.at(d, this.oldest[d]!);
    if (!first) return null;
    const at = Math.ceil(first.record.tick / TICKS_PER_HOUR) * TICKS_PER_HOUR;
    if (at > tick) throw new SeekError('unretained', `tick ${tick} is no longer kept`, at);
    const found = await this.locate(d, at);
    return found?.record.tick === at ? found : null;
  }

  /** The record at `offset`, or null past the log's end. Retention moves `oldest` up as a side effect. */
  private async at(d: number, offset: number): Promise<Known | null> {
    const key = `${d}:${offset}`;
    const hit = this.records.get(key);
    if (hit) {
      this.stats.hits++;
      this.records.delete(key);
      this.records.set(key, hit);
      return hit;
    }
    let page;
    for (;;) {
      const from = Math.max(offset, this.oldest[d]!);
      try {
        this.stats.reads++;
        page = await this.history.read(STREAM, d, from, from + 1);
        break;
      } catch (err) {
        // Retention moves on, and the read goes again from what is left.
        if (!(err instanceof GatewayError) || err.code !== 'trimmed' || err.oldest === undefined) throw err;
        if (err.oldest <= this.oldest[d]!) throw err;
        this.oldest[d] = err.oldest;
      }
    }
    const first = page.records[0];
    const record = first && parse(first.payload);
    if (!first || !record) return null;
    return this.keep(d, first.offset, record);
  }

  private keep(d: number, offset: number, record: TickRecord): Known {
    const known = { offset, record };
    this.records.set(`${d}:${offset}`, known);
    trim(this.records, RECORD_CACHE);
    return known;
  }

  /** What to estimate from: the cached keyframe of `tick`'s hour, else the known record nearest in tick. */
  private async anchor(d: number, tick: number): Promise<Known | null> {
    const hour = this.keyframes.get(`${d}:${hourOf(tick)}`);
    if (hour) return hour;
    let best: Known | null = null;
    for (const [key, known] of this.records) {
      if (!key.startsWith(`${d}:`)) continue;
      if (!best || Math.abs(known.record.tick - tick) < Math.abs(best.record.tick - tick)) best = known;
    }
    if (best) return best;
    const pointer = await keyframeOffset(this.history, d, this.districts);
    return (await this.at(d, pointer)) ?? this.at(d, this.oldest[d]!);
  }

  /**
   * The record of the greatest tick not after `tick`, or null when every record is later. Reads one record at an
   * estimate (a tick a record, from the nearest record known) and corrects, keeping the offsets known to be below and
   * above so a log that is not one record a tick still ends in a search.
   */
  private async locate(d: number, tick: number): Promise<Known | null> {
    let anchor = await this.anchor(d, tick);
    if (!anchor) return null;
    let best: Known | null = null;
    // Offsets from `hi` on are past the log's end or hold later ticks.
    let hi = Infinity;
    let step = 1;
    for (let probes = 0; probes < MAX_PROBES; probes++) {
      const floor = best ? best.offset + 1 : this.oldest[d]!;
      if (floor >= hi) return best;
      // Looking for the newest record (`Infinity`) goes outward from the best known, in growing steps.
      let guess = Number.isFinite(tick) ? anchor.offset + (tick - anchor.record.tick) : (best ?? anchor).offset + step;
      if (!Number.isFinite(tick)) step *= 2;
      if (guess < floor || guess >= hi) {
        // The estimate fell outside what is still possible: go to the middle, or outward from the best known.
        guess = Number.isFinite(hi) ? Math.floor((floor + hi) / 2) : floor + step;
        if (Number.isFinite(tick)) step *= 2;
      }
      const rec = await this.at(d, guess);
      if (!rec) {
        hi = Math.min(hi, guess);
      } else if (rec.record.tick <= tick) {
        if (rec.record.tick === tick) return rec;
        if (!best || rec.offset > best.offset) best = rec;
        anchor = rec;
      } else {
        hi = Math.min(hi, rec.offset);
        anchor = rec;
      }
    }
    throw new SeekError('broken', `district ${d}: tick ${tick} was not found in ${MAX_PROBES} reads`);
  }

  /** Records `from` up to, not including, `end`, in order, one page after another; what is cached is not read again. */
  private async range(d: number, from: number, end: number): Promise<TickRecord[]> {
    const out: TickRecord[] = [];
    let next = from;
    while (next < end) {
      const hit = this.records.get(`${d}:${next}`);
      if (hit) {
        this.stats.hits++;
        out.push(hit.record);
        next++;
        continue;
      }
      this.stats.reads++;
      const page = await this.history.read(STREAM, d, next, end);
      if (page.nextOffset <= next || page.records.length === 0) {
        throw new SeekError('broken', `district ${d}: the log stopped at ${next}, before ${end}`);
      }
      for (const r of page.records) {
        const record = parse(r.payload);
        if (!record) throw new SeekError('broken', `district ${d}: offset ${r.offset} is not a tick`);
        this.keep(d, r.offset, record);
        if (r.offset >= next) out.push(record);
      }
      next = page.nextOffset;
    }
    return out;
  }
}

function trim<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value!);
}

/**
 * Apply a seek's records to a state with nothing in it. Each district starts at a keyframe, which makes the state
 * of its lots whole, and the records after it are the next ticks, so none is a gap.
 */
export function fold(state: CityState, districts: TickRecord[][]): void {
  for (const records of districts) for (const r of records) state.apply(r);
}
