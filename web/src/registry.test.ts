import { describe, expect, it, vi } from 'vitest';
import { GatewayError, type EventFrame, type Gateway, type Subscribed } from './gateway';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));
const { Registry, citySize, displayName, parseEntry } = await import('./registry');

const created = (name: string, districts = 2) =>
  new TextEncoder().encode(
    JSON.stringify({ kind: 'registry', type: 'created', name, seed: name, districts, wallUs: 1 }),
  );
const forked = (name: string, parent: string) =>
  new TextEncoder().encode(JSON.stringify({ kind: 'registry', type: 'forked', name, parent, tick: 9, wallUs: 2 }));

/** A registry stream of one shard: `froms` is where each subscribe asked to start. */
class FakeGateway {
  log: Uint8Array[] = [];
  froms: number[] = [];
  handler: ((f: EventFrame) => void) | null = null;
  write(payload: Uint8Array, deliver = true): void {
    this.log.push(payload);
    if (deliver) this.deliver(this.log.length - 1);
  }
  deliver(offset: number, skippedBefore = 0): void {
    this.handler?.({ sub: 1, offset, skippedBefore, payload: this.log[offset]! });
  }
  async subscribe(
    _s: string,
    _slot: string,
    _shard: number,
    from: number,
    on: (f: EventFrame) => void,
  ): Promise<Subscribed> {
    this.froms.push(from);
    this.handler = on;
    for (let o = from; o < this.log.length; o++) this.deliver(o);
    return { sub: 1, startOffset: from, liveOffset: this.log.length };
  }
}
const as = (g: FakeGateway) => g as unknown as Gateway;
const names = (lists: { name: string }[][]) => lists.at(-1)?.map((c) => c.name);

describe('Registry', () => {
  it('lists the cities written before the page opened and those written after', async () => {
    const gateway = new FakeGateway();
    gateway.write(created('harbor'), false);
    gateway.write(created('pinecrest'), false);
    const lists: { name: string }[][] = [];
    const registry = new Registry((c) => lists.push(c));
    await registry.attach(as(gateway));
    expect(names(lists)).toEqual(['harbor', 'pinecrest']);
    gateway.write(created('lakeside'));
    expect(names(lists)).toEqual(['harbor', 'pinecrest', 'lakeside']);
  });

  it('lists a city once, however often its record is read', async () => {
    const gateway = new FakeGateway();
    gateway.write(created('harbor'), false);
    gateway.write(created('harbor'), false);
    const lists: { name: string }[][] = [];
    await new Registry((c) => lists.push(c)).attach(as(gateway));
    expect(lists).toHaveLength(1);
  });

  it('follows on from the last record handled in a new session', async () => {
    const first = new FakeGateway();
    first.write(created('harbor'), false);
    first.write(created('pinecrest'), false);
    const lists: { name: string }[][] = [];
    const registry = new Registry((c) => lists.push(c));
    await registry.attach(as(first));
    const second = new FakeGateway();
    second.log = [...first.log];
    second.write(created('lakeside'), false);
    await registry.attach(as(second));
    expect(second.froms).toEqual([2]);
    expect(names(lists)).toEqual(['harbor', 'pinecrest', 'lakeside']);
  });

  it('subscribes again from the next offset when a frame says records were skipped', async () => {
    const gateway = new FakeGateway();
    await new Registry().attach(as(gateway));
    gateway.write(created('harbor'));
    gateway.write(created('pinecrest'), false);
    gateway.write(created('lakeside'), false);
    gateway.deliver(2, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(gateway.froms).toEqual([0, 1]);
    expect(gateway.handler).not.toBeNull();
  });

  it('tries again after a failed subscribe, with the same backoff as the city', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gateway = new FakeGateway();
    gateway.write(created('harbor'), false);
    const subscribe = gateway.subscribe.bind(gateway);
    let fails = 2;
    gateway.subscribe = (...args) => (fails-- > 0 ? Promise.reject(new Error('busy')) : subscribe(...args));
    const lists: { name: string }[][] = [];
    const attached = new Registry((c) => lists.push(c)).attach(as(gateway));
    await vi.advanceTimersByTimeAsync(3000);
    await attached;
    expect(names(lists)).toEqual(['harbor']);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('stops trying when its session is gone', async () => {
    const gateway = { subscribe: () => Promise.reject(new GatewayError('closed', 'gone')) };
    await expect(new Registry().attach(gateway as unknown as Gateway)).resolves.toBeUndefined();
  });

  it('lets the latest record of a name win', async () => {
    const gateway = new FakeGateway();
    gateway.write(created('harbor', 2), false);
    gateway.write(created('pinecrest', 2), false);
    gateway.write(created('harbor', 4), false);
    const registry = new Registry();
    await registry.attach(as(gateway));
    expect([...registry.cities.values()].map((c) => `${c.name}:${c.districts}`)).toEqual(['harbor:4', 'pinecrest:2']);
  });
});

describe('parseEntry', () => {
  it('reads created and forked records and nothing else', () => {
    expect(parseEntry(created('harbor', 4))).toMatchObject({ name: 'harbor', districts: 4, parent: null });
    expect(parseEntry(forked('harbor~a', 'harbor'))).toMatchObject({ name: 'harbor~a', parent: 'harbor' });
    expect(parseEntry(new TextEncoder().encode('{"kind":"tick"}'))).toBeNull();
  });
});

describe('citySize', () => {
  const entries = new Map(
    [parseEntry(created('big', 4))!, parseEntry(forked('big~a', 'big'))!, parseEntry(forked('lost~a', 'lost'))!].map(
      (e) => [e.name, e],
    ),
  );
  it('gives a fork the size of the city it came from, and 0 when that is not known', () => {
    expect(citySize(entries.get('big')!, entries)).toBe(4);
    expect(citySize(entries.get('big~a')!, entries)).toBe(4);
    expect(citySize(entries.get('lost~a')!, entries)).toBe(0);
  });
});

describe('displayName', () => {
  it('capitalises a city', () => expect(displayName('harbor')).toBe('Harbor'));
});
