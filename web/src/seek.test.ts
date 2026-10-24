import { describe, expect, it, vi } from 'vitest';
import { CityState, type TickRecord, type Trips } from './city';
import { GatewayError, type Page, type StateValue } from './gateway';
import type { City } from './layout';

// The wasm decoder is not what is tested here: records travel as JSON text, as live.test.ts has them.
vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  districtKey: (district: number, _shards: number, routing: string) => `${routing}.${district}`,
}));
vi.mock('./auth', () => ({ signIn: async () => 'token' }));
const { Seeker, SeekError, fold, foldMore, continues } = await import('./seek');

const city = { lots: [] } as unknown as City;
const trips: Trips = { trip: () => undefined };
const PAGE = 64;

/** A log entry: a tick of epoch 1, or `[epoch, tick]`. */
type Entry = number | [number, number];

/**
 * A history as the gateway answers it: ranged reads of at most PAGE records, `trimmed` before the oldest offset, the
 * newest keyframe under `state_get` for the key a district's records are routed by. Entries are listed per offset so a log
 * with holes, repeats and restarts can be written.
 */
class FakeHistory {
  reads: [number, number, number][] = [];
  oldest = 0;
  logs: TickRecord[][];
  /** Called as each read starts, to move retention or hold the answer. */
  onRead: ((shard: number, from: number, end: number) => void) | null = null;
  /** Reads wait for this before answering. */
  gate: Promise<void> | null = null;
  aborted = 0;
  private flying = new Set<string>();
  /** Identical reads that were in flight together. */
  twins = 0;
  /** Reads past the last record fail, as the gateway's do, instead of answering empty. */
  pastEndIsAnError = true;
  /** What `state_get` says the log length is, when ahead of what reads show. */
  asOfExtra = 0;
  /** The most reads in flight together for one shard. */
  widest = 0;
  private open = new Map<number, number>();
  constructor(districts: number, entries: Entry[] | ((d: number) => Entry[]), keyframeEvery = 240) {
    this.logs = Array.from({ length: districts }, (_, d) => {
      let keyframe = 0;
      return (typeof entries === 'function' ? entries(d) : entries).map((entry, offset) => {
        const [epoch, tick] = typeof entry === 'number' ? [1, entry] : entry;
        const isKeyframe = tick % keyframeEvery === 0;
        if (isKeyframe) keyframe = offset;
        return {
          kind: 'tick' as const,
          epoch,
          district: d,
          tick,
          speed: 4,
          keyframeOffset: keyframe,
          wallUs: 1_000_000 * tick,
          // Lot 5 stands from the second hour's keyframe on; lot 7 is built by an event at tick 250 and in every keyframe after.
          keyframe: isKeyframe
            ? {
                buildings: [...(tick >= 240 ? [[5, 1, 0]] : []), ...(tick > 250 ? [[7, 2, 0]] : [])] as [
                  number,
                  number,
                  number,
                ][],
              }
            : null,
          events: tick === 250 ? [{ type: 'built' as const, lot: 7, kind: 2, rotation: 0 }] : [],
        };
      });
    });
  }
  async read(_stream: string, shard: number, from: number, end?: number, signal?: AbortSignal): Promise<Page> {
    this.reads.push([shard, from, end ?? -1]);
    const key = `${shard}:${from}:${end}`;
    if (this.flying.has(key)) this.twins++;
    this.flying.add(key);
    const n = (this.open.get(shard) ?? 0) + 1;
    this.open.set(shard, n);
    this.widest = Math.max(this.widest, n);
    try {
      this.onRead?.(shard, from, end ?? -1);
      await Promise.resolve();
      if (this.gate) {
        await Promise.race([
          this.gate,
          new Promise((_, no) =>
            signal?.addEventListener('abort', () => {
              this.aborted++;
              no(signal.reason);
            }),
          ),
        ]);
      }
      if (from < this.oldest) throw new GatewayError('trimmed', 'gone', this.oldest);
      if (this.pastEndIsAnError && from >= this.logs[shard]!.length) {
        throw new GatewayError(
          'read_failed',
          `offset ${from} is past the end of the stream; tail is ${this.logs[shard]!.length - 1}`,
        );
      }
      const log = this.logs[shard]!;
      const stop = Math.min(end ?? log.length, log.length, from + PAGE);
      const records = [];
      for (let o = from; o < stop; o++)
        records.push({ offset: o, payload: new TextEncoder().encode(JSON.stringify(log[o])) });
      return { records, nextOffset: Math.max(from, stop) };
    } finally {
      this.open.set(shard, this.open.get(shard)! - 1);
      this.flying.delete(key);
    }
  }
  /** Answers only for the key the records are routed by (jump_hash here); any other key holds nothing. */
  async stateGet(_stream: string, key: string, entity: string): Promise<StateValue> {
    const none = { payload: null, version: null, asOf: 0 };
    const [routing, d] = entity.split('.');
    if (key !== 'keyframe' || routing !== 'jump_hash') return none;
    const log = this.logs[Number(d)]!;
    const at = log.map((r) => r.keyframe !== null).lastIndexOf(true);
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, BigInt(at), true);
    return { payload, version: null, asOf: log.length + this.asOfExtra };
  }
}

