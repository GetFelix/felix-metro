import { describe, expect, it, vi } from 'vitest';
import { CityState, type Trips } from './city';
import { TickClock } from './clock';
import { GatewayError, type EventFrame, type Gateway, type Page, type Subscribed } from './gateway';
import type { City } from './layout';
import type { SeekResult } from './seek';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  districtKey: () => '',
}));
vi.mock('./auth', () => ({ signIn: async () => 'token' }));
const { Playback, handOver, JOIN_LAG } = await import('./playback');

const city = { lots: [] } as unknown as City;
const trips: Trips = { trip: () => undefined };
const DISTRICTS = 2;
const PAGE = 50;

const record = (tick: number, district: number) =>
  new TextEncoder().encode(
    JSON.stringify({
      kind: 'tick',
      epoch: 1,
      district,
      tick,
      speed: 10,
      keyframe: tick === 0 ? { buildings: [] } : null,
      events: [],
    }),
  );

/** Each district's log holds tick `n` at offset `n`. Reads are paged and refused past the end, as the gateway does. */
class FakeLog {
  logs: Uint8Array[][] = Array.from({ length: DISTRICTS }, () => []);
  handlers = new Map<string, (f: EventFrame) => void>();
  reads: [number, number][] = [];
  subscribes: [number, number][] = [];
  /** Skip the next live delivery of a district, as a full subscriber queue does. */
  dropNext = new Set<number>();
  constructor(length: number) {
    this.grow(length);
  }
  get length(): number {
    return this.logs[0]!.length;
  }
  grow(n: number): void {
    for (let i = 0; i < n; i++) this.commit();
  }
  commit(): void {
    for (let d = 0; d < DISTRICTS; d++) {
      const log = this.logs[d]!;
      log.push(record(log.length, d));
      const frame = { sub: d, offset: log.length - 1, skippedBefore: 0, payload: log.at(-1)! };
      if (this.dropNext.delete(d)) continue;
      this.handlers.get(`p0${d}`)?.(frame);
    }
  }
  async subscribe(
    _stream: string,
    slot: string,
    shard: number,
    from: number | 'live',
    onEvent: (f: EventFrame) => void,
  ): Promise<Subscribed> {
    const start = from === 'live' ? this.logs[shard]!.length : from;
    this.subscribes.push([shard, start]);
    this.handlers.set(slot, onEvent);
    // The backlog arrives right after `subscribed`, then the live records.
    queueMicrotask(() => {
      for (let o = start; o < this.logs[shard]!.length; o++)
        onEvent({ sub: shard, offset: o, skippedBefore: 0, payload: this.logs[shard]![o]! });
    });
    return { sub: shard, startOffset: start, liveOffset: this.logs[shard]!.length };
  }
  async read(_stream: string, shard: number, from: number): Promise<Page> {
    this.reads.push([shard, from]);
    const log = this.logs[shard]!;
    if (from >= log.length) throw new GatewayError('read_failed', `offset ${from} is past the end`);
    const stop = Math.min(log.length, from + PAGE);
    const records = [];
    for (let o = from; o < stop; o++) records.push({ offset: o, payload: log[o]! });
    return { records, nextOffset: stop };
  }
}

