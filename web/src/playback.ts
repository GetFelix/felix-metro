// Playing the city forward from a moment in the past until it is the live city. A state folded to a past tick takes
// each district's records from the one after the seek's offset, at the pace of the city's clock, and hands over to the
// live state when the playhead reaches its tip.
import type { CityState, TickRecord } from './city';
import { TICKS_PER_HOUR, type TickClock } from './clock';
import { pastEnd, type Gateway } from './gateway';
import { parse } from './live';
import type { SeekResult } from './seek';

const STREAM = 'events';

/** What playback needs of a gateway session. */
export type Source = Pick<Gateway, 'read' | 'subscribe'>;

/** Records a district keeps queued ahead of the playhead; fewer than this and it reads or listens for more. */
export const AHEAD_RECORDS = 480;

/** A subscription's frames queue up to this many: the read-ahead and the backlog of an hour, which arrives at once. */
const LISTEN_ROOM = AHEAD_RECORDS + TICKS_PER_HOUR;

/** Ticks past the playhead whose records are applied, so a car about to leave is already known. */
const APPLY_AHEAD = 2;

/** The live clock's render delay: the playhead joins it this many ticks behind the live tip. */
export const JOIN_LAG = 1;

/** Seconds a fast-forward to live takes, whatever the distance, and the most ticks a second it will ask for. */
const CATCH_UP_SECONDS = 3;
const MAX_CATCH_UP_TPS = 480;

const slot = (district: number) => `p${String(district).padStart(2, '0')}`;

interface Queued {
  offset: number;
  record: TickRecord;
}

/**
 * One district's records after the seek, in order. Far from the log's tail it reads pages ahead of the playhead; within
 * an hour of the tail it subscribes from the next offset, which delivers the rest and then the live ones.
 */
class Pump {
  readonly queue: Queued[] = [];
  /** The offset of the next record to read or subscribe from. */
  private next: number;
  private mode: 'reading' | 'subscribed' = 'reading';
  /** A subscription that fell behind or skipped is not trusted again until a read has reached the tail. */
  private distrust = false;
  private stale = false;
  private busy = false;
  private generation = 0;
  private lastTick: number;
  closed = false;

  constructor(
    private readonly source: Source,
    private readonly district: number,
    after: { offset: number; tick: number },
    private readonly tail: () => number,
    private readonly fail: (err: Error) => void,
  ) {
    this.next = after.offset + 1;
    this.lastTick = after.tick;
  }