const ticks = (n: number) => Array.from({ length: n }, (_, i) => i);
const seeker = (h: FakeHistory, districts = 2) => new Seeker(h as never, districts);
const folded = async (s: InstanceType<typeof Seeker>, tick: number, districts = 2) => {
  const state = new CityState(city, trips, districts);
  fold(state, await s.seek(tick));
  return state;
};

describe('seek', () => {
  it('reads each district from its keyframe to the tick, and nothing else after it', async () => {
    const h = new FakeHistory(2, ticks(1000));
    const state = await folded(seeker(h), 700);
    expect(state.ticks).toEqual([700, 700]);
    // Hour two's keyframe is at tick 480; both buildings are in it.
    expect(state.built.get(5)).toEqual({ kind: 1, rotation: 0 });
    expect(state.built.get(7)).toEqual({ kind: 2, rotation: 0 });
    // The range reads are the keyframe's 480 up to 700 inclusive, in pages, and none reaches past the tick.
    const ranges = h.reads.filter(([, from, end]) => end > from + 1);
    for (const d of [0, 1]) {
      const mine = ranges.filter(([shard]) => shard === d);
      // The range starts at the keyframe itself.
      expect(Math.min(...mine.map(([, from]) => from))).toBe(480);
      expect(Math.max(...mine.map(([, , end]) => end))).toBe(701);
    }
  });

  it('reads the pages of a range together once the first has said how big a page is', async () => {
    const h = new FakeHistory(1, ticks(2000));
    const state = await folded(seeker(h, 1), 1190, 1);
    expect(state.ticks).toEqual([1190]);
    // 230 records from the keyframe at 960 are four pages of 64: one first, then three at once.
    expect(h.widest).toBeGreaterThanOrEqual(3);
    const pages = h.reads.filter(([, from, end]) => end > from + 1);
    expect(pages.length).toBeLessThanOrEqual(4);
  });

  it('finds the record in a couple of reads however far the tick is from the newest keyframe', async () => {
    const h = new FakeHistory(1, ticks(5000));
    const s = seeker(h, 1);
    await s.seek(1234);
    const probes = h.reads.filter(([, from, end]) => end === from + 1);
    // The pointer's keyframe, its record, the target and the keyframe it names.
    expect(probes.length).toBeLessThanOrEqual(5);
  });

  it('seeks the same hour again from the cache', async () => {
    const h = new FakeHistory(2, ticks(1000));
    const s = seeker(h);
    await s.seek(500);
    const reads = h.reads.length;
    const state = await folded(s, 530);
    expect(state.ticks).toEqual([530, 530]);
    // Per district: the state read's checks of the log's end, the tick itself and the 30 records past the cached ones.
    // None of the keyframe's hour again.
    expect(h.reads.length - reads).toBeLessThanOrEqual(2 * 4);
    expect(s.stats.hits).toBeGreaterThan(0);
  });

  it('asks for the newest record once for seeks close together', async () => {
    const h = new FakeHistory(2, ticks(1000));
    const s = seeker(h);
    const asked = vi.spyOn(h, 'stateGet');
    await s.seek(500);
    const first = asked.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await s.seek(600);
    await s.seek(450);
    expect(asked.mock.calls.length).toBe(first);
  });

  it('asks again for a tick past the cached newest before calling it the future', async () => {
    const h = new FakeHistory(2, ticks(1000));
    const s = seeker(h);
    await s.seek(900);
    h.logs = new FakeHistory(2, ticks(1100)).logs;
    expect((await s.seek(1050)).tick).toBe(1050);
  });

  it('holds the keyframe of an hour it has seeked into, to draw at once', async () => {
    const s = seeker(new FakeHistory(2, ticks(1000)));
    expect(s.cachedKeyframe(300)).toBeNull();
    await s.seek(300);
    const kf = s.cachedKeyframe(400)!;
    expect(kf.tick).toBe(240);
    expect(kf.exact).toBe(false);
    expect(kf.districts.every((d) => d.records.length === 1 && d.records[0]!.keyframe)).toBe(true);
    const state = new CityState(city, trips, 2);
    fold(state, kf);
    expect(state.ticks).toEqual([240, 240]);
    expect(state.built.get(5)).toEqual({ kind: 1, rotation: 0 });
    expect(s.cachedKeyframe(100)).toBeNull();
  });

  it('a seek ahead in the same hour folds only the records after the last one', async () => {
    const s = seeker(new FakeHistory(2, ticks(1000)));
    const state = new CityState(city, trips, 2);
    const a = await s.seek(260);
    fold(state, a);
    const b = await s.seek(400);
    expect(continues(a, b)).toBe(true);
    const taken: number[] = [];
    state.onRecord = (_d, t) => taken.push(t);
    foldMore(state, a, b);
    expect(state.ticks).toEqual([400, 400]);
    // Only the 140 ticks past 260 in each district, not the 160 from the keyframe.
    expect(taken.length).toBe(2 * 140);
    expect(Math.min(...taken)).toBe(261);
    const straight = new CityState(city, trips, 2);
    fold(straight, b);
    expect([...state.built]).toEqual([...straight.built]);
  });

  it('a move back, or into another hour, is not a continuation', async () => {
    const s = seeker(new FakeHistory(2, ticks(1000)));
    const a = await s.seek(300);
    expect(continues(a, await s.seek(260))).toBe(false);
    expect(continues(a, await s.seek(500))).toBe(false);
    expect(continues(await s.seek(500), await s.seek(520))).toBe(true);
  });

  it('a backward move refolds from the keyframe and matches a straight fold', async () => {
    const h = new FakeHistory(2, ticks(1000));
    const s = seeker(h);
    const later = await folded(s, 900);
    expect(later.built.has(7)).toBe(true);
    // Tick 300 is between the keyframe at 240 and the next: lot 7 comes from the event, not a keyframe.
    expect((await folded(s, 300)).built.has(7)).toBe(true);
    const back = await folded(s, 245);
    expect(back.ticks).toEqual([245, 245]);
    expect(back.built.has(7)).toBe(false);
    expect(back.built.get(5)).toEqual({ kind: 1, rotation: 0 });
    const fresh = await folded(seeker(new FakeHistory(2, ticks(1000))), 245);
    expect([...back.built]).toEqual([...fresh.built]);
  });

  it('applies each record of a district once', async () => {
    const h = new FakeHistory(1, ticks(600));
    const state = new CityState(city, trips, 1);
    const seen: string[] = [];
    state.onRecord = (d, t, r) => seen.push(`${d}:${t}:${r}`);
    const records = await seeker(h, 1).seek(300);
    fold(state, records);
    fold(state, records);
    expect(seen.filter((x) => x.endsWith(':applied'))).toHaveLength(61);
    expect(seen.filter((x) => x.endsWith(':seen'))).toHaveLength(61);
    expect(seen.some((x) => x.endsWith(':gap'))).toBe(false);
  });

  it('finds a tick in a log whose offsets are not a tick apiece, and shows the nearest earlier one for a missing tick', async () => {
    // Ticks 100 to 199 were never written; the keyframe at offset 0 covers what follows.
    const h = new FakeHistory(1, [...ticks(100), ...Array.from({ length: 300 }, (_, i) => 200 + i)]);
    const s = seeker(h, 1);
    const state = await folded(s, 450, 1);
    expect(state.ticks).toEqual([450]);
    const missing = await s.seek(150);
    expect(missing).toMatchObject({ tick: 99, requested: 150, exact: false });
    const shown = new CityState(city, trips, 1);
    fold(shown, missing);
    expect(shown.ticks).toEqual([99]);
  });

  it('settles every district on the nearest earlier tick when only one of them lacks the tick', async () => {
    const h = new FakeHistory(2, (d) => ticks(600).filter((t) => !(d === 1 && t === 300)));
    const s = seeker(h);
    const result = await s.seek(300);
    expect(result).toMatchObject({ tick: 299, exact: false });
    const state = new CityState(city, trips, 2);
    fold(state, result);
    expect(state.ticks).toEqual([299, 299]);
  });

  it('tells a tick that has not happened from one the log skipped', async () => {
    const h = new FakeHistory(2, ticks(500));
    await expect(seeker(h).seek(900)).rejects.toMatchObject({ reason: 'future', nearest: 499 });
    await expect(seeker(h).seek(500)).rejects.toMatchObject({ reason: 'future', nearest: 499 });
    expect(await seeker(h).seek(499)).toMatchObject({ tick: 499, exact: true });
  });

  it('starts at the oldest keyframe left once retention has trimmed the older ones', async () => {
    const h = new FakeHistory(2, ticks(1000));
    h.oldest = 300;
    const s = seeker(h);
    // The first record left is tick 300, so the first tick a fold can start from is the keyframe at 480.
    expect(await s.retained()).toEqual({ oldest: 480, newest: 999 });
    const state = await folded(s, 500);
    expect(state.ticks).toEqual([500, 500]);
    await expect(s.seek(400)).rejects.toMatchObject({ reason: 'unretained', nearest: 480 });
    await expect(s.seek(100)).rejects.toBeInstanceOf(SeekError);
  });

  it('reports the retained range as the newest every district has and the oldest any has left', async () => {
    const h = new FakeHistory(2, (d) => ticks(d === 1 ? 700 : 900));
    expect(await seeker(h).retained()).toEqual({ oldest: 0, newest: 699 });
  });

  it('follows an epoch change: a restarted sim takes the next epoch and resumes from an older keyframe', async () => {
    // Epoch 1 ran to 599; epoch 2 resumed from the keyframe at 480 and ran to 799.
    const entries: Entry[] = [
      ...ticks(600).map((t): Entry => [1, t]),
      ...ticks(800)
        .slice(480)
        .map((t): Entry => [2, t]),
    ];
    const h = new FakeHistory(2, entries);
    const s = seeker(h);
    const inNew = await s.seek(500);
    // The tick of epoch 2, not the one epoch 1 had at that tick.
    expect(inNew.districts[0]!.offset).toBe(600 + 20);
    const state = new CityState(city, trips, 2);
    fold(state, inNew);
    expect(state.ticks).toEqual([500, 500]);
    // Before epoch 2 began, only epoch 1 has the tick.
    const before = await s.seek(300);
    expect(before).toMatchObject({ tick: 300, exact: true });
    expect(before.districts[0]!.offset).toBe(300);
    await expect(s.seek(900)).rejects.toMatchObject({ reason: 'future', nearest: 799 });
  });

  it('does not borrow a tick from an older epoch when the newer one skipped it', async () => {
    const entries: Entry[] = [
      ...ticks(600).map((t): Entry => [1, t]),
      ...ticks(800)
        .slice(480)
        .filter((t) => t !== 500)
        .map((t): Entry => [2, t]),
    ];
    const s = seeker(new FakeHistory(2, entries));
    expect(await s.seek(500)).toMatchObject({ tick: 499, exact: false });
    expect(await s.seek(550)).toMatchObject({ tick: 550, exact: true });
  });

  it('bisects across an epoch boundary when the estimate is no use', async () => {
    // Epoch 2 wrote every tick three times, so ticks are far from offsets and the epochs interleave in tick.
    const entries: Entry[] = [
      ...ticks(600).map((t): Entry => [1, t]),
      ...ticks(800)
        .slice(480)
        .flatMap((t): Entry[] => [
          [2, t],
          [2, t],
          [2, t],
        ]),
    ];
    const s = seeker(new FakeHistory(2, entries));
    for (const t of [490, 700, 790]) expect((await folded(s, t)).ticks).toEqual([t, t]);
    expect((await folded(s, 400)).ticks).toEqual([400, 400]);
    // The newest epoch that reaches a tick is the one shown: tick 490 is in epoch 2, which starts at offset 600.
    for (let t = 480; t < 800; t += 7) {
      expect((await seeker(new FakeHistory(2, entries)).seek(t)).districts[0]!.offset).toBeGreaterThanOrEqual(600);
    }
    expect((await s.seek(400)).districts[0]!.offset).toBe(400);
  });

  it('finds a tick that landed twice, and one repeated while the sim was paused', async () => {
    const dup = ticks(400).flatMap((t) => (t === 250 ? [t, t] : [t]));
    const s = seeker(new FakeHistory(2, dup));
    for (const t of [249, 250, 251, 399]) {
      const state = await folded(s, t);
      expect(state.ticks).toEqual([t, t]);
    }
    expect((await s.seek(251)).districts[0]!.offset).toBe(252);
    // Paused at 300 for 40 records.
    const paused = ticks(600).flatMap((t) => (t === 300 ? Array<number>(40).fill(t) : [t]));
    const p = seeker(new FakeHistory(2, paused));
    for (const t of [299, 300, 301, 590]) expect((await folded(p, t)).ticks).toEqual([t, t]);
  });

  it('finds a tick when every tick is written twice or the log has long holes', async () => {
    const twice = ticks(700).flatMap((t) => [t, t]);
    expect((await folded(seeker(new FakeHistory(2, twice)), 650)).ticks).toEqual([650, 650]);
    const holes = ticks(900).filter((t) => t < 100 || t > 400 || t % 7 === 0);
    const s = seeker(new FakeHistory(2, holes));
    expect(await s.seek(250)).toMatchObject({ tick: 245, exact: false });
    expect(await s.seek(600)).toMatchObject({ tick: 600, exact: true });
  });

  it('retries a range that retention trims, and ends in unretained when the keyframe went with it', async () => {
    const h = new FakeHistory(2, ticks(1000));
    const s = seeker(h);
    await s.seek(500);
    // Between finding tick 700 and reading its records, retention takes everything below tick 600.
    h.onRead = (_shard, from, end) => {
      if (end > from + 1) h.oldest = 600;
    };
    await expect(s.seek(700)).rejects.toMatchObject({ reason: 'unretained', nearest: 720 });
    // What was cached below the new oldest is gone.
    for (const d of [0, 1]) {
      expect([...(s['records'][d] as Map<number, { offset: number }>).values()].every((k) => k.offset >= 600)).toBe(
        true,
      );
    }
    h.onRead = null;
    expect((await folded(s, 800)).ticks).toEqual([800, 800]);
  });

  it("returns each district's offset of the tick, for a subscription to resume after", async () => {
    const h = new FakeHistory(2, (d) => (d === 0 ? ticks(600) : ticks(600).flatMap((t) => [t, t])));
    const result = await seeker(h).seek(400);
    // District 1 wrote every tick twice; it may name either copy.
    expect(result.districts[0]!.offset).toBe(400);
    expect([800, 801]).toContain(result.districts[1]!.offset);
  });

  it('a newer seek cancels the one before it and takes its reads out of the queue', async () => {
    const h = new FakeHistory(2, ticks(1000));
    let open!: () => void;
    h.gate = new Promise<void>((r) => (open = r));
    const s = seeker(h);
    const stale = s.seek(300);
    await new Promise((r) => setTimeout(r, 0));
    const newer = s.seek(600);
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.aborted).toBeGreaterThan(0);
    open();
    expect((await newer).tick).toBe(600);
    // An abort signal from the caller stops a seek the same way.
    const stop = new AbortController();
    const third = s.seek(700, { signal: stop.signal });
    stop.abort();
    await expect(third).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('shares identical reads that are in flight together', async () => {
    const h = new FakeHistory(2, ticks(1000));
    let open!: () => void;
    h.gate = new Promise<void>((r) => (open = r));
    const s = seeker(h);
    const both = Promise.all([s.retained(), s.retained()]);
    await new Promise((r) => setTimeout(r, 0));
    open();
    await both;
    expect(h.twins).toBe(0);
    expect(h.reads.length).toBeLessThan(2 * 2 * 4);
  });

  it('a record that does not parse, or belongs to another district, is an error and not the end of the log', async () => {
    const h = new FakeHistory(1, ticks(600));
    const log = h.logs[0]!;
    log[300] = { ...log[300]!, kind: 'other' } as never;
    await expect(seeker(h, 1).seek(400)).rejects.toMatchObject({ reason: 'broken' });
    const g = new FakeHistory(1, ticks(600));
    g.logs[0]![350] = { ...g.logs[0]![350]!, district: 3 };
    await expect(seeker(g, 1).seek(400)).rejects.toMatchObject({ reason: 'broken' });
  });

  it('carries on when the state read is ahead of the log reads can see', async () => {
    const h = new FakeHistory(2, ticks(600));
    h.asOfExtra = 10;
    const s = seeker(h);
    expect((await folded(s, 7)).ticks).toEqual([7, 7]);
    expect(await s.retained()).toEqual({ oldest: 0, newest: 599 });
  });

  it('refuses a fold that did not reach the tick', async () => {
    const result = await seeker(new FakeHistory(2, ticks(600))).seek(500);
    result.districts[1]!.records.pop();
    expect(() => fold(new CityState(city, trips, 2), result)).toThrow(SeekError);
  });

  it('stops the reads the other districts have waiting when one district fails', async () => {
    const h = new FakeHistory(2, ticks(1000));
    // Reads wait on the gate, except district 1's, which fail at once.
    h.gate = new Promise<void>(() => {});
    h.onRead = (shard) => {
      if (shard === 1) throw new GatewayError('read_failed', 'boom');
    };
    const run = seeker(h).seek(300);
    await expect(run).rejects.toMatchObject({ code: 'read_failed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.aborted).toBeGreaterThan(0);
  });

  it('leaves no listener on the caller signal after a seek, whether it finished or failed', async () => {
    const stop = new AbortController();
    let live = 0;
    const add = stop.signal.addEventListener.bind(stop.signal);
    const remove = stop.signal.removeEventListener.bind(stop.signal);
    stop.signal.addEventListener = ((...a: Parameters<typeof add>) => (live++, add(...a))) as typeof add;
    stop.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (live--, remove(...a))) as typeof remove;
    const s = seeker(new FakeHistory(2, ticks(1000)));
    await s.seek(300, { signal: stop.signal });
    expect(live).toBe(0);
    await expect(s.seek(5000, { signal: stop.signal })).rejects.toBeInstanceOf(SeekError);
    expect(live).toBe(0);
  });

  describe('sessions', () => {
    const session = (h: FakeHistory) => {
      const s = {
        closed: false,
        reads: 0,
        read: (...a: Parameters<FakeHistory['read']>) => {
          if (s.closed) return Promise.reject(new GatewayError('closed', 'the session was closed'));
          s.reads++;
          return h.read(...a);
        },
        stateGet: (...a: Parameters<FakeHistory['stateGet']>) =>
          s.closed ? Promise.reject(new GatewayError('closed', 'the session was closed')) : h.stateGet(...a),
        close: () => {
          s.closed = true;
        },
      };
      return s;
    };

    it('close() closes every session and refuses a later seek', async () => {
      const h = new FakeHistory(2, ticks(1000));
      const a = session(h);
      const b = session(h);
      const s = new Seeker([a, b], 2);
      await s.seek(300);
      s.close();
      expect([a.closed, b.closed]).toEqual([true, true]);
      await expect(s.seek(300)).rejects.toMatchObject({ code: 'closed' });
    });

    it('drops a session that closed and answers its read on another', async () => {
      const h = new FakeHistory(2, ticks(1000));
      const dead = session(h);
      const live = session(h);
      dead.closed = true;
      const s = new Seeker([dead, live], 2);
      expect((await folded(s, 300)).ticks).toEqual([300, 300]);
      expect(live.reads).toBeGreaterThan(0);
    });

    it('opens its sessions on the first seek, closes them when idle, and opens them again for the next', async () => {
      vi.useFakeTimers();
      try {
        const h = new FakeHistory(2, ticks(1000));
        const opened: ReturnType<typeof session>[] = [];
        const s = new Seeker(async () => {
          opened.push(session(h), session(h));
          return opened.slice(-2);
        }, 2);
        expect(opened).toHaveLength(0);
        await s.seek(300);
        expect(opened).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(opened.some((o) => o.closed)).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(opened.every((o) => o.closed)).toBe(true);
        expect((await s.seek(600)).tick).toBe(600);
        expect(opened).toHaveLength(4);
        expect(opened.slice(2).some((o) => o.closed)).toBe(false);
        s.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('reopens when every session closed under a seek', async () => {
      const h = new FakeHistory(2, ticks(1000));
      const batches: ReturnType<typeof session>[] = [];
      const s = new Seeker(async () => {
        const one = session(h);
        batches.push(one);
        return [one];
      }, 2);
      await s.seek(300);
      batches[0]!.closed = true;
      expect((await s.seek(700)).tick).toBe(700);
      expect(batches).toHaveLength(2);
      s.close();
    });
  });
});
