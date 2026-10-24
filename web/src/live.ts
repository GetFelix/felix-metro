// The live connection: signs in, follows every district of the city through the gateway and feeds its records to the
// city's state.
import { signIn, type Oidc } from './auth';
import type { CityState, TickRecord } from './city';
import { decodeRecord, districtKey } from './core/felix_metro_core.js';
import { Gateway, GatewayError } from './gateway';

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
    const { payload } = await gateway.stateGet(STREAM, 'keyframe', key);
    if (!payload || payload.length < 8) continue;
    const offset = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true));
    const page = await gateway.read(STREAM, district, offset, offset + 1);
    const record = page.records[0] && parse(page.records[0].payload);
    if (record && record.district === district && record.keyframe) return offset;
  }
  return 0;
}

/**
 * Follow every district: subscribe live first, so nothing committed from here on is missed, then read the district's
 * log from its latest keyframe up to where the subscription starts, then let the live records through. Resolves once
 * every district is caught up; the records after that keep arriving until the session ends.
 */
async function follow(gateway: Gateway, state: CityState): Promise<void> {
  const districts = state.ticks.length;
  const waiting: TickRecord[][] = Array.from({ length: districts }, () => []);
  const caughtUp = Array<boolean>(districts).fill(false);
  const live = await Promise.all(
    Array.from({ length: districts }, (_, d) =>
      gateway.subscribe(STREAM, slot(d), d, 'live', (frame) => {
        const record = parse(frame.payload);
        if (!record) return;
        if (caughtUp[d]) state.apply(record);
        else waiting[d]!.push(record);
      }),
    ),
  );
  await Promise.all(
    live.map(async (subscribed, d) => {
      const tail = subscribed.liveOffset ?? 0;
      let from = await keyframeOffset(gateway, d, districts);
      while (from < tail) {
        let page;
        try {
          page = await gateway.read(STREAM, d, from, tail);
        } catch (err) {
          // Retention moved past the keyframe; start from what is left.
          if (err instanceof GatewayError && err.code === 'trimmed' && err.oldest !== undefined && err.oldest > from) {
            from = err.oldest;
            continue;
          }
          throw err;
        }
        for (const r of page.records) {
          const record = parse(r.payload);
          if (record) state.apply(record);
        }
        if (page.nextOffset <= from) break;
        from = page.nextOffset;
      }
      for (const record of waiting[d]!.splice(0)) state.apply(record);
      caughtUp[d] = true;
    }),
  );
}

/**
 * Connect, catch up and keep following. Resolves when the first connection has caught up, and rejects if it cannot
 * be made. After that a dropped session is replaced, with the same state carrying on.
 */
export async function connectLive(options: LiveOptions): Promise<{ close(): void }> {
  const { url, oidc, city, state, onStatus } = options;
  let closed = false;
  let current: Gateway | null = null;

  const session = async () => {
    const token = await signIn(oidc);
    const gateway = await Gateway.connect(url, city, token);
    current = gateway;
    const ended = new Promise<void>((resolve) => {
      gateway.onError = (err) => {
        if (err.code === 'closed') resolve();
        else console.error('gateway', err.code, err.message);
      };
    });
    await follow(gateway, state);
    onStatus?.('live');
    return { ended };
  };

  let { ended } = await session();
  void (async () => {
    for (;;) {
      await ended;
      if (closed) return;
      onStatus?.('reconnecting');
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
    close() {
      closed = true;
      current?.close();
    },
  };
}
