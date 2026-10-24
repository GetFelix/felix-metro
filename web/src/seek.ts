// Time travel: finding the city at any retained tick. Each district's log is ordered by (epoch, tick), usually one
// record a tick but not always: a restarted sim takes the next epoch and a retried tick can land twice. The record for
// a tick is found by reads that correct an estimate, its header names the keyframe it folds from, and the records from
// that keyframe to the tick are read in ranges and folded in order.
import type { CityState, TickRecord } from './city';
import { GatewayError, type Gateway, type Page } from './gateway';
import { keyframePointer, parse } from './live';
import { TICKS_PER_HOUR } from './clock';

const STREAM = 'events';

/** The part of a gateway session a seek needs; the history connection is one. */
export type History = Pick<Gateway, 'read' | 'stateGet'>;

/** Records kept per district, by offset: two city hours, the neighbourhood a scrub stays in. */
const RECORDS_PER_DISTRICT = 2 * TICKS_PER_HOUR;
/** Keyframes kept per district, by hour: four city days of 24 hours. */
const KEYFRAMES_PER_DISTRICT = 4 * 24;
/** A search that has not found its record in this many reads is not converging; the log is not what was assumed. */
const MAX_PROBES = 48;
/** Reads of one range sent at once, once the size of a page is known. */
const PARALLEL_PAGES = 16;
/** Rounds of seeking while retention moves under it, or while districts settle on one tick. */
const MAX_ROUNDS = 8;

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

/** Retention took what a seek had found; the round starts again from what is left. */
class Restart extends Error {}

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
  /** Time spent waiting on gateway reads, summed and the slowest one, in ms. */
  readMs: number;
  slowestMs: number;
  /** Records in the first page of the last range read. */
  pageSize: number;
}

export interface DistrictSeek {
  /** The records from the district's keyframe to the tick, in order, ready for {@link fold}. */
  records: TickRecord[];
  /** The offset of the tick's record: a live subscription resumes at the one after. */
  offset: number;
}

export interface SeekResult {
  /** The tick every district is at. */
  tick: number;
  /** The tick asked for; later than `tick` when the log has none for it and the nearest earlier one is shown. */
  requested: number;
  exact: boolean;
  districts: DistrictSeek[];
}

export interface SeekOptions {
  /** Aborting stops the seek and takes its reads out of the gateway's queue. */
  signal?: AbortSignal;
}

interface Found {
  rec: Known | null;
  /** The tick is later than the district's newest, which `rec` is. */
  future: boolean;
}

/** A read on the wire that every caller of the same range shares; it is cancelled when the last of them leaves. */
interface Flight {
  promise: Promise<Page>;
  users: number;
  cancel: AbortController;
}

/** One long-lived seeker per page: its session and caches carry from one seek to the next. */
export class Seeker {
  readonly stats: SeekStats = { reads: 0, hits: 0, readMs: 0, slowestMs: 0, pageSize: 0 };
  private readonly records: Map<number, Known>[];
  private readonly keyframes: Map<number, Known>[];
  /** The oldest offset retention has left, by district; 0 until a read says otherwise. */
  private readonly oldest: number[];
  private readonly sessions: readonly History[];
  private turn = 0;
  private readonly flights = new Map<string, Flight>();
  private current: AbortController | null = null;

  constructor(
    history: History | readonly History[],
    private readonly districts: number,
  ) {
    this.sessions = Array.isArray(history) ? history : [history as History];
    this.records = Array.from({ length: districts }, () => new Map());
    this.keyframes = Array.from({ length: districts }, () => new Map());
    this.oldest = Array<number>(districts).fill(0);
  }

  /** The oldest tick every district can start from and the newest tick every district has. */
  async retained(options: SeekOptions = {}): Promise<{ oldest: number; newest: number }> {
    const signal = options.signal ?? new AbortController().signal;
    const ends = await Promise.all(
      Array.from({ length: this.districts }, async (_, d) => {
        const first = await this.at(d, 0, signal);
        if (!first) throw new SeekError('broken', `district ${d} has no records`);
        const newest = await this.newest(d, signal);
        return { oldest: seekable(first.record), newest: newest.record.tick };
      }),
    );
    return {
      oldest: Math.max(...ends.map((e) => e.oldest)),
      newest: Math.min(...ends.map((e) => e.newest)),
    };
  }

