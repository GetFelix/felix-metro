// What a rewind needs: the records of the hour on screen, kept so any tick of it can be refolded from the keyframe
// without a read, and the hours beside it to fetch before the playhead gets there.
import type { TickRecord } from './city';
import { TICKS_PER_HOUR } from './clock';
import { WINDOW } from './construction';
import type { SeekResult } from './seek';

interface Run {
  /** The offset of `records[0]`; the records are consecutive in the log. */
  first: number;
  records: TickRecord[];
}

/** The first tick of the hour `tick` is in: where its keyframe is. */
export const hourStart = (tick: number): number => Math.floor(tick / TICKS_PER_HOUR) * TICKS_PER_HOUR;

/**
 * Every district's records from one keyframe on, as far as they are known. A seek fills it up to the tick it found;
 * records played forward are added as they are applied, until the next keyframe starts a new run.
 */
export class Hour {
  private constructor(
    private readonly runs: Run[],
    private readonly before: TickRecord[][],
  ) {}

  static from(seek: SeekResult): Hour {
    return new Hour(
      seek.districts.map((d) => ({ first: d.offset - d.records.length + 1, records: [...d.records] })),
      seek.districts.map((d) => d.before),
    );
  }

  /** The keyframe's tick, or null when some district's records do not begin at the same keyframe. */
  get start(): number | null {
    const first = this.runs[0]?.records[0];
    if (!first?.keyframe) return null;
    return this.runs.every((r) => r.records[0]?.keyframe && r.records[0].tick === first.tick) ? first.tick : null;
  }

  /** The newest tick every district holds, or -1. */
  get end(): number {
    return Math.min(...this.runs.map((r) => r.records.at(-1)?.tick ?? -1));
  }

  covers(tick: number): boolean {
    const start = this.start;
    return start !== null && start <= tick && tick <= this.end;
  }

  /** Keep a record played forward. One that is not the next in its district's log, such as a replay, is ignored. */
  add(district: number, offset: number, record: TickRecord): void {
    const run = this.runs[district];
    if (!run) return;
    if (record.keyframe) {
      this.runs[district] = { first: offset, records: [record] };
      this.before[district] = [];
    } else if (offset === run.first + run.records.length) {
      run.records.push(record);
    }
  }

  /**
   * The seek result for the newest tick not after `tick` that every district holds, ready to {@link fold}; null when the
   * hour does not reach back to it. A district that skipped a tick settles every district on the earlier one all have.
   */
  at(tick: number): SeekResult | null {
    const start = this.start;
    if (start === null) return null;
    let at = Math.min(tick, this.end);
    for (;;) {
      const lasts = this.runs.map((r) => lastNotAfter(r.records, at));
      const lowest = Math.min(...lasts);
      if (lowest === at) break;
      at = lowest;
    }
    if (at < start) return null;
    return {
      tick: at,
      requested: tick,
      exact: at === tick,
      districts: this.runs.map((r, d) => {
        const records = r.records.slice(0, countNotAfter(r.records, at));
        // A building just built before the keyframe is still rising, which only the records before it can tell.
        return {
          records,
          offset: r.first + records.length - 1,
          before: at - start < WINDOW ? (this.before[d] ?? []) : [],
        };
      }),
    };
  }
}

function countNotAfter(records: readonly TickRecord[], tick: number): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid]!.tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastNotAfter(records: readonly TickRecord[], tick: number): number {
  return records[countNotAfter(records, tick) - 1]?.tick ?? -1;
}

/**
 * The ticks to read ahead of need while the city sits in the past: the end of the hour before and of the hour after the
 * one `tick` is in, each only when the log holds it.
 */
export function neighbours(tick: number, oldest: number, newest: number): number[] {
  const start = hourStart(tick);
  const out: number[] = [];
  if (start - 1 >= oldest) out.push(start - 1);
  if (start + TICKS_PER_HOUR <= newest) out.push(Math.min(start + 2 * TICKS_PER_HOUR - 1, newest));
  return out;
}
