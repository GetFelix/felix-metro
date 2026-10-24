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
const { Seeker, SeekError, fold } = await import('./seek');

const city = { lots: [] } as unknown as City;
const trips: Trips = { trip: () => undefined };
const PAGE = 64;

/**
 * A history as the gateway answers it: ranged reads of at most PAGE records, `trimmed` before the oldest offset, the
 * newest keyframe under `state_get`. Ticks are listed per offset so a log with a hole can be written.
 */
class FakeHistory {
  reads: [number, number, number][] = [];
  oldest = 0;
  logs: TickRecord[][];
  constructor(districts: number, ticks: number[], keyframeEvery = 240) {
    this.logs = Array.from({ length: districts }, (_, d) => {
      let keyframe = 0;
      return ticks.map((tick, offset) => {
        const isKeyframe = tick % keyframeEvery === 0;
        if (isKeyframe) keyframe = offset;
        return {
          kind: 'tick' as const,
          epoch: 1,
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
  async read(_stream: string, shard: number, from: number, end?: number): Promise<Page> {
    this.reads.push([shard, from, end ?? -1]);
    if (from < this.oldest) throw new GatewayError('trimmed', 'gone', this.oldest);
    const log = this.logs[shard]!;
    const stop = Math.min(end ?? log.length, log.length, from + PAGE);
    const records = [];
    for (let o = from; o < stop; o++)
      records.push({ offset: o, payload: new TextEncoder().encode(JSON.stringify(log[o])) });
    return { records, nextOffset: Math.max(from, stop) };
  }
  async stateGet(): Promise<StateValue> {
    const log = this.logs[0]!;
    const at = log.map((r) => r.keyframe !== null).lastIndexOf(true);
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, BigInt(at), true);
    return { payload, version: null, asOf: log.length };
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
      // The keyframe itself was read to check it, so the range starts just after it.
      expect(Math.min(...mine.map(([, from]) => from))).toBe(481);
      expect(Math.max(...mine.map(([, , end]) => end))).toBe(701);
    }
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
    // Only the 30 records past the cached ones, a page each district; none of the keyframe's hour again.
    expect(h.reads.length - reads).toBeLessThanOrEqual(2 * 2);
    expect(s.stats.hits).toBeGreaterThan(0);
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

  it('finds a tick in a log whose offsets are not a tick apiece', async () => {
    // Ticks 100 to 199 were never written; the keyframe at offset 0 covers what follows.
    const h = new FakeHistory(1, [...ticks(100), ...Array.from({ length: 300 }, (_, i) => 200 + i)]);
    const s = seeker(h, 1);
    const state = await folded(s, 450, 1);
    expect(state.ticks).toEqual([450]);
    await expect(s.seek(150)).rejects.toMatchObject({ reason: 'future', nearest: 99 });
  });

  it('refuses a tick that has not happened, and says the newest', async () => {
    const h = new FakeHistory(2, ticks(500));
    await expect(seeker(h).seek(900)).rejects.toMatchObject({ reason: 'future', nearest: 499 });
  });

  it('starts at the oldest keyframe left once retention has trimmed the older ones', async () => {
    const h = new FakeHistory(2, ticks(1000));
    h.oldest = 300;
    const s = seeker(h);
    expect(await s.retained()).toEqual({ oldest: 300, newest: 999 });
    const state = await folded(s, 500);
    expect(state.ticks).toEqual([500, 500]);
    await expect(s.seek(400)).rejects.toMatchObject({ reason: 'unretained', nearest: 480 });
    await expect(s.seek(100)).rejects.toBeInstanceOf(SeekError);
  });

  it('reports the retained range as the newest every district has and the oldest any has left', async () => {
    const h = new FakeHistory(2, ticks(900));
    h.logs[1] = h.logs[1]!.slice(0, 700);
    expect(await seeker(h).retained()).toEqual({ oldest: 0, newest: 699 });
  });
});