/** A state folded to tick `at`, and the seek result that says so. */
const seeked = (log: FakeLog, at: number) => {
  const state = new CityState(city, trips, DISTRICTS);
  for (let d = 0; d < DISTRICTS; d++)
    for (let t = 0; t <= at; t++) state.apply(JSON.parse(new TextDecoder().decode(log.logs[d]![t])), true);
  const result = {
    tick: at,
    requested: at,
    exact: true,
    districts: Array.from({ length: DISTRICTS }, () => ({ records: [], offset: at })),
  } as SeekResult;
  return { state, result };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Play with `dt` second steps until the playhead is at the live tip or `max` steps have passed. */
async function play(p: InstanceType<typeof Playback>, log: FakeLog, dt: number, max = 5000, liveEvery = 0) {
  for (let i = 0; i < max && !p.atTip; i++) {
    if (liveEvery && i % liveEvery === 0) log.commit();
    p.advance(dt);
    await settle();
  }
}

const start = (log: FakeLog, at: number) => {
  const { state, result } = seeked(log, at);
  const applied: [number, number, string][] = [];
  state.onRecord = (d, t, r) => applied.push([d, t, r]);
  const failures: Error[] = [];
  const p = new Playback(log as unknown as Pick<Gateway, 'read' | 'subscribe'>, state, result, {
    tail: () => log.length - 1,
    onFail: (e) => failures.push(e),
  });
  return { p, state, applied, failures };
};

/** Every district's applied ticks, in order, with the results. */
const bySeq = (applied: [number, number, string][], d: number) => applied.filter((a) => a[0] === d);

describe('Playback', () => {
  it('applies every tick from the seek to the live tip, once and in order, while the log grows', async () => {
    const log = new FakeLog(1500);
    const { p, applied, failures } = start(log, 200);
    await play(p, log, 1, 20000, 3);
    expect(failures).toEqual([]);
    expect(p.atTip).toBe(true);
    for (let d = 0; d < DISTRICTS; d++) {
      const seq = bySeq(applied, d);
      expect(seq.every((a) => a[2] === 'applied')).toBe(true);
      const ticks = seq.map((a) => a[1]);
      expect(ticks[0]).toBe(201);
      expect(ticks).toEqual(Array.from({ length: ticks.length }, (_, i) => 201 + i));
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(log.length - 1 - JOIN_LAG - 2);
    }
  });

  it('reads ahead while far from the tail and subscribes once within an hour of it', async () => {
    const log = new FakeLog(1500);
    const { p } = start(log, 200);
    await play(p, log, 1, 20000);
    expect(log.reads[0]).toEqual([0, 201]);
    expect(log.subscribes).toHaveLength(DISTRICTS);
    for (const [, from] of log.subscribes) {
      // 1499 - 240: the read that crossed into the last hour handed on at its page's end.
      expect(from).toBeGreaterThanOrEqual(1499 - 240);
      expect(from).toBeLessThan(1499 - 240 + PAGE + 1);
    }
  });

  it('subscribes from the offset after the seek when it is already within an hour of the tail', async () => {
    const log = new FakeLog(300);
    const { p, applied } = start(log, 200);
    await play(p, log, 1, 5000);
    expect(log.reads).toEqual([]);
    expect(log.subscribes.sort()).toEqual([
      [0, 201],
      [1, 201],
    ]);
    expect(bySeq(applied, 0).map((a) => a[1])).toEqual(
      Array.from({ length: bySeq(applied, 0).length }, (_, i) => 201 + i),
    );
  });

  it('stays contiguous when the subscription drops a record', async () => {
    const log = new FakeLog(300);
    const { p, applied, failures } = start(log, 250);
    await p.advance(0);
    await settle();
    log.dropNext.add(1);
    log.commit();
    log.commit();
    log.commit();
    await play(p, log, 0.5, 5000, 4);
    expect(failures).toEqual([]);
    for (let d = 0; d < DISTRICTS; d++) {
      const ticks = bySeq(applied, d).map((a) => a[1]);
      expect(ticks).toEqual(Array.from({ length: ticks.length }, (_, i) => 251 + i));
    }
  });

  it('treats a read past the log end as nothing yet', async () => {
    const log = new FakeLog(1000);
    const { p, failures } = start(log, 990);
    // Far enough from the tail to read: a hole between the seek's offset and the end is not what is read.
    await play(p, log, 1, 500);
    expect(failures).toEqual([]);
    expect(p.atTip).toBe(true);
  });

  it('does not move while paused, and takes up where it was', async () => {
    const log = new FakeLog(400);
    const { p, state } = start(log, 100);
    p.advance(0.5);
    await settle();
    p.paused = true;
    const at = p.head;
    for (let i = 0; i < 20; i++) {
      p.advance(1);
      await settle();
    }
    expect(p.head).toBe(at);
    p.paused = false;
    p.advance(0.5);
    expect(p.head).toBeGreaterThan(at);
    expect(state.latest).toBeGreaterThan(100);
  });

  it('races to the tip in about three seconds from any distance', async () => {
    const log = new FakeLog(1500);
    const { p } = start(log, 200);
    p.catchUp();
    let seconds = 0;
    while (!p.atTip && seconds < 20) {
      p.advance(0.1);
      seconds += 0.1;
      // The reads the pumps wait on answer in a few turns.
      for (let i = 0; i < 4; i++) await settle();
    }
    expect(p.atTip).toBe(true);
    expect(seconds).toBeLessThan(8);
    expect(p.head).toBeGreaterThan(1000);
  });

  it('fails when retention takes the records it needs', async () => {
    const log = new FakeLog(1500);
    log.read = async () => {
      throw new GatewayError('trimmed', 'gone', 900);
    };
    const { p, failures } = start(log, 200);
    await settle();
    expect(failures[0]).toBeInstanceOf(GatewayError);
    p.advance(1);
    expect(p.head).toBe(200);
  });
});

describe('handOver', () => {
  it('gives the live clock the playhead, so the next frame moves on from it without a jump', async () => {
    const log = new FakeLog(300);
    const { p, state } = start(log, 250);
    await play(p, log, 0.5, 2000);
    const clock = new TickClock();
    const joined = handOver(p, clock);
    expect(clock.now).toBe(joined);
    const speed = state.speed;
    const next = clock.advance(1 / 60, log.length - 1, speed);
    // One frame of the clock's own pace, at most steered to 2.5x: the position of a car follows the tick.
    expect(next - joined).toBeGreaterThanOrEqual(0);
    expect(next - joined).toBeLessThanOrEqual((2.5 * speed) / 60 + 1e-9);
  });
});
