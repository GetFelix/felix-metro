// The live connection: signs in, follows every district of the city through the gateway and feeds its records to the
// city's state.
import { signIn, type Oidc } from './auth';
import type { CityState, TickRecord } from './city';
import { decodeRecord, districtKey } from './core/felix_metro_core.js';
import { Gateway, GatewayError, type EventFrame } from './gateway';
import { Registry, type CityEntry } from './registry';

const STREAM = 'events';
const ROUTINGS = ['modulo', 'jump_hash'];
const RETRY_MS = [1000, 2000, 5000];

export type Status = 'live' | 'reconnecting';

export interface LiveOptions {
  /** The gateway's WebSocket URL. */
  url: string;
  oidc: Oidc;
  /** The city's name at the gateway. */
  city: string;
  state: CityState;
  onStatus?: (status: Status) => void;
  /** Told when a district has caught up for the first time, for the loading screen. */
  onDistrict?: (district: number) => void;
  /** Told with every city the registry lists, each time it changes. */
  onCities?: (cities: CityEntry[]) => void;
}

const slot = (district: number) => `d${String(district).padStart(2, '0')}`;

function parse(bytes: Uint8Array): TickRecord | null {
  try {
    const record = JSON.parse(decodeRecord(bytes));
    return record.kind === 'tick' ? (record as TickRecord) : null;
  } catch (err) {
    console.error('a record did not decode', err);
    return null;
  }
}

/**
 * The offset of a district's latest keyframe. The sim writes it as the state key `keyframe` under the district's own
 * entity key, which depends on how the stream hashes keys; Felix does not say, so each is tried and a pointer is
 * trusted only if the record it names is that district's keyframe. Zero, the start of the log, when there is none.
 */
async function keyframeOffset(gateway: Gateway, district: number, districts: number): Promise<number> {
  const keys = new Set<string>();
  for (const routing of ROUTINGS) {
    try {
      keys.add(districtKey(district, districts, routing));
    } catch {
      // No salt puts this district on a shard under this routing.
    }
  }
  for (const key of keys) {
    let payload;
    try {
      ({ payload } = await gateway.stateGet(STREAM, 'keyframe', key));
    } catch (err) {
      // Asked under the wrong routing the gateway can refuse; the other routing may answer.
      if (err instanceof GatewayError && err.code !== 'closed') continue;
      throw err;
    }
    if (!payload || payload.length < 8) continue;
    const offset = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true));
    let page;
    try {
      page = await gateway.read(STREAM, district, offset, offset + 1);
    } catch (err) {
      // Retention has taken the keyframe; the caller starts from what is left.
      if (err instanceof GatewayError && err.code === 'trimmed') return 0;
      throw err;
    }
    const record = page.records[0] && parse(page.records[0].payload);
    if (record && record.district === district && record.keyframe) return offset;
  }
  return 0;
}

/** How many times a district tries to catch up, the last one taking the log as it is, before the session is dropped. */
const ATTEMPTS = 3;

/** One district's shard: its live subscription, the catch-up read, and the check that nothing was missed. */
class Feed {
  /** The offset of the last record handled, or -1 before any. */
  private last = -1;
  private waiting: { offset: number | null; record: TickRecord | null }[] = [];
  private caughtUp = false;
  private resyncing = false;
  /** Retention passed where this had to resume: records are skipped up to the next keyframe, which refolds the state. */
  private refold = false;
  /** Counts the sessions this feed has been attached to, so a stale resync does not touch the current one. */
  private generation = 0;
  private gateway!: Gateway;
  private onFail: (err: Error) => void = () => {};

  constructor(
    private readonly state: CityState,
    readonly district: number,
    private readonly districts: number,
  ) {}

  /** Move to a new session. What was handled stays handled, so the next start resumes after it. */
  attach(gateway: Gateway, onFail: (err: Error) => void): void {
    this.gateway = gateway;
    this.onFail = onFail;
    this.generation++;
    this.caughtUp = false;
    this.resyncing = false;
    this.waiting = [];
  }

  get slot(): string {
    return slot(this.district);
  }

