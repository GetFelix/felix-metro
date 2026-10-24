import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gateway, GatewayError, base64, parseFrame, unbase64 } from './gateway';

describe('parseFrame', () => {
  const frame = (headerLen: number, offset: bigint) => {
    const bytes = new Uint8Array(headerLen + 2);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 1);
    view.setUint8(1, headerLen);
    view.setUint32(4, 9, true);
    view.setBigUint64(8, offset, true);
    view.setUint32(16, 2, true);
    bytes.set([0xaa, 0xbb], headerLen);
    return bytes.buffer;
  };

  it('splits the header from the payload', () => {
    const parsed = parseFrame(frame(40, 42n))!;
    expect(parsed).toMatchObject({ sub: 9, offset: 42, skippedBefore: 2 });
    expect([...parsed.payload]).toEqual([0xaa, 0xbb]);
  });

  it('finds the payload by the header length, so the header can grow', () => {
    expect([...parseFrame(frame(48, 1n))!.payload]).toEqual([0xaa, 0xbb]);
  });

  it('reads the no-offset marker as null and skips unknown kinds', () => {
    expect(parseFrame(frame(40, 0xffff_ffff_ffff_ffffn))!.offset).toBeNull();
    const other = new Uint8Array(frame(40, 1n));
    other[0] = 2;
    expect(parseFrame(other.buffer)).toBeNull();
  });
});

describe('base64', () => {
  it('round trips bytes', () => {
    const bytes = Uint8Array.from([0, 1, 254, 255, 128]);
    expect([...unbase64(base64(bytes))]).toEqual([...bytes]);
  });
});

/** A socket the test drives: what the page sends is in `sent`, and `say` is the gateway talking. */
class FakeSocket extends EventTarget {
  static last: FakeSocket;
  binaryType = '';
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  say(message: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }),
    );
  }
}

const real = globalThis.WebSocket;
beforeEach(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = real;
});

async function joined() {
  const connecting = Gateway.connect('ws://x/ws', 'harbor', 'token');
  await Promise.resolve();
  await Promise.resolve();
  const socket = FakeSocket.last;
  socket.say({ type: 'hello', features: ['binary_events', 'slots', 'shards', 'state', 'read'] });
  return { gateway: await connecting, socket };
}

describe('Gateway', () => {
  it('joins a city and asks for the features it needs', async () => {
    const { socket } = await joined();
    expect(socket.sent[0]).toMatchObject({
      type: 'join',
      protocol: 1,
      city: 'harbor',
      token: 'token',
      features: ['binary_events', 'slots', 'shards', 'state', 'read'],
    });
  });

  it('refuses a gateway without a feature it needs', async () => {
    const connecting = Gateway.connect('ws://x/ws', 'harbor', 'token');
    await Promise.resolve();
    await Promise.resolve();
    FakeSocket.last.say({ type: 'hello', features: ['slots'] });
    await expect(connecting).rejects.toThrow('lacks');
  });

  it('subscribes to one shard in its own slot', async () => {
    const { gateway, socket } = await joined();
    const seen: number[] = [];
    const subscribed = gateway.subscribe('events', 'd02', 2, 'live', (f) => seen.push(f.offset!));
    expect(socket.sent[1]).toEqual({ type: 'subscribe', stream: 'events', slot: 'd02', shard: 2, from: 'live' });
    socket.say({
      type: 'subscribed',
      stream: 'events',
      slot: 'd02',
      shard: 2,
      sub: 7,
      start_offset: 5,
      live_offset: 5,
    });
    expect(await subscribed).toEqual({ sub: 7, startOffset: 5, liveOffset: 5 });
    const bytes = new Uint8Array(41);
    new DataView(bytes.buffer).setUint8(0, 1);
    new DataView(bytes.buffer).setUint8(1, 40);
    new DataView(bytes.buffer).setUint32(4, 7, true);
    new DataView(bytes.buffer).setBigUint64(8, 5n, true);
    socket.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
    expect(seen).toEqual([5]);
  });

  it('reads a range and answers with the decoded records', async () => {
    const { gateway, socket } = await joined();
    const page = gateway.read('events', 1, 10, 20);
    expect(socket.sent[1]).toMatchObject({ type: 'read', stream: 'events', shard: 1, from: 10, end: 20 });
    socket.say({
      type: 'records',
      id: socket.sent[1]!.id,
      records: [{ offset: 10, payload: base64(Uint8Array.from([1, 2])) }],
      next_offset: 11,
    });
    const { records, nextOffset } = await page;
    expect(nextOffset).toBe(11);
    expect([...records[0]!.payload]).toEqual([1, 2]);
  });

  it('keeps no more than four reads on the wire', async () => {
    const { gateway, socket } = await joined();
    const reads = Array.from({ length: 6 }, (_, i) => gateway.read('events', i, 0));
    await Promise.resolve();
    const onWire = () => socket.sent.filter((m) => m.type === 'read');
    expect(onWire()).toHaveLength(4);
    socket.say({ type: 'records', id: onWire()[0]!.id, records: [], next_offset: 0 });
    await reads[0];
    await Promise.resolve();
    expect(onWire()).toHaveLength(5);
  });

  it('turns a trimmed read into an error that names the oldest offset left', async () => {
    const { gateway, socket } = await joined();
    const page = gateway.read('events', 0, 1);
    socket.say({ type: 'error', code: 'trimmed', message: 'gone', id: socket.sent[1]!.id, oldest: 900 });
    const err = await page.catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ code: 'trimmed', oldest: 900 });
  });

  it('reads a state key under the entity that picks the shard', async () => {
    const { gateway, socket } = await joined();
    const value = gateway.stateGet('events', 'keyframe', 'd01.3');
    expect(socket.sent[1]).toMatchObject({ type: 'state_get', stream: 'events', key: 'keyframe', entity: 'd01.3' });
    socket.say({
      type: 'state_value',
      id: socket.sent[1]!.id,
      payload: base64(Uint8Array.from([9])),
      version: 40,
      as_of: 44,
    });
    expect(await value).toMatchObject({ version: 40, asOf: 44 });
    const none = gateway.stateGet('events', 'keyframe', 'd02');
    socket.say({ type: 'state_value', id: socket.sent[2]!.id, payload: null, version: null, as_of: 44 });
    expect((await none).payload).toBeNull();
  });
});
