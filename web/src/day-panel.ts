// The panel behind the follow card's list of a day: which day it shows, reading that day from the log, keeping it
// current while the city is live, and seeking when a row is chosen. The card draws what it is given.
import type { TickRecord } from './city';
import { TICKS_PER_DAY } from './clock';
import { SLACK, DayLog, currentRow, dayOf, rows, type DayRow } from './day';

/** What the card draws for a resident's day. */
export interface DayView {
  /** `unavailable`: there is no log to read; the card falls back to the schedule. */
  status: 'loading' | 'ready' | 'unavailable' | 'unretained' | 'failed';
  /** Which day, such as "Day 3, today". */
  label: string;
  canPrev: boolean;
  canNext: boolean;
  rows: DayRow[];
  /** The row they are in at the tick on screen, or null. */
  current: number | null;
  /** Something to say beneath the list, such as why it is short. */
  note: string | null;
}

export interface DayDeps {
  /** Hands `visit` every district's records from tick `from` up to, not including, `to`. */
  scan(from: number, to: number, visit: (record: TickRecord) => void, signal: AbortSignal): Promise<void>;
  /** The oldest and newest ticks the log holds, or null when this page has no log to read. */
  span(): Promise<{ oldest: number; newest: number } | null>;
  /** Calls `listener` with each record the live city takes in; returns how to stop. */
  live(listener: (record: TickRecord) => void): () => void;
  /** The newest tick the live city has, or null on a page with no live connection. */
  tip(): number | null;
  /** Show the city at `tick`, as the timeline does. */
  seek(tick: number): void;
  /** The name of a lot, where it has one. */
  placeName(lot: number): string | null;
  show(view: DayView | null): void;
}

/** How long the tick on screen must stay in another day before the panel moves to it, so a scrub does not read each day it crosses. */
const SETTLE_MS = 400;
/** How long after a record that changes the day the card is redrawn, so a burst is drawn once. */
const PAINT_MS = 200;

