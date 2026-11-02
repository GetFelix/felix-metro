// Playing the city from a moment in the past. Forward, a state folded to a past tick takes each district's records from
// the one after the seek's offset, at the pace of the city's clock, and hands over to the live state when the playhead
// reaches its tip. Backward, the state is refolded from the hour's keyframe to each tick the playhead passes.
import type { CityState, TickRecord } from './city';
import { TICKS_PER_HOUR, type TickClock } from './clock';
import { pastEnd, type Gateway } from './gateway';
import { parse } from './live';
import { Hour, hourStart } from './rewind';
import { fold, SeekError, type SeekResult } from './seek';

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

/**
 * Seconds a fast-forward to live aims to take, whatever the distance, the most ticks a second it will ask for, and the
 * least it closes the gap by so a short one still ends. The reads behind it keep up at the cap: a day takes a few seconds.
 */
const CATCH_UP_SECONDS = 3;
const MAX_CATCH_UP_TPS = 960;
const MIN_CLOSING_TPS = 8;

/** The most wall-clock seconds one frame moves an ordinary playback, so a stalled tab does not leap. A catch-up is not capped. */
const MAX_PLAY_DT = 1;

/** The least time between two refolds of a rewind, so a fast one does not fold on every step and the state trails by a few ticks. */
const FOLD_MS = 30;

/** How often the playback moves on by itself, so the head does not wait for a frame to be drawn. */
const PUMP_MS = 40;

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
  /** What a rewind needs: an empty state to refold into, and to be told when it replaces the one on screen. */
  fresh?(): CityState;
  onState?(next: CityState, seek: SeekResult): void;
  /** The records from the keyframe of the hour holding `tick` up to it; abandoned when `signal` aborts. */
  hourAt?(tick: number, signal: AbortSignal): Promise<SeekResult>;
  /** The oldest tick a rewind can reach. */
  oldest?(): number;
  /** Told when a rewind has gone as far back as the log holds, and stopped. */
  onEdge?(tick: number): void;
}

/** A past state being played, forward or backward. */
export class Playback {
  /** The tick on screen, a fraction; going forward, never more than the newest tick every district has. */
  head: number;
  paused = false;
  /** Racing to the live tip rather than playing at the city's speed. */
  catchingUp = false;
  failure: Error | null = null;
  /** The sim began a new epoch, so the ticks ahead do not continue these. */
  restarted = false;
  /** Ticks a second a catch-up gains on the live tip, fixed when it starts so it ends in about the time promised. */
  private closing = 0;
  /** The tick drawn: `head` once records flow, ahead of it while a catch-up waits for its session, and never back. */
  shown: number;
  /** A catch-up's playhead, which runs ahead of `head` while records are still arriving. */
  private pace: number;
  private pumps: Pump[] = [];
  private source: Source | null = null;
  private fail: (err: Error) => void;
  private closed = false;
  private readonly stop = new AbortController();
  private _rate = 1;
  /** Where each district's records go on from: the offset and tick of the last one the state holds. */
  private cursor: { offset: number; tick: number }[];
  /** The hour on screen, for refolding; and the one before it once fetched or being fetched. */
  private hour: Hour;
  private earlier: Hour | null = null;
  private fetching = false;
  /** The oldest tick a rewind may reach, raised when the log is found not to hold more. */
  private floor = 0;
  private foldedAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStep = performance.now();
  /** performance.now() when the playback began, when it got its session, and when it first applied a record. */
  readonly marks: { began: number; attached: number | null; applied: number | null } = {
    began: performance.now(),
    attached: null,
    applied: null,
  };

  /** With no `source` the playback has no records yet: a catch-up still advances the tick drawn until {@link attach}. */
  constructor(
    source: Source | null,
    /** The state on screen; a rewind replaces it, telling {@link PlaybackOptions.onState}. */
    public state: CityState,
    from: SeekResult,
    private readonly options: PlaybackOptions,
  ) {
    this.head = this.shown = this.pace = from.tick;
    this.cursor = from.districts.map((d) => ({ offset: d.offset, tick: from.tick }));
    this.hour = Hour.from(from);
    this.fail = (err) => {
      this.failure ??= err;
      this.options.onFail?.(err);
    };
    if (source) this.attach(source);
  }

  get attached(): boolean {
    return this.source !== null;
  }