  /** Top the queue up if it has room; safe to call as often as the caller likes. */
  refill(): void {
    if (this.closed || this.busy) return;
    if (this.mode === 'subscribed') {
      // Frames dropped for want of room are read again once the queue has drained.
      if (this.stale && this.queue.length < AHEAD_RECORDS / 2) {
        this.stale = false;
        this.distrust = true;
        this.mode = 'reading';
        this.generation++;
      } else return;
    }
    if (this.queue.length >= AHEAD_RECORDS) return;
    this.busy = true;
    this.fill().then(
      () => (this.busy = false),
      (err) => {
        this.busy = false;
        if (!this.closed) this.fail(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  private async fill(): Promise<void> {
    while (!this.closed && this.mode === 'reading' && this.queue.length < AHEAD_RECORDS) {
      if (!this.distrust && this.tail() - this.lastTick <= TICKS_PER_HOUR) return this.listen();
      const from = this.next;
      let page;
      try {
        page = await this.source.read(STREAM, this.district, from);
      } catch (err) {
        // Nothing yet past the log's end: this is the tail.
        if (pastEnd(err)) {
          this.distrust = false;
          return this.listen();
        }
        throw err;
      }
      if (this.closed) return;
      for (const r of page.records) {
        if (r.offset < from) continue;
        const record = parse(r.payload);
        if (!record) continue;
        this.push(r.offset, record);
      }
      if (page.nextOffset <= from) {
        this.distrust = false;
        return this.listen();
      }
      this.next = Math.max(this.next, page.nextOffset);
    }
  }

  private push(offset: number, record: TickRecord): void {
    this.queue.push({ offset, record });
    this.next = offset + 1;
    this.lastTick = record.tick;
  }

  private async listen(): Promise<void> {
    const generation = ++this.generation;
    this.mode = 'subscribed';
    await this.source.subscribe(STREAM, slot(this.district), this.district, this.next, (frame) => {
      if (this.closed || generation !== this.generation || frame.offset === null) return;
      if (frame.offset < this.next) return;
      if (frame.skippedBefore > 0 || frame.offset !== this.next || this.queue.length >= LISTEN_ROOM) {
        this.stale = true;
        return;
      }
      // A stale subscription keeps its place in the order by taking nothing more until it is replaced.
      if (this.stale) return;
      const record = parse(frame.payload);
      if (record) this.push(frame.offset, record);
      else this.next = frame.offset + 1;
    });
  }

  close(): void {
    this.closed = true;
    this.generation++;
  }
}

export interface PlaybackOptions {
  /** The newest tick the live view has: where the playback is headed. */
  tail(): number;
  /** Told when playback cannot go on, such as retention taking the records it still needed. */
  onFail?(err: Error): void;
  /** Called by {@link Playback.close}, to end the session the pumps listen on. */
  release?(): void;
}

/** A past state being played forward. */
export class Playback {
  /** The tick on screen, a fraction; never more than the newest tick every district has. */
  head: number;
  /** Multiples of the city's own speed. */
  rate = 1;
  paused = false;
  /** Racing to the live tip rather than playing at the city's speed. */
  catchingUp = false;
  failure: Error | null = null;
  /** Ticks a second the catch-up asked for, or 0. */
  private catchUpTps = 0;
  private readonly pumps: Pump[];

  constructor(
    source: Source,
    readonly state: CityState,
    from: SeekResult,
    private readonly options: PlaybackOptions,
  ) {
    this.head = from.tick;
    const fail = (err: Error) => {
      this.failure ??= err;
      options.onFail?.(err);
    };
    this.pumps = from.districts.map(
      (d, i) => new Pump(source, i, { offset: d.offset, tick: from.tick }, options.tail, fail),
    );
    for (const p of this.pumps) p.refill();
  }

  /** Race to the live tip in about {@link CATCH_UP_SECONDS}, however far back the playhead is. */
  catchUp(): void {
    const gap = Math.max(0, this.options.tail() - this.head);
    this.catchingUp = true;
    this.paused = false;
    this.catchUpTps = Math.min(MAX_CATCH_UP_TPS, this.speed() + gap / CATCH_UP_SECONDS);
  }

  /** The playhead's pace in ticks a second. */
  private speed(): number {
    return this.catchingUp ? this.catchUpTps : Math.max(1, this.state.speed) * this.rate;
  }

  /** Whether the playhead has reached the live tip's render delay: time to hand over. */
  get atTip(): boolean {
    return this.head >= this.options.tail() - JOIN_LAG;
  }

  /** Move the playhead on `dt` seconds and take the records it has come to. */
  advance(dt: number): void {
    if (this.failure) return;
    const target = this.paused ? this.head : this.head + dt * this.speed();
    this.apply(Math.floor(target) + APPLY_AHEAD);
    // Not past what every district has, so a district still reading holds the others back.
    this.head = Math.max(this.head, Math.min(target, this.state.latest));
  }

  private apply(limit: number): void {
    for (const pump of this.pumps) {
      while (pump.queue.length > 0 && pump.queue[0]!.record.tick <= limit) {
        const { record } = pump.queue.shift()!;
        if (this.state.apply(record) === 'gap') {
          this.failure ??= new Error(`district ${record.district} skipped to tick ${record.tick}`);
          this.options.onFail?.(this.failure);
          return;
        }
      }
      pump.refill();
    }
  }

  /** Stop listening. The state keeps what was applied. */
  close(): void {
    for (const p of this.pumps) p.close();
    this.options.release?.();
  }
}

/**
 * Hand the clock the playhead's tick so that the live view picks up from where the city was drawn, with no jump in the
 * cars under way. Returns the tick.
 */
export function handOver(playback: Playback, clock: TickClock): number {
  clock.now = playback.head;
  return playback.head;
}