  /** Subscribe live first, so nothing committed from here on is missed, then read up to where the subscription starts. */
  async start(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (await this.catchUp(attempt === ATTEMPTS - 1)) return;
      if (attempt === ATTEMPTS - 1) throw new Error(`district ${this.district} would not catch up`);
    }
  }

  /** The subscription dropped records or ended: subscribe again and read from the last offset handled plus one. */
  lost(): void {
    if (this.resyncing) return;
    const generation = this.generation;
    this.resyncing = true;
    this.caughtUp = false;
    this.start().then(
      () => {
        if (generation === this.generation) this.resyncing = false;
      },
      (err) => {
        if (generation !== this.generation) return;
        this.resyncing = false;
        this.onFail(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  /**
   * Take a record at `offset`. False when it cannot be taken yet: the offset skips one, or the record skips a tick.
   * `lenient` takes it anyway, after the log has been tried and cannot do better.
   */
  private take(offset: number | null, record: TickRecord | null, lenient: boolean): boolean {
    if (offset !== null) {
      if (offset <= this.last) return true;
      if (this.last >= 0 && offset !== this.last + 1 && !lenient) return false;
    }
    if (this.refold) {
      if (!record?.keyframe) {
        if (offset !== null) this.last = offset;
        return true;
      }
      this.refold = false;
    }
    if (record && this.state.apply(record, lenient) === 'gap') return false;
    if (offset !== null) this.last = offset;
    return true;
  }

  private onFrame(frame: EventFrame): void {
    const record = parse(frame.payload);
    if (!this.caughtUp) {
      this.waiting.push({ offset: frame.offset, record });
    } else if (frame.skippedBefore > 0 || !this.take(frame.offset, record, false)) {
      this.lost();
    }
  }

  /** One try; false when the log showed a hole to try again for. */
  private async catchUp(lenient: boolean): Promise<boolean> {
    this.caughtUp = false;
    this.waiting = [];
    const gateway = this.gateway;
    const subscribed = await gateway.subscribe(STREAM, this.slot, this.district, 'live', (f) => this.onFrame(f));
    const tail = subscribed.liveOffset ?? 0;
    // After a hole the last try starts from the keyframe, which repairs whatever the hole took.
    let from = this.last + 1;
    if (this.last < 0 || lenient) from = Math.max(from, await keyframeOffset(gateway, this.district, this.districts));
    while (from < tail) {
      let page;
      try {
        page = await gateway.read(STREAM, this.district, from, tail);
      } catch (err) {
        // Retention moved past where this needs to start: what is left is folded from its first keyframe.
        if (err instanceof GatewayError && err.code === 'trimmed' && err.oldest !== undefined && err.oldest > from) {
          from = err.oldest;
          this.last = from - 1;
          this.refold = true;
          lenient = true;
          continue;
        }
        throw err;
      }
      if (gateway !== this.gateway) throw new Error('the session ended');
      for (const r of page.records) {
        if (!this.take(r.offset, parse(r.payload), lenient)) return false;
      }
      if (page.nextOffset <= from) return false;
      from = page.nextOffset;
    }
    // No await from here to the flag, so no frame lands between the last of the backlog and going live.
    for (const w of this.waiting.splice(0)) {
      if (!this.take(w.offset, w.record, lenient)) return false;
    }
    this.caughtUp = true;
    return true;
  }
}

/** One feed per district, which outlive the sessions they follow through. */
export function createFeeds(state: CityState): Feed[] {
  const districts = state.ticks.length;
  return Array.from({ length: districts }, (_, d) => new Feed(state, d, districts));
}

/**
 * Follow every district. Resolves once each is caught up; the records after that keep arriving until the session ends.
 * Feeds from an earlier session resume after the last record they handled.
 */
export async function follow(
  gateway: Gateway,
  state: CityState,
  onFail: (err: Error) => void,
  feeds: Feed[] = createFeeds(state),
  onDistrict?: (district: number) => void,
): Promise<Feed[]> {
  for (const feed of feeds) feed.attach(gateway, onFail);
  await Promise.all(feeds.map((feed) => feed.start().then(() => onDistrict?.(feed.district))));
  return feeds;
}

/**
 * Connect, catch up and keep following. Resolves when the first attempt has finished, with `connected` false when it
 * failed; either way a dropped or missing session is replaced, with the same state carrying on.
 */
export async function connectLive(options: LiveOptions): Promise<{ connected: boolean; close(): void }> {
  const { url, oidc, city, state, onStatus, onDistrict, onCities } = options;
  let closed = false;
  let current: Gateway | null = null;
  const feeds = createFeeds(state);
  const registry = new Registry(onCities);

  const session = async () => {
    const token = await signIn(oidc);
    const gateway = await Gateway.connect(url, city, token);
    current = gateway;
    let end = () => {};
    const ended = new Promise<void>((resolve) => (end = resolve));
    // Closing says nothing to `onError`, so a session this page gives up on ends here.
    const fail = (err: Error) => {
      console.error('the live session failed', err);
      gateway.close();
      end();
    };
    gateway.onError = (err) => {
      if (err.code === 'closed') end();
      else if (err.code === 'subscription_ended') {
        if (err.slot === undefined || err.slot === registry.slot) registry.lost();
        for (const feed of feeds) if (err.slot === undefined || err.slot === feed.slot) feed.lost();
      } else console.error('gateway', err.code, err.message);
    };
    try {
      await follow(gateway, state, fail, feeds, onDistrict);
    } catch (err) {
      gateway.close();
      throw err;
    }
    void registry.attach(gateway);
    onStatus?.('live');
    return { ended };
  };

  let ended: Promise<void> | null = null;
  let connected = false;
  try {
    ({ ended } = await session());
    connected = true;
  } catch (err) {
    console.warn('the first connection failed', err);
    onStatus?.('reconnecting');
  }
  void (async () => {
    for (;;) {
      if (ended) {
        await ended;
        if (closed) return;
        onStatus?.('reconnecting');
      }
      for (let attempt = 0; ; attempt++) {
        await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
        if (closed) return;
        try {
          ({ ended } = await session());
          break;
        } catch (err) {
          console.error('reconnect', err);
        }
      }
    }
  })();
  return {
    connected,
    close() {
      closed = true;
      current?.close();
    },
  };
}
