// The browser end of felix-gateway's protocol, as much of it as the city uses: join, subscriptions in named slots on
// a chosen shard whose events arrive as binary frames, ranged reads and state reads. felix-gateway's
// docs/protocol.md is the reference.

/** The optional protocol features the city needs. */
export const FEATURES = ['binary_events', 'slots', 'shards', 'state', 'read'] as const;

/** A session may have this many reads waiting at once; the gateway refuses a fifth. */
const READS_IN_FLIGHT = 4;

/** One event frame from the gateway. */
export interface EventFrame {
  /** The subscription, as its `subscribed` numbered it. */
  sub: number;
  /** The log offset, or `null` on a stream with no log. */
  offset: number | null;
  skippedBefore: number;
  payload: Uint8Array;
}

const EVENT_KIND = 1;
const NO_OFFSET = 0xffff_ffff_ffff_ffffn;
const MIN_HEADER = 40;

/** Parse one binary frame, or `null` for a kind this client does not know. */
export function parseFrame(data: ArrayBuffer): EventFrame | null {
  const view = new DataView(data);
  if (data.byteLength < 2 || view.getUint8(0) !== EVENT_KIND) return null;
  // The header may grow; the payload starts where its length byte says.
  const headerLen = view.getUint8(1);
  if (headerLen < MIN_HEADER || data.byteLength < headerLen) return null;
  const offset = view.getBigUint64(8, true);
  return {
    sub: view.getUint32(4, true),
    offset: offset === NO_OFFSET ? null : Number(offset),
    skippedBefore: view.getUint32(16, true),
    payload: new Uint8Array(data, headerLen),
  };
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function unbase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What `subscribed` reports. */
export interface Subscribed {
  sub: number;
  startOffset: number | null;
  liveOffset: number | null;
}

/** One page of a `read`. */
export interface Page {
  records: { offset: number; payload: Uint8Array }[];
  /** Where the next page starts. */
  nextOffset: number;
}

/** What `state_get` answers. */
export interface StateValue {
  payload: Uint8Array | null;
  /** The offset of the commit that wrote the value. */
  version: number | null;
  asOf: number;
}

/** An error the gateway answered with. */
export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    readonly code: string,
    message: string,
    /** For `trimmed`: the oldest offset the shard still holds. */
    readonly oldest?: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

interface Pending {
  onEvent: (frame: EventFrame) => void;
  resolve: (subscribed: Subscribed) => void;
  reject: (err: Error) => void;
}

interface Request {
  resolve: (json: Json) => void;
  reject: (err: Error) => void;
}

/** One joined session on the gateway. */
export class Gateway {
  /** Frame handlers by subscription number. */
  private readonly handlers = new Map<number, (frame: EventFrame) => void>();
  /** The current subscription number of each `stream/slot`. */
  private readonly slots = new Map<string, number>();
  /** Subscribes waiting for an answer, oldest first, by `stream/slot`. */
  private readonly pending = new Map<string, Pending[]>();
  /** Requests waiting for an answer that names their id: publishes, reads and state reads. */
  private readonly requests = new Map<number, Request>();
  private readonly queuedReads: (() => void)[] = [];
  private reading = 0;
  private nextId = 1;
  private closing = false;
  /** Called with errors that answer no pending request, such as `subscription_ended`. */
  onError: (err: GatewayError) => void = () => {};

  private constructor(
    private readonly socket: WebSocket,
    /** Aliases of optional resources this sign-in does not reach, from `hello`. */
    readonly missing: readonly string[],
  ) {
    socket.addEventListener('message', (message) => this.receive(message));
    socket.addEventListener('close', () => {
      if (!this.closing) this.onError(new GatewayError('closed', 'the gateway closed the session'));
    });
  }

  /** Open a session on `city` with an ID token, asking for {@link FEATURES}. */
  static connect(url: string, city: string, token: string): Promise<Gateway> {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      const fail = (err: Error) => {
        socket.close();
        reject(err);
      };
      socket.addEventListener('error', () => fail(new Error(`cannot reach ${url}`)), { once: true });
      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ type: 'join', protocol: 1, features: FEATURES, city, token })),
      );
      socket.addEventListener(
        'message',
        (message) => {
          const hello = JSON.parse(String(message.data)) as Json;
          if (hello.type !== 'hello') {
            return fail(new GatewayError(String(hello.code), String(hello.message)));
          }
          const features = hello.features as string[];
          const missing = FEATURES.filter((feature) => !features.includes(feature));
          if (missing.length > 0) return fail(new Error(`the gateway lacks ${missing.join(', ')}`));
          resolve(new Gateway(socket, (hello.missing as string[] | undefined) ?? []));
        },
        { once: true },
      );
    });
  }

  /**
   * Subscribe to `shard` of `stream` in `slot`, from `"live"` or a log offset of that shard. Replaces any earlier
   * subscription in the same slot; frames of the old one stop reaching their handler.
   */
  subscribe(
    stream: string,
    slot: string,
    shard: number,
    from: number | 'live',
    onEvent: (frame: EventFrame) => void,
  ): Promise<Subscribed> {
    const key = `${stream}/${slot}`;
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(key) ?? [];
      queue.push({ onEvent, resolve, reject });
      this.pending.set(key, queue);
      this.socket.send(JSON.stringify({ type: 'subscribe', stream, slot, shard, from }));
    });
  }

  /**
   * Read the records of `shard` from `from` up to, not including, `end`: one page, as the broker's cap allows. Read
   * the next page from its `nextOffset`. At most four reads are on the wire at once; the rest wait their turn.
   */
  read(stream: string, shard: number, from: number, end?: number): Promise<Page> {
    return this.limited(async () => {
      const json = await this.request({ type: 'read', stream, shard, from, ...(end === undefined ? {} : { end }) });
      const records = (json.records as { offset: number; payload: string }[]).map((r) => ({
        offset: r.offset,
        payload: unbase64(r.payload),
      }));
      return { records, nextOffset: json.next_offset as number };
    });
  }

  /**
   * One key of a stream's state. `entity` is the key that picks the shard, as the writer's commit named it.
   */
  async stateGet(stream: string, key: string, entity: string): Promise<StateValue> {
    const json = await this.request({ type: 'state_get', stream, key, entity });
    return {
      payload: json.payload === null ? null : unbase64(String(json.payload)),
      version: (json.version as number | null) ?? null,
      asOf: json.as_of as number,
    };
  }

  /** Publish `payload` to `stream` and wait for Felix to take it. */
  async publish(stream: string, payload: Uint8Array): Promise<void> {
    await this.request({ type: 'publish', stream, payload: base64(payload), ack: true });
  }

  close(): void {
    this.closing = true;
    this.socket.close();
  }

  private request(message: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ ...message, id }));
    });
  }

  private async limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.reading >= READS_IN_FLIGHT) await new Promise<void>((go) => this.queuedReads.push(go));
    this.reading++;
    try {
      return await run();
    } finally {
      this.reading--;
      this.queuedReads.shift()?.();
    }
  }

  /**
   * The oldest unanswered subscribe for this answer. The gateway answers a connection's subscribes in order, each
   * with `subscribed` or an error. An error that names no slot is matched by its stream alone.
   */
  private answered(json: Json): { key: string; request: Pending; superseded: boolean } | null {
    let key = `${String(json.stream)}/${String(json.slot)}`;
    if (json.slot === undefined && !this.pending.has(key)) {
      key = [...this.pending.keys()].find((k) => k.startsWith(`${String(json.stream)}/`)) ?? key;
    }
    const queue = this.pending.get(key);
    const request = queue?.shift();
    if (!queue || !request) return null;
    if (queue.length === 0) this.pending.delete(key);
    return { key, request, superseded: queue.length > 0 };
  }

  private receive(message: MessageEvent): void {
    if (message.data instanceof ArrayBuffer) {
      const frame = parseFrame(message.data);
      if (frame) this.handlers.get(frame.sub)?.(frame);
      return;
    }
    const json = JSON.parse(String(message.data)) as Json;
    if (json.type === 'subscribed') {
      const answer = this.answered(json);
      if (!answer) return;
      const { key, request, superseded } = answer;
      const previous = this.slots.get(key);
      if (previous !== undefined) this.handlers.delete(previous);
      // A later subscribe to the same slot replaces this one at the gateway.
      if (superseded) {
        this.slots.delete(key);
        return request.reject(new Error('replaced'));
      }
      const sub = json.sub as number;
      this.slots.set(key, sub);
      this.handlers.set(sub, request.onEvent);
      request.resolve({
        sub,
        startOffset: json.start_offset as number | null,
        liveOffset: json.live_offset as number | null,
      });
    } else if (json.type === 'error') {
      const err = new GatewayError(
        String(json.code),
        String(json.message),
        typeof json.oldest === 'number' ? json.oldest : undefined,
      );
      const waiting = typeof json.id === 'number' ? this.requests.get(json.id) : undefined;
      if (waiting) {
        this.requests.delete(json.id as number);
        return waiting.reject(err);
      }
      // `subscription_ended` follows a `subscribed`, and an error with an id answers a request, so neither answers a
      // subscribe.
      const answer = json.code === 'subscription_ended' || json.id !== undefined ? null : this.answered(json);
      if (answer) answer.request.reject(err);
      else this.onError(err);
    } else if (typeof json.id === 'number') {
      // ack, records and state_value name the request they answer.
      this.requests.get(json.id)?.resolve(json);
      this.requests.delete(json.id);
    }
  }
}