  /**
   * The city at `tick`: every district's records from its keyframe up to it, and the offset of its record. A newer
   * seek cancels one still running. A tick the log has no record for shows the nearest earlier one that every district
   * has (`exact` false). Throws a {@link SeekError} when `tick` is not retained or has not happened.
   */
  async seek(tick: number, options: SeekOptions = {}): Promise<SeekResult> {
    const mine = new AbortController();
    this.current?.abort(new DOMException('a newer seek replaced this one', 'AbortError'));
    this.current = mine;
    const outer = options.signal;
    if (outer?.aborted) mine.abort(outer.reason);
    else outer?.addEventListener('abort', () => mine.abort(outer.reason), { once: true });
    try {
      return await this.run(tick, mine.signal);
    } finally {
      if (this.current === mine) this.current = null;
    }
  }

  private async run(requested: number, signal: AbortSignal): Promise<SeekResult> {
    let target = requested;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      signal.throwIfAborted();
      try {
        const found = await Promise.all(Array.from({ length: this.districts }, (_, d) => this.find(d, target, signal)));
        if (found.some((f) => f.rec === null)) {
          const firsts = await Promise.all(
            Array.from({ length: this.districts }, (_, d) => this.firstSeekable(d, signal)),
          );
          throw new SeekError(
            'unretained',
            `tick ${requested} is no longer kept`,
            Math.max(...firsts.map((t) => t ?? 0)),
          );
        }
        const ticks = found.map((f) => f.rec!.record.tick);
        const lowest = Math.min(...ticks);
        if (found.some((f) => f.future)) {
          throw new SeekError('future', `tick ${requested} has not happened yet`, lowest);
        }
        // A district that skipped a tick the others have settles every district on the earlier one all of them hold.
        if (ticks.some((t) => t !== lowest)) {
          target = lowest;
          continue;
        }
        const districts = await Promise.all(found.map((f, d) => this.build(d, f.rec!, signal)));
        return { tick: lowest, requested, exact: lowest === requested, districts };
      } catch (err) {
        if (!(err instanceof Restart)) throw err;
      }
    }
    throw new SeekError('broken', `tick ${requested} was not settled in ${MAX_ROUNDS} rounds`);
  }

  /** The record a district shows for `tick`: the greatest not after it in the newest epoch that reaches it. */
  private async find(d: number, tick: number, signal: AbortSignal): Promise<Found> {
    const newest = await this.newest(d, signal);
    if (tick > newest.record.tick) return { rec: newest, future: true };
    let epoch = newest.record.epoch;
    for (;;) {
      const rec = await this.locate(d, epoch, tick, signal);
      // Every record of this epoch is later: the tick belongs to an epoch before it, if any kept it.
      if (rec && rec.record.epoch < epoch) {
        epoch = rec.record.epoch;
        continue;
      }
      return { rec, future: false };
    }
  }

  private async build(d: number, target: Known, signal: AbortSignal): Promise<DistrictSeek> {
    let start = target.record.keyframeOffset;
    // Retention has already taken the keyframe the record names: begin at the oldest one left.
    if (start < this.oldest[d]!) {
      const first = await this.firstKeyframe(d, target, signal);
      if (!first) throw new SeekError('broken', `district ${d} has no keyframe for tick ${target.record.tick}`);
      start = first.offset;
    }
    // The range starts at the keyframe itself, so reading it is not a trip of its own.
    const records = await this.range(d, start, target.offset + 1, signal);
    const keyframe = records[0];
    if (!keyframe?.keyframe) {
      throw new SeekError('broken', `district ${d} has no keyframe for tick ${target.record.tick}`);
    }
    const frames = this.keyframes[d]!;
    frames.delete(hourOf(keyframe.tick));
    frames.set(hourOf(keyframe.tick), { offset: start, record: keyframe });
    trim(frames, KEYFRAMES_PER_DISTRICT);
    const last = records.at(-1);
    if (last?.tick !== target.record.tick || last.epoch !== target.record.epoch) {
      throw new SeekError(
        'broken',
        `district ${d}: the records from the keyframe do not end at tick ${target.record.tick}`,
      );
    }
    return { records, offset: target.offset };
  }

  /** Retention took the keyframe the record names: the oldest one left. */
  private async firstKeyframe(d: number, target: Known, signal: AbortSignal): Promise<Known | null> {
    const first = await this.at(d, this.oldest[d]!, signal);
    if (!first) return null;
    const at = seekable(first.record);
    if (at > target.record.tick) {
      throw new SeekError('unretained', `tick ${target.record.tick} is no longer kept`, at);
    }
    const found = await this.locate(d, target.record.epoch, at, signal);
    return found?.record.tick === at ? found : null;
  }

  /** The first tick the district can start a fold from, or null for an empty log. */
  private async firstSeekable(d: number, signal: AbortSignal): Promise<number | null> {
    const first = await this.at(d, this.oldest[d]!, signal);
    return first ? seekable(first.record) : null;
  }

  /** The newest record. The state read says how long the log was when it answered, which two reads confirm. */
  private async newest(d: number, signal: AbortSignal): Promise<Known> {
    const { asOf } = await keyframePointer(this.cancellable(signal), d, this.districts, false);
    if (asOf !== null && asOf > 0) {
      const [last, past] = await Promise.all([this.at(d, asOf - 1, signal), this.at(d, asOf, signal)]);
      if (last && last.offset === asOf - 1 && !past) return last;
    }
    const found = await this.locate(d, Infinity, Infinity, signal);
    if (!found) throw new SeekError('broken', `district ${d} has no records`);
    return found;
  }

  /** Reads take the sessions in turn: each allows four in flight, so a district's pages use all of them. */
  private session(): History {
    return this.sessions[this.turn++ % this.sessions.length]!;
  }

  /** The session as the pointer lookup reads it: its reads share and stop with the seek, and a trimmed start says so. */
  private cancellable(signal: AbortSignal): History {
    return {
      stateGet: (stream, key, entity) =>
        new Promise((resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          this.session().stateGet(stream, key, entity).then(resolve, reject);
        }),
      read: async (_stream, shard, from, end) => this.read(shard, from, end ?? from + 1, false, signal),
    };
  }

  /** Retention moved up to `oldest`: forget what is below it. */
  private trimTo(d: number, oldest: number): void {
    this.oldest[d] = oldest;
    for (const cache of [this.records[d]!, this.keyframes[d]!]) {
      for (const [key, known] of cache) if (known.offset < oldest) cache.delete(key);
    }
  }

  /** The record at `offset`, or null past the log's end. Retention moves `oldest` up as a side effect. */
  private async at(d: number, offset: number, signal: AbortSignal): Promise<Known | null> {
    const from = Math.max(offset, this.oldest[d]!);
    const cache = this.records[d]!;
    const hit = cache.get(from);
    if (hit) {
      this.stats.hits++;
      // Most recently used last, so what trimming drops is the least recently used.
      cache.delete(from);
      cache.set(from, hit);
      return hit;
    }
    const page = await this.read(d, from, from + 1, false, signal);
    const first = page.records[0];
    if (!first) return null;
    return this.keep(d, first.offset, this.decode(d, first));
  }

  private decode(d: number, r: { offset: number; payload: Uint8Array }): TickRecord {
    const record = parse(r.payload);
    if (!record) throw new SeekError('broken', `district ${d}: offset ${r.offset} is not a tick`);
    if (record.district !== d) {
      throw new SeekError('broken', `district ${d}: offset ${r.offset} holds district ${record.district}'s tick`);
    }
    return record;
  }

  private keep(d: number, offset: number, record: TickRecord): Known {
    const known = { offset, record };
    const cache = this.records[d]!;
    cache.delete(offset);
    cache.set(offset, known);
    trim(cache, RECORDS_PER_DISTRICT);
    return known;
  }

  /**
   * One read, sent again when retention moves under it. A read that is not `strict` starts from what is left; a strict
   * one is building on its start, so retention passing it restarts the round.
   */
  private async read(d: number, from: number, end: number, strict: boolean, signal: AbortSignal): Promise<Page> {
    for (;;) {
      const start = Math.max(from, this.oldest[d]!);
      if (strict && start > from) throw new Restart();
      try {
        return await this.flight(d, start, Math.max(end, start + 1), signal);
      } catch (err) {
        if (!(err instanceof GatewayError) || err.code !== 'trimmed' || err.oldest === undefined) throw err;
        if (err.oldest <= this.oldest[d]!) throw err;
        this.trimTo(d, err.oldest);
      }
    }
  }

  /** The gateway read for a range, shared with any identical read already on its way. */
  private flight(d: number, from: number, end: number, signal: AbortSignal): Promise<Page> {
    signal.throwIfAborted();
    const key = `${d}:${from}:${end}`;
    let flight = this.flights.get(key);
    if (!flight) {
      const cancel = new AbortController();
      const sent = performance.now();
      const promise = this.session().read(STREAM, d, from, end, cancel.signal);
      flight = { promise, users: 0, cancel };
      this.stats.reads++;
      this.flights.set(key, flight);
      const made = flight;
      const done = () => {
        const took = performance.now() - sent;
        this.stats.readMs += took;
        this.stats.slowestMs = Math.max(this.stats.slowestMs, took);
        if (this.flights.get(key) === made) this.flights.delete(key);
      };
      promise.then(done, done);
    }
    const shared = flight;
    shared.users++;
    return new Promise<Page>((resolve, reject) => {
      const leave = () => {
        reject(signal.reason);
        if (--shared.users === 0) shared.cancel.abort(signal.reason);
      };
      signal.addEventListener('abort', leave, { once: true });
      shared.promise.then(
        (page) => {
          signal.removeEventListener('abort', leave);
          resolve(page);
        },
        (err) => {
          signal.removeEventListener('abort', leave);
          reject(err);
        },
      );
    });
  }

  /** What to estimate from: the cached keyframe of the tick's hour, else the known record nearest to it. */
  private async anchor(d: number, epoch: number, tick: number, signal: AbortSignal): Promise<Known | null> {
    const frame = this.keyframes[d]!.get(hourOf(tick));
    if (frame && frame.record.epoch === epoch && frame.offset >= this.oldest[d]!) return frame;
    let best: Known | null = null;
    for (const known of this.records[d]!.values()) {
      if (!best) best = known;
      else if (Number.isFinite(tick)) {
        if (distance(known.record, epoch, tick) < distance(best.record, epoch, tick)) best = known;
      } else if (known.offset > best.offset) best = known;
    }
    if (best) return best;
    return this.at(d, this.oldest[d]!, signal);
  }

  /**
   * The record of the greatest `(epoch, tick)` not after the one given, or null when every record is later. Reads one
   * record at an estimate (a tick a record, from the nearest record known in that epoch) and corrects, keeping the
   * offsets known to be below and above so a log that is not one record a tick still ends in a search.
   */
  private async locate(d: number, epoch: number, tick: number, signal: AbortSignal): Promise<Known | null> {
    // Negative when the record is before the key, zero at it.
    const order = (r: TickRecord) => (r.epoch !== epoch ? Math.sign(r.epoch - epoch) : Math.sign(r.tick - tick));
    let anchor = await this.anchor(d, epoch, tick, signal);
    if (!anchor) return null;
    let best: Known | null = null;
    // Offsets from `hi` on are past the log's end or hold later records.
    let hi = Infinity;
    let step = 1;
    for (let probes = 0; probes < MAX_PROBES; probes++) {
      signal.throwIfAborted();
      if (best && best.offset < this.oldest[d]!) best = null;
      const floor = Math.max(best ? best.offset + 1 : 0, this.oldest[d]!);
      if (floor >= hi) return best;
      let guess = NaN;
      // An estimate is worth making only inside one epoch, where ticks count up from the anchor; every fourth probe
      // bisects regardless, so a log that keeps defeating the estimate still converges.
      if (anchor.record.epoch === epoch && Number.isFinite(tick) && probes % 4 !== 3) {
        guess = anchor.offset + (tick - anchor.record.tick);
      }
      if (!(guess >= floor && guess < hi)) {
        if (Number.isFinite(hi)) {
          guess = Math.floor((floor + hi) / 2);
        } else {
          // No end known yet: outward from the best known, in growing steps.
          guess = Math.max(floor, (best ?? anchor).offset + step);
          step *= 2;
        }
      }
      const rec = await this.at(d, guess, signal);
      if (!rec) {
        hi = Math.min(hi, guess);
        continue;
      }
      const side = order(rec.record);
      if (side === 0) return rec;
      if (side < 0) {
        if (!best || rec.offset > best.offset) best = rec;
      } else {
        hi = Math.min(hi, rec.offset);
      }
      anchor = rec;
    }
    throw new SeekError('broken', `district ${d}: tick ${tick} was not found in ${MAX_PROBES} reads`);
  }

  /**
   * Records `from` up to, not including, `end`, in order. The first page says how many records a page holds; the rest
   * are then read together. What is cached is not read again.
   */
  private async range(d: number, from: number, end: number, signal: AbortSignal): Promise<TickRecord[]> {
    const cache = this.records[d]!;
    const got = new Map<number, TickRecord>();
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      let next = from;
      while (next < end && (got.has(next) || cache.has(next))) next++;
      if (next >= end) break;
      const starts = [next];
      if (size > 0) {
        for (let s = next + size; s < end && starts.length < PARALLEL_PAGES; s += size) starts.push(s);
      }
      // The range starts at the keyframe, the point of it: if retention takes any of it, the round starts again.
      const pages = await Promise.all(
        starts.map((s) => this.read(d, s, size > 0 ? Math.min(s + size, end) : end, true, signal)),
      );
      pages.forEach((page, i) => {
        const start = starts[i]!;
        if (page.nextOffset <= start || page.records.length === 0) {
          throw new SeekError('broken', `district ${d}: the log stopped at ${start}, before ${end}`);
        }
        if (size === 0) size = this.stats.pageSize = page.nextOffset - start;
        for (const r of page.records) {
          const record = this.decode(d, r);
          this.keep(d, r.offset, record);
          got.set(r.offset, record);
        }
      });
    }
    const out: TickRecord[] = [];
    for (let o = from; o < end; o++) {
      const record = got.get(o) ?? cache.get(o)?.record;
      if (!record) throw new SeekError('broken', `district ${d}: offset ${o} was not read`);
      if (!got.has(o)) this.stats.hits++;
      out.push(record);
    }
    return out;
  }
}

/** The first tick a fold can start from in a log whose oldest record is `first`: a keyframe, so an hour boundary. */
function seekable(first: TickRecord): number {
  return first.keyframe ? first.tick : Math.ceil(first.tick / TICKS_PER_HOUR) * TICKS_PER_HOUR;
}

/** How far a record is from a key, for choosing what to estimate from; another epoch is further than any tick. */
function distance(r: TickRecord, epoch: number, tick: number): number {
  return r.epoch !== epoch ? Number.MAX_SAFE_INTEGER : Math.abs(r.tick - tick);
}

function trim<V>(map: Map<number, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value!);
}

/**
 * Apply a seek to a state with nothing in it. Each district starts at a keyframe, which makes the state of its lots
 * whole, and the records after it are the next ticks. Throws when a district did not end at the tick the seek
 * found, so a short fold is never shown.
 */
export function fold(state: CityState, seek: SeekResult): void {
  for (const { records } of seek.districts) for (const r of records) state.apply(r, true);
  state.ticks.forEach((tick, d) => {
    if (tick !== seek.tick) throw new SeekError('broken', `district ${d} folded to tick ${tick}, not ${seek.tick}`);
  });
}