  /** Multiples of the city's own speed; negative plays the past backwards. */
  get rate(): number {
    return this._rate;
  }

  /** A negative rate is ignored when the playback was given no way to refold. */
  set rate(rate: number) {
    if (rate < 0 && !(this.options.fresh && this.options.onState && this.options.hourAt)) return;
    const was = this._rate;
    this._rate = rate;
    if (rate < 0 === was < 0) return;
    if (rate < 0) {
      for (const p of this.pumps) p.close();
      this.pumps = [];
      this.fetchEarlier();
    } else {
      this.openPumps();
    }
  }

  /** Start taking records from `source`, from the seek's offsets. */
  attach(source: Source): void {
    if (this.attached) return;
    this.source = source;
    this.marks.attached = performance.now();
    if (this._rate >= 0) this.openPumps();
  }

  private openPumps(): void {
    if (!this.source) return;
    this.pumps = this.cursor.map((c, i) => new Pump(this.source!, i, c, this.options.tail, this.fail));
    for (const p of this.pumps) p.refill();
  }

  /**
   * Move on by the wall-clock time since the last step. A frame and the timer both call it, so the head advances at the
   * same pace whichever runs, and a slow renderer does not slow the catch-up.
   */
  step(): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastStep) / 1000);
    this.lastStep = now;
    this.advance(dt);
  }

  /** Step every {@link PUMP_MS} until closed, calling `after` each time (to notice the tip, for one). */
  run(after: () => void): void {
    if (this.timer) return;
    this.lastStep = performance.now();
    this.timer = setInterval(() => {
      this.step();
      after();
    }, PUMP_MS);
  }

  /** Race to the live tip in about {@link CATCH_UP_SECONDS}, however far back the playhead is. */
  catchUp(): void {
    if (this._rate < 0) this.rate = 1;
    // A rewind moved the head below the pace a forward play left behind.
    this.pace = this.head;
    const gap = Math.max(0, this.options.tail() - this.head);
    this.closing = Math.max(MIN_CLOSING_TPS, gap / CATCH_UP_SECONDS);
    this.catchingUp = true;
    this.paused = false;
  }

  /**
   * The playhead's pace in ticks a second. A catch-up goes at the city's own pace, which the live tip also advances at
   * (read afresh each time), plus a steady gain on it, so a tip that keeps moving is still reached.
   */
  private speed(): number {
    const own = Math.max(1, this.state.speed) * Math.abs(this._rate);
    if (!this.catchingUp) return own;
    return Math.min(MAX_CATCH_UP_TPS, own + this.closing);
  }

  /** Records waiting ahead of the playhead, per district. */
  get queued(): number[] {
    return this.pumps.map((p) => p.queue.length);
  }

  /** Whether the playhead has reached the live tip's render delay: time to hand over. */
  get atTip(): boolean {
    return this.head >= this.options.tail() - JOIN_LAG;
  }

  /** Move the playhead on `dt` seconds and take the records it has come to. */
  advance(dt: number): void {
    if (this.failure) return;
    if (this._rate < 0) return this.rewind(dt);
    // A catch-up keeps to wall-clock time: a slow frame covers the ticks it owes, or the race takes longer on a slow device.
    const step = this.catchingUp ? dt : Math.min(dt, MAX_PLAY_DT);
    const base = this.catchingUp ? Math.max(this.head, this.pace) : this.head;
    const target = this.paused ? this.head : base + step * this.speed();
    if (this.catchingUp) this.pace = target;
    if (this.attached) {
      this.apply(Math.floor(target) + APPLY_AHEAD);
      // Not past what every district has, so a district still reading holds the others back.
      this.head = Math.max(this.head, Math.min(target, this.state.latest));
    }
    // Before the session is open the tick drawn runs on without the records, but never past the live render delay.
    const racing = this.attached ? this.head : Math.min(target, this.options.tail() - JOIN_LAG);
    this.shown = Math.max(this.shown, this.head, racing);
  }

  private apply(limit: number): void {
    for (const pump of this.pumps) {
      while (pump.queue.length > 0 && pump.queue[0]!.record.tick <= limit) {
        const { offset, record } = pump.queue.shift()!;
        // A restarted sim numbers its ticks from the start again, below the playhead, which cannot follow it.
        const had = this.state.epochOf(record.district);
        if (had >= 0 && record.epoch > had) {
          // An earlier failure keeps its reason.
          if (!this.failure) {
            this.restarted = true;
            this.failure = new Error('the city restarted');
          }
          this.options.onFail?.(this.failure);
          return;
        }
        this.marks.applied ??= performance.now();
        if (this.state.apply(record) === 'gap') {
          this.failure ??= new Error(`district ${record.district} skipped to tick ${record.tick}`);
          this.options.onFail?.(this.failure);
          return;
        }
        this.cursor[record.district] = { offset, tick: record.tick };
        this.hour.add(record.district, offset, record);
      }
      pump.refill();
    }
  }

  /**
   * Move the playhead back `dt` seconds and refold the state to it. The state is rebuilt from the hour's keyframe, so
   * it is exact at any tick; the hour before is fetched ahead, and the playhead waits at the keyframe if it is not here.
   */
  private rewind(dt: number): void {
    // A stop settles the state on the tick drawn, which a throttled refold may have left a few ticks off.
    if (this.paused)
      return void (this.enter(Math.floor(this.head)) && this.refold(Math.floor(this.head) + APPLY_AHEAD, true));
    const floor = Math.max(this.floor, this.options.oldest?.() ?? 0);
    const goal = Math.max(floor, this.head - Math.min(dt, MAX_PLAY_DT) * Math.max(1, this.state.speed) * -this._rate);
    let at = goal;
    if (!this.enter(Math.floor(goal))) {
      // The hour before is not here: run on to this one's keyframe and wait there.
      const start = this.hour.start;
      if (start === null || this.head <= start) return;
      at = Math.max(goal, start);
    }
    this.refold(Math.floor(at) + APPLY_AHEAD);
    this.head = this.shown = at;
    if (at <= floor) {
      this.paused = true;
      this.options.onEdge?.(floor);
    }
  }

  /** Make the hour holding `tick` the one on hand; false while it is still being fetched. */
  private enter(tick: number): boolean {
    if (this.hour.covers(tick)) return true;
    if (this.earlier?.covers(tick)) {
      this.hour = this.earlier;
      this.earlier = null;
      this.fetchEarlier();
      return true;
    }
    this.fetchEarlier(tick);
    return false;
  }

  /** Fetch the hour before the one on hand, or the one holding `tick` when that is wanted at once. */
  private fetchEarlier(tick?: number): void {
    if (this.fetching || this.closed || !this.options.hourAt) return;
    const next = tick ?? (this.hour.start ?? hourStart(this.head)) - 1;
    const floor = Math.max(this.floor, this.options.oldest?.() ?? 0);
    if (next < floor || next < 0 || (tick === undefined && this.earlier?.covers(next))) return;
    this.fetching = true;
    this.options.hourAt(next, this.stop.signal).then(
      (seek) => {
        this.fetching = false;
        if (!this.closed) this.earlier = Hour.from(seek);
      },
      (err) => {
        this.fetching = false;
        if (this.closed) return;
        // Retention has taken the hour: a rewind stops where the log now begins.
        const bound = err instanceof SeekError && err.reason === 'unretained' ? (err.nearest ?? this.hour.start) : null;
        if (bound !== null) this.floor = bound;
        else this.fail(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  /** Fold the state to `tick` of the hour on hand, unless it is there or, without `force`, was folded a moment ago. */
  private refold(tick: number, force = false): void {
    const at = this.hour.tickAt(tick);
    if (at === null || at === this.state.latest) return;
    if (!force && performance.now() - this.foldedAt < FOLD_MS) return;
    const seek = this.hour.at(tick)!;
    try {
      const next = this.options.fresh!();
      fold(next, seek);
      this.state = next;
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.foldedAt = performance.now();
    this.cursor = seek.districts.map((d) => ({ offset: d.offset, tick: seek.tick }));
    this.options.onState!(this.state, seek);
  }

  /** Stop listening. The state keeps what was applied. */
  close(): void {
    this.closed = true;
    this.stop.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.pumps) p.close();
    this.options.release?.();
  }
}

/**
 * Hand the clock the playhead's tick so that the live view picks up from where the city was drawn, with no jump in the
 * cars under way. Returns the tick.
 */
export function handOver(playback: Playback, clock: TickClock): number {
  clock.now = Math.max(playback.head, playback.shown);
  return clock.now;
}