export class DayPanel {
  private resident: number | null = null;
  private log: DayLog | null = null;
  private stopLive: (() => void) | null = null;
  /** The day shown, counted from 0, or null until a tick says which. */
  private day: number | null = null;
  /** The person chose the day, so the screen's tick no longer moves it. */
  private pinned = false;
  private tick = NaN;
  private span: { oldest: number; newest: number } | null = null;
  private status: DayView['status'] = 'loading';
  private list: DayRow[] = [];
  private current: number | null = null;
  /** Days whose records were read to their end; today is also fed by the live city. */
  private readonly read = new Set<number>();
  private run = 0;
  private reading: AbortController | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private paint: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DayDeps) {}

  /** Start showing `resident`'s day, or stop on null. */
  follow(resident: number | null): void {
    this.cancel();
    this.stopLive?.();
    this.stopLive = null;
    this.resident = resident;
    this.log = resident === null ? null : new DayLog(resident);
    this.day = null;
    this.pinned = false;
    this.span = null;
    this.read.clear();
    this.list = [];
    this.current = null;
    this.status = 'loading';
    if (resident === null) return;
    // The live feed is taken before any reading, so a record landing in between is in the log either way.
    this.stopLive = this.deps.live((record) => {
      if (this.log?.add(record) && this.day !== null && this.inView(record.tick)) this.repaint();
    });
  }

  /** The tick on screen, each frame. The first one chooses the day. */
  frame(tick: number): void {
    if (this.resident === null || !Number.isFinite(tick)) return;
    this.tick = tick;
    if (this.day === null) return void this.show(dayOf(tick));
    if (!this.pinned && dayOf(tick) !== this.day) {
      this.settle ??= setTimeout(() => {
        this.settle = null;
        if (!this.pinned && this.day !== null && dayOf(this.tick) !== this.day) this.show(dayOf(this.tick));
      }, SETTLE_MS);
    } else if (this.settle && dayOf(tick) === this.day) {
      clearTimeout(this.settle);
      this.settle = null;
    }
    const now = currentRow(this.list, tick);
    if (now !== this.current) {
      this.current = now;
      this.emit();
    }
  }

  /** The previous or next day; ignored past the first day the log holds and past today. */
  step(delta: -1 | 1): void {
    if (this.day === null) return;
    const next = this.day + delta;
    if (next < this.oldestDay() || next > this.today()) return;
    this.pinned = true;
    this.show(next);
  }

  /** Seek to the row at `index`. */
  pick(index: number): void {
    const row = this.list[index];
    if (row) this.deps.seek(row.tick);
  }

  private oldestDay(): number {
    return this.span ? dayOf(this.span.oldest) : 0;
  }

  private newestTick(): number {
    return Math.max(this.span?.newest ?? -1, this.deps.tip() ?? -1);
  }

  private today(): number {
    return Math.max(dayOf(this.newestTick()), this.day ?? 0);
  }

  /** Whether a record at `tick` can change the day shown: within it or the slack after it. */
  private inView(tick: number): boolean {
    const from = this.day! * TICKS_PER_DAY;
    return tick >= from && tick < from + TICKS_PER_DAY + SLACK;
  }

  private cancel(): void {
    this.run++;
    this.reading?.abort();
    this.reading = null;
    for (const t of [this.settle, this.paint]) if (t) clearTimeout(t);
    this.settle = this.paint = null;
  }

  private show(day: number): void {
    this.day = day;
    this.status = 'loading';
    this.list = [];
    this.current = null;
    this.emit();
    void this.load(day);
  }

  private async load(day: number): Promise<void> {
    const mine = ++this.run;
    this.reading?.abort();
    const stop = (this.reading = new AbortController());
    const live = () => mine === this.run;
    try {
      this.span = await this.deps.span();
      if (!live()) return;
      if (!this.span) {
        this.status = 'unavailable';
        return this.emit();
      }
      if (day < this.oldestDay()) {
        this.status = 'unretained';
        return this.emit();
      }
      if (!this.read.has(day)) {
        const from = day * TICKS_PER_DAY;
        await this.deps.scan(
          from,
          Math.min(from + TICKS_PER_DAY + SLACK, this.newestTick() + 1),
          (r) => this.log?.add(r),
          stop.signal,
        );
        if (!live()) return;
        this.read.add(day);
      }
      this.status = 'ready';
      this.rebuild();
    } catch (err) {
      if (!live() || stop.signal.aborted) return;
      this.status = (err as { reason?: string }).reason === 'unretained' ? 'unretained' : 'failed';
      console.warn('a resident’s day could not be read', err);
    }
    this.emit();
  }

  private rebuild(): void {
    if (!this.log || this.day === null) return;
    const from = this.day * TICKS_PER_DAY;
    this.list = rows(this.log.entries(from, from + TICKS_PER_DAY), this.deps.placeName);
    this.current = currentRow(this.list, this.tick);
  }

  private repaint(): void {
    if (this.status !== 'ready' || this.paint) return;
    this.paint = setTimeout(() => {
      this.paint = null;
      this.rebuild();
      this.emit();
    }, PAINT_MS);
  }

  private emit(): void {
    if (this.resident === null || this.day === null) return;
    const today = this.day === this.today();
    const from = this.day * TICKS_PER_DAY;
    const clipped = this.status === 'ready' && this.span !== null && this.span.oldest > from;
    this.deps.show({
      status: this.status,
      label: `Day ${this.day + 1}${today ? ', today' : ''}`,
      canPrev: this.day > this.oldestDay(),
      canNext: !today,
      rows: this.list,
      current: this.current,
      note:
        this.status === 'loading'
          ? 'Reading their day from the log.'
          : this.status === 'unretained'
            ? 'The log no longer holds this day.'
            : this.status === 'failed'
              ? 'Their day could not be read.'
              : this.status === 'ready' && this.list.length === 0
                ? 'Nothing is logged for them on this day yet.'
                : clipped
                  ? 'The log no longer holds the start of this day.'
                  : null,
    });
  }
}
