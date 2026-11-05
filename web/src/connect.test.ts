import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, type EventFrame } from './gateway';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));
const { connect, signIn } = vi.hoisted(() => ({ connect: vi.fn(), signIn: vi.fn() }));
vi.mock('./auth', () => ({ signIn }));
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

beforeEach(() => signIn.mockResolvedValue('token'));

afterEach(() => {
  vi.useRealTimers();
  signIn.mockReset();
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

  /** A session that has caught up on an empty city, and keeps what is published through it. */
  const joined = (missing: string[]) => {
    const session = {
      missing,
      alive: true,
      published: [] as [string, Uint8Array][],
      onError: () => {},
      close: () => {},
      async subscribe() {
        return { sub: 1, startOffset: 0, liveOffset: 0 };
      },
      async stateGet() {
        return { payload: null, version: null, asOf: 0 };
      },
      async read() {
        return { records: [], nextOffset: 0 };
      },
      async publish(stream: string, payload: Uint8Array) {
        session.published.push([stream, payload]);
      },
    };
    return session;
  };

  it('sends commands through the session that caught up, and says when it cannot', async () => {
    const session = joined([]);
    connect.mockResolvedValue(session);
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    state.ticks[0] = 0;
    const live = await connectLive({ url: 'ws://x/ws', oidc: {} as never, city: 'harbor', state });
    expect(live.commands.blocked()).toBeNull();
    await live.commands.send(Uint8Array.of(1, 2));
    expect(session.published).toEqual([['commands', Uint8Array.of(1, 2)]]);
    session.alive = false;
    expect(live.commands.blocked()).toBe('down');
    await expect(live.commands.send(Uint8Array.of(3))).rejects.toMatchObject({ code: 'closed' });
    expect(session.published).toHaveLength(1);
    live.close();
  });

  it('knows a sign-in with no right to the command stream', async () => {
    connect.mockResolvedValue(joined(['commands']));
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    const live = await connectLive({ url: 'ws://x/ws', oidc: {} as never, city: 'harbor', state });
    expect(live.commands.blocked()).toBe('viewer');
    live.close();
  });

  it('knows a city the sim has not started: caught up, and not one tick', async () => {
    connect.mockResolvedValue(joined([]));
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    const live = await connectLive({ url: 'ws://x/ws', oidc: {} as never, city: 'pier', state });
    expect(live.commands.blocked()).toBe('idle');
    expect(live.commands.signedIn.city).toBe('pier');
    state.ticks[0] = 0;
    expect(live.commands.blocked()).toBeNull();
    live.close();
  });

  it('says who is signed in, from the token and the provider', async () => {
    const claims = (sub: string) => `h.${btoa(JSON.stringify({ sub, name: 'Ana' }))}.s`;
    connect.mockResolvedValue(joined([]));
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    const stand = { issuer: 'http://127.0.0.1:9400', client_id: 'x', scopes: 'openid' };
    signIn.mockResolvedValue(claims('viewer'));
    const local = await connectLive({ url: 'ws://x/ws', oidc: stand, city: 'harbor', state });
    expect(local.commands.signedIn).toEqual({ user: 'viewer', standIn: true, city: 'harbor' });
    local.close();
    signIn.mockResolvedValue(claims('a1b2'));
    const real = await connectLive({
      url: 'ws://x/ws',
      oidc: { ...stand, issuer: 'https://login.example.com' },
      city: 'harbor',
      state,
    });
    expect(real.commands.signedIn).toEqual({ user: 'Ana', standIn: false, city: 'harbor' });
    real.close();
  });

  it('is out of reach before it has a session', async () => {
    vi.useFakeTimers();
    connect.mockRejectedValue(new Error('cannot reach'));
    const state = new CityState({ lots: [] } as never, { trip: () => undefined }, 1);
    const live = await connectLive({ url: 'ws://x/ws', oidc: {} as never, city: 'harbor', state });
    expect(live.commands.blocked()).toBe('down');
    live.close();
  });
});
