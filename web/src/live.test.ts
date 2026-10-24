import { describe, expect, it, vi } from 'vitest';
import { CityState, type Trips } from './city';
import { GatewayError, type EventFrame, type Gateway, type Page, type StateValue, type Subscribed } from './gateway';
import type { City } from './layout';

// The wasm decoder is not what is tested here: records travel as JSON text.
vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  districtKey: (district: number, _shards: number, routing: string) => `${routing}.${district}`,
}));
vi.mock('./auth', () => ({ signIn: async () => 'token' }));
const { follow, createFeeds } = await import('./live');

const city = { lots: [] } as unknown as City;
const trips: Trips = { trip: () => undefined };
const bytes = (tick: number, district: number, keyframe = false) =>
  new TextEncoder().encode(
    JSON.stringify({
      kind: 'tick',
      epoch: 1,
      district,
      tick,
      speed: 4,
      keyframe: keyframe ? { buildings: [] } : null,
      events: [],
    }),
  );

/** A gateway over one shard per district whose log the test writes and whose subscription it can feed. */
class FakeGateway {
  logs: Uint8Array[][];
  handlers = new Map<string, (f: EventFrame) => void>();
  subscribes = 0;
  reads: [number, number, number][] = [];
  stateFails = 0;
  stalled = false;
  /** The offset of each district's newest keyframe, which `state_get` points at; none until one is committed. */
  keyframes = new Map<number, number>();
  /** The oldest offset retention has left; a read from before it is `trimmed`. */
  oldest = 0;
  constructor(districts: number, logs?: Uint8Array[][]) {
    this.logs = logs ?? Array.from({ length: districts }, () => []);
  }
  /** Append the next tick to a district's log; `live` also delivers it, with `skippedBefore` on its frame. */
  commit(district: number, live = true, skippedBefore = 0, keyframe = false): void {
    const log = this.logs[district]!;
    if (keyframe) this.keyframes.set(district, log.length);
    log.push(bytes(log.length, district, keyframe));
    if (live) this.deliver(district, log.length - 1, skippedBefore);
  }
  deliver(district: number, offset: number, skippedBefore = 0): void {
    this.handlers.get(`d0${district}`)?.({
      sub: district,
      offset,
      skippedBefore,
      payload: this.logs[district]![offset]!,
    });
  }
  async subscribe(
    _stream: string,
    slot: string,
    shard: number,
    _from: 'live',
    onEvent: (f: EventFrame) => void,
  ): Promise<Subscribed> {
    this.subscribes++;
    this.handlers.set(slot, onEvent);
    return { sub: shard, startOffset: null, liveOffset: this.logs[shard]!.length };
  }
  async read(_stream: string, shard: number, from: number, end?: number): Promise<Page> {
    this.reads.push([shard, from, end ?? -1]);
    if (this.stalled) return { records: [], nextOffset: from };
    if (from < this.oldest) throw new GatewayError('trimmed', 'gone', this.oldest);
    const log = this.logs[shard]!;
    const stop = Math.min(end ?? log.length, log.length);
    const records = [];
    for (let o = from; o < stop; o++) records.push({ offset: o, payload: log[o]! });
    return { records, nextOffset: stop };
  }
  async stateGet(): Promise<StateValue> {
    if (this.stateFails-- > 0) throw new GatewayError('state_failed', 'no such shard');
    const at = this.keyframes.get(0);
    if (at === undefined) return { payload: null, version: null, asOf: 0 };
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, BigInt(at), true);
    return { payload, version: null, asOf: 0 };
  }
}

