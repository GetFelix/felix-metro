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
const { follow } = await import('./live');

const city = { lots: [] } as unknown as City;
const trips: Trips = { trip: () => undefined };
const bytes = (tick: number, district: number) =>
  new TextEncoder().encode(
    JSON.stringify({ kind: 'tick', epoch: 1, district, tick, speed: 4, keyframe: null, events: [] }),
  );

/** A gateway over one shard per district whose log the test writes and whose subscription it can feed. */
class FakeGateway {
  logs: Uint8Array[][];
  handlers = new Map<string, (f: EventFrame) => void>();
  subscribes = 0;
  reads: [number, number, number][] = [];
  stateFails = 0;
  stalled = false;
  constructor(districts: number) {
    this.logs = Array.from({ length: districts }, () => []);
  }
  /** Append the next tick to a district's log; `live` also delivers it, with `skippedBefore` on its frame. */
  commit(district: number, live = true, skippedBefore = 0): void {
    const log = this.logs[district]!;
    log.push(bytes(log.length, district));
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
    const log = this.logs[shard]!;
    const stop = Math.min(end ?? log.length, log.length);
    const records = [];
    for (let o = from; o < stop; o++) records.push({ offset: o, payload: log[o]! });
    return { records, nextOffset: stop };
  }
  async stateGet(): Promise<StateValue> {
    if (this.stateFails-- > 0) throw new GatewayError('state_failed', 'no such shard');
    return { payload: null, version: null, asOf: 0 };
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
