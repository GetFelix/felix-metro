import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, type EventFrame } from './gateway';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  districtKey: (district: number) => `k${district}`,
}));
vi.mock('./auth', () => ({ signIn: async () => 'token' }));
const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('./gateway', async (original) => ({
  ...(await original<typeof import('./gateway')>()),
  Gateway: { connect },
}));
const { connectLive } = await import('./live');
const { CityState } = await import('./city');

const entry = new TextEncoder().encode(
  JSON.stringify({ kind: 'registry', type: 'created', name: 'harbor', seed: 'harbor', districts: 2, wallUs: 1 }),
);

/** A session that has the city list and nothing else. */
const listing = () => ({
  onError: () => {},
  close: () => {},
  async subscribe(_s: string, _slot: string, _shard: number, _from: number, on: (f: EventFrame) => void) {
    on({ sub: 1, offset: 0, skippedBefore: 0, payload: entry });
    return { sub: 1, startOffset: 0, liveOffset: 1 };
  },
});

afterEach(() => {
  vi.useRealTimers();
  connect.mockReset();
});

describe('connectLive', () => {
  it('stops at a refused city, says so, and still lists the cities', async () => {
    vi.useFakeTimers();
    connect.mockImplementation(async (_url: string, city: string) => {
      if (city === 'typo') throw new GatewayError('forbidden', 'no such scope');
      return listing();
    });
    const refused = vi.fn();
    const lists: string[][] = [];
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    const live = await connectLive({
      url: 'ws://x/ws',
      oidc: {} as never,
      city: 'typo',
      state,
      onRefused: refused,
      onCities: (c) => lists.push(c.map((e) => e.name)),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.refused).toBe(true);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls.filter((c) => c[1] === 'typo')).toHaveLength(1);
    expect(lists.at(-1)).toEqual(['harbor']);
    live.close();
  });

  it('keeps retrying a city it cannot reach', async () => {
    vi.useFakeTimers();
    connect.mockRejectedValue(new Error('cannot reach'));
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    const live = await connectLive({ url: 'ws://x/ws', oidc: {} as never, city: 'harbor', state });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(live.refused).toBe(false);
    expect(connect.mock.calls.length).toBeGreaterThan(2);
    live.close();
  });
});