const start = async (districts: number, setup: (g: FakeGateway) => void = () => {}) => {
  const gateway = new FakeGateway(districts);
  setup(gateway);
  const state = new CityState(city, trips, districts);
  const failed: Error[] = [];
  await follow(gateway as unknown as Gateway, state, (e) => failed.push(e));
  return { gateway, state, failed };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const commits = (g: FakeGateway, n: number) => {
  for (let i = 0; i < n; i++) g.commit(0, false);
};

describe('follow', () => {
  it('reads the log up to the subscription, then takes live records', async () => {
    const { gateway, state } = await start(1, (g) => commits(g, 5));
    expect(state.ticks[0]).toBe(4);
    gateway.commit(0);
    expect(state.ticks[0]).toBe(5);
  });

  it('resubscribes and reads what a frame says was skipped', async () => {
    const { gateway, state } = await start(1, (g) => commits(g, 3));
    gateway.commit(0, false);
    gateway.commit(0, false);
    gateway.commit(0, true, 2);
    await settle();
    expect(gateway.subscribes).toBe(2);
    expect(gateway.reads.at(-1)).toEqual([0, 3, 6]);
    expect(state.ticks[0]).toBe(5);
  });

  it('resubscribes when offsets jump, and keeps going afterwards', async () => {
    const { gateway, state } = await start(1, (g) => commits(g, 3));
    gateway.commit(0, false);
    gateway.commit(0);
    await settle();
    expect(gateway.subscribes).toBe(2);
    expect(state.ticks[0]).toBe(4);
    gateway.commit(0);
    expect(state.ticks[0]).toBe(5);
  });

  it('does not take a frame of the old subscription twice', async () => {
    const { gateway, state } = await start(1, (g) => commits(g, 2));
    gateway.commit(0, false);
    gateway.commit(0, true, 1);
    gateway.deliver(0, 2);
    await settle();
    expect(state.ticks[0]).toBe(3);
    expect(gateway.subscribes).toBe(2);
  });

  it('follows every district on its own', async () => {
    const { gateway, state } = await start(2, (g) => {
      commits(g, 2);
      g.commit(1, false);
    });
    gateway.commit(1, false);
    gateway.commit(1);
    await settle();
    expect(state.ticks).toEqual([1, 2]);
    expect(gateway.subscribes).toBe(3);
  });

  it('tries the other key routing when the first is refused', async () => {
    const { state } = await start(1, (g) => {
      commits(g, 2);
      g.stateFails = 1;
    });
    expect(state.ticks[0]).toBe(1);
  });

  it('gives up with an error when the log never gets it caught up', async () => {
    const gateway = new FakeGateway(1);
    commits(gateway, 3);
    gateway.stalled = true;
    const state = new CityState(city, trips, 1);
    await expect(follow(gateway as unknown as Gateway, state, () => {})).rejects.toThrow('would not catch up');
    expect(gateway.subscribes).toBe(3);
  });

  it('reports a failed resync to the session', async () => {
    const { gateway, failed } = await start(1, (g) => commits(g, 2));
    gateway.stalled = true;
    gateway.commit(0, false);
    gateway.commit(0, true, 1);
    await settle();
    await settle();
    expect(failed).toHaveLength(1);
  });
});

describe('a new session', () => {
  const trace = (state: CityState) => {
    const seen: [number, number, string][] = [];
    state.onRecord = (d, t, r) => seen.push([d, t, r]);
    return seen;
  };

  it('resumes after the last record handled, so none is read twice or missed', async () => {
    const first = new FakeGateway(1);
    commits(first, 5);
    const state = new CityState(city, trips, 1);
    const seen = trace(state);
    const feeds = createFeeds(state);
    await follow(first as unknown as Gateway, state, () => {}, feeds);
    // The gateway is gone for a while and the sim goes on.
    commits(first, 4);
    const second = new FakeGateway(1, first.logs);
    await follow(second as unknown as Gateway, state, () => {}, feeds);
    expect(second.reads[0]).toEqual([0, 5, 9]);
    expect(seen.map(([, t, r]) => `${t}:${r}`)).toEqual([
      '0:applied',
      '1:applied',
      '2:applied',
      '3:applied',
      '4:applied',
      '5:applied',
      '6:applied',
      '7:applied',
      '8:applied',
    ]);
    second.commit(0);
    expect(state.ticks[0]).toBe(9);
  });

  it('refolds from the newest keyframe when retention took what the feed needed', async () => {
    const first = new FakeGateway(1);
    commits(first, 3);
    const state = new CityState(city, trips, 1);
    const seen = trace(state);
    const feeds = createFeeds(state);
    await follow(first as unknown as Gateway, state, () => {}, feeds);
    for (let i = 3; i < 12; i++) first.commit(0, false, 0, i === 8);
    const second = new FakeGateway(1, first.logs);
    second.oldest = 5;
    second.keyframes = first.keyframes;
    await follow(second as unknown as Gateway, state, () => {}, feeds);
    expect(seen.filter(([, , r]) => r === 'applied').map(([, t]) => t)).toEqual([0, 1, 2, 8, 9, 10, 11]);
    second.commit(0);
    expect(state.ticks[0]).toBe(12);
  });

  it('does not wait for a future keyframe when none is left, and takes live records after', async () => {
    const first = new FakeGateway(1);
    commits(first, 3);
    const state = new CityState(city, trips, 1);
    const seen = trace(state);
    const feeds = createFeeds(state);
    await follow(first as unknown as Gateway, state, () => {}, feeds);
    // The only keyframe was at offset 3, and retention has taken it.
    for (let i = 3; i < 12; i++) first.commit(0, false, 0, i === 3);
    first.keyframes.clear();
    const second = new FakeGateway(1, first.logs);
    second.oldest = 5;
    await follow(second as unknown as Gateway, state, () => {}, feeds);
    expect(seen.filter(([, , r]) => r === 'applied').map(([, t]) => t)).toEqual([0, 1, 2, 5, 6, 7, 8, 9, 10, 11]);
    second.commit(0);
    expect(state.ticks[0]).toBe(12);
  });

  it('tells the loading screen as each district catches up', async () => {
    const gateway = new FakeGateway(3);
    const state = new CityState(city, trips, 3);
    const ready: number[] = [];
    await follow(
      gateway as unknown as Gateway,
      state,
      () => {},
      createFeeds(state),
      (d) => ready.push(d),
    );
    expect(ready.sort()).toEqual([0, 1, 2]);
  });
});
