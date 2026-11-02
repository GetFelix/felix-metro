import { afterEach, describe, expect, it, vi } from 'vitest';
import { CityState, type TickRecord, type Trips } from './city';
import { GatewayError, type Gateway, type Page } from './gateway';
import type { City } from './layout';
import { hourStart } from './rewind';
import { fold, SeekError, type SeekResult } from './seek';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  districtKey: () => '',
}));
vi.mock('./auth', () => ({ signIn: async () => 'token' }));
const { Playback } = await import('./playback');

const city = { lots: [] } as unknown as City;
const trips: Trips = { trip: () => undefined };
const DISTRICTS = 2;
const LENGTH = 1000;

/** Tick `n` of district `d`: it builds lot `d` with kind `n`, so a folded state shows which tick it was folded to. */
const record = (d: number, tick: number): TickRecord => ({
  kind: 'tick',
  epoch: 1,
  district: d,
  tick,
  speed: 4,
  keyframeOffset: hourStart(tick),
  wallUs: 0,
  keyframe: tick % 240 === 0 ? { buildings: [[d, tick, 0]] } : null,
  events: tick % 240 === 0 ? [] : [{ type: 'built', lot: d, kind: tick, rotation: 0 }],
});

/** What a seek to `tick` finds when each district's log holds tick `n` at offset `n`. */
const seekTo = (tick: number): SeekResult => ({
  tick,
  requested: tick,
  exact: true,
  districts: Array.from({ length: DISTRICTS }, (_, d) => ({
    records: Array.from({ length: tick - hourStart(tick) + 1 }, (_, i) => record(d, hourStart(tick) + i)),
    offset: tick,
    before: [],
  })),
});

const foldedTo = (tick: number) => {
  const state = new CityState(city, trips, DISTRICTS);
  fold(state, seekTo(tick));
  return state;
};

/** The log as a gateway session, for the pumps a rewind hands over to when it turns forward. */
const source = () => {
  const reads: [number, number][] = [];
  const session = {
    async read(_stream: string, shard: number, from: number): Promise<Page> {
      reads.push([shard, from]);
      if (from >= LENGTH) throw new GatewayError('read_failed', `offset ${from} is past the end`);
      const stop = Math.min(LENGTH, from + 50);
      const records = [];
      for (let o = from; o < stop; o++)
        records.push({ offset: o, payload: new TextEncoder().encode(JSON.stringify(record(shard, o))) });
      return { records, nextOffset: stop };
    },
    subscribe: async () => ({ sub: 0, startOffset: 0, liveOffset: 0 }),
  };
  return { reads, session: session as unknown as Pick<Gateway, 'read' | 'subscribe'> };
};

interface Rig {
  p: InstanceType<typeof Playback>;
  /** Every state the playback put on screen, with the tick it was folded to. */
  shown: [CityState, number][];
  fetched: number[];
  /** The abort signal each hour fetch was given. */
  signals: AbortSignal[];
  /** The seek result each replacement state was folded from. */
  seeks: SeekResult[];
  edges: number[];
  failures: Error[];
  /** Hold the hour fetches until `release` is called. */
  release(): void;
}

const rig = (at: number, opts: { gate?: boolean; oldest?: number; src?: ReturnType<typeof source> } = {}): Rig => {
  const shown: [CityState, number][] = [];
  const fetched: number[] = [];
  const signals: AbortSignal[] = [];
  const seeks: SeekResult[] = [];
  const edges: number[] = [];
  const failures: Error[] = [];
  let open: () => void = () => {};
  const gate = opts.gate ? new Promise<void>((r) => (open = r)) : Promise.resolve();
  const p = new Playback(opts.src?.session ?? null, foldedTo(at), seekTo(at), {
    tail: () => 5000,
    onFail: (e) => failures.push(e),
    fresh: () => new CityState(city, trips, DISTRICTS),
    onState: (next, seek) => {
      shown.push([next, seek.tick]);
      seeks.push(seek);
    },
    hourAt: async (tick, signal) => {
      fetched.push(tick);
      signals.push(signal);
      await gate;
      if (tick < (opts.oldest ?? 0)) throw new SeekError('unretained', 'gone', opts.oldest ?? 0);
      return seekTo(tick);
    },
    oldest: () => opts.oldest ?? 0,
    onEdge: (tick) => edges.push(tick),
  });
  return { p, shown, fetched, signals, seeks, edges, failures, release: open };
};

/** A clock the rewind's throttle reads, moved on by hand. */
let clock = 1000;
vi.spyOn(performance, 'now').mockImplementation(() => clock);
const later = (ms = 100) => (clock += ms);
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => later(1000));

/** The ticks a state holds the buildings of, one per district. */
const kinds = (s: CityState) => [0, 1].map((d) => s.built.get(d)?.kind);

describe('Playback rewinding', () => {
  it('refolds the state from the hour keyframe to the tick the playhead has gone back to', () => {
    const { p, shown } = rig(700);
    p.rate = -4;
    later();
    p.advance(1);
    // 4 ticks a second at 4x is 16 ticks back; the state is two ticks ahead of the head, as in a forward play.
    expect(p.head).toBe(684);
    expect(p.shown).toBe(684);
    expect(shown).toHaveLength(1);
    const [state, tick] = shown[0]!;
    expect(tick).toBe(686);
    expect(p.state).toBe(state);
    expect(state.ticks).toEqual([686, 686]);
    expect(kinds(state)).toEqual([686, 686]);
  });

  it('shows the same city as a fresh seek to that tick', () => {
    const { p } = rig(700);
    p.rate = -2;
    for (let i = 0; i < 10; i++) {
      later();
      p.advance(0.5);
    }
    // Built straight from the log, not through the same seek fixture the playback was given.
    const want = new CityState(city, trips, DISTRICTS);
    for (let d = 0; d < DISTRICTS; d++)
      for (let t = 480; t <= Math.floor(p.head) + 2; t++) want.apply(record(d, t), true);
    expect(p.state.ticks).toEqual(want.ticks);
    expect([...p.state.built]).toEqual([...want.built]);
  });

  it('moves back at the rate times the city speed, and not faster than a second a step', () => {
    const { p } = rig(700);
    p.rate = -1;
    later();
    p.advance(1);
    expect(p.head).toBe(696);
    p.rate = -8;
    later();
    p.advance(60);
    expect(p.head).toBe(696 - 32);
  });

  it('does not refold more often than the throttle allows, then catches up', () => {
    const { p, shown } = rig(700);
    p.rate = -8;
    later();
    p.advance(0.25);
    later(5);
    p.advance(0.25);
    expect(p.head).toBe(700 - 16);
    expect(shown).toHaveLength(1);
    later();
    p.advance(0.25);
    expect(shown).toHaveLength(2);
    expect(shown[1]![1]).toBe(Math.floor(p.head) + 2);
  });

  it('settles the state on the tick drawn when it stops, even if the throttle held the last refold', () => {
    const { p, shown } = rig(700);
    p.rate = -8;
    later();
    p.advance(0.25);
    later(5);
    p.advance(0.25);
    p.paused = true;
    p.advance(0.25);
    expect(shown.at(-1)![1]).toBe(Math.floor(p.head) + 2);
    expect(p.state.latest).toBe(Math.floor(p.head) + 2);
  });

  it('does not move while paused', () => {
    const { p, shown } = rig(700);
    p.rate = -4;
    p.paused = true;
    later();
    p.advance(1);
    expect(p.head).toBe(700);
    expect(shown).toHaveLength(0);
  });

  describe('across an hour boundary', () => {
    it('crosses in one step when the hour before was fetched ahead', async () => {
      const { p, fetched, shown } = rig(245);
      p.rate = -8;
      expect(fetched).toEqual([239]);
      await settle();
      later();
      p.advance(1);
      expect(p.head).toBe(213);
      expect(shown.at(-1)![1]).toBe(215);
      expect(kinds(p.state)).toEqual([215, 215]);
      // Nothing more was asked for beyond the start of the log.
      expect(fetched).toEqual([239]);
    });

    it('waits at the keyframe while the hour before is on its way, then goes on', async () => {
      const r = rig(245, { gate: true });
      const { p } = r;
      p.rate = -8;
      later();
      p.advance(1);
      expect(p.head).toBe(240);
      later();
      p.advance(1);
      expect(p.head).toBe(240);
      expect(r.fetched).toEqual([239]);
      r.release();
      await settle();
      later();
      p.advance(1);
      expect(p.head).toBe(208);
      expect(kinds(p.state)).toEqual([210, 210]);
    });

    it('fetches the next hour back as soon as it enters one', async () => {
      const { p, fetched } = rig(500);
      p.rate = -8;
      await settle();
      expect(fetched).toEqual([479]);
      later();
      p.advance(1);
      later();
      p.advance(1);
      await settle();
      expect(p.head).toBeLessThan(479);
      expect(fetched).toEqual([479, 239]);
    });
  });

  describe('at the oldest tick', () => {
    it('stops there, once, and says so', () => {
      const { p, edges } = rig(260, { oldest: 240 });
      p.rate = -8;
      later();
      p.advance(1);
      expect(p.head).toBe(240);
      expect(p.paused).toBe(true);
      expect(edges).toEqual([240]);
      later();
      p.advance(1);
      expect(edges).toEqual([240]);
    });

    it('stops where the log begins when retention has taken the hour before', async () => {
      const edges: number[] = [];
      const p = new Playback(null, foldedTo(300), seekTo(300), {
        tail: () => 5000,
        fresh: () => new CityState(city, trips, DISTRICTS),
        onState: () => {},
        hourAt: async () => {
          throw new SeekError('unretained', 'gone', 240);
        },
        onEdge: (t) => edges.push(t),
      });
      p.rate = -8;
      await settle();
      for (let i = 0; i < 3; i++) {
        later();
        p.advance(1);
      }
      expect(p.head).toBe(240);
      expect(p.paused).toBe(true);
      expect(edges).toEqual([240]);
    });
  });

  it('fails when the hour before cannot be read for another reason', async () => {
    const failures: Error[] = [];
    const p = new Playback(null, foldedTo(300), seekTo(300), {
      tail: () => 5000,
      onFail: (e) => failures.push(e),
      fresh: () => new CityState(city, trips, DISTRICTS),
      onState: () => {},
      hourAt: async () => {
        throw new GatewayError('closed', 'the session closed');
      },
    });
    p.rate = -1;
    await settle();
    expect(p.failure).toBeInstanceOf(GatewayError);
    expect(failures).toHaveLength(1);
  });

  it('cannot rewind without a way to refold', () => {
    const p = new Playback(null, foldedTo(300), seekTo(300), { tail: () => 5000 });
    p.rate = -4;
    expect(p.rate).toBe(1);
  });

  describe('turning round', () => {
    it('plays forward from the tick it rewound to, with the records after it and none twice', async () => {
      const src = source();
      const { p } = rig(700, { src });
      const rewound: [number, number, string][] = [];
      p.rate = -4;
      later();
      p.advance(1);
      p.rate = 1;
      p.state.onRecord = (d, t, r) => rewound.push([d, t, r]);
      expect(p.shown).toBe(p.head);
      // The pumps read from the record after the one the state was folded to.
      await settle();
      expect(src.reads.slice(2, 4).map(([, from]) => from)).toEqual([687, 687]);
      for (let i = 0; i < 40; i++) {
        later();
        p.advance(0.5);
        await settle();
      }
      const ticks = rewound.filter((r) => r[0] === 0).map((r) => r[1]);
      expect(ticks[0]).toBe(687);
      expect(ticks).toEqual(Array.from({ length: ticks.length }, (_, i) => 687 + i));
      expect(rewound.every((r) => r[2] === 'applied')).toBe(true);
      expect(p.head).toBeGreaterThan(684);
      p.close();
    });

    it('keeps the records it played forward, so a rewind over them needs no read', async () => {
      const src = source();
      const { p, fetched } = rig(700, { src });
      for (let i = 0; i < 8; i++) {
        later();
        p.advance(0.5);
        await settle();
      }
      const head = p.head;
      expect(head).toBeGreaterThan(710);
      p.rate = -1;
      later();
      p.advance(1);
      expect(p.head).toBe(head - 4);
      expect(p.state.latest).toBe(Math.floor(p.head) + 2);
      expect(fetched).toEqual([479]);
      p.close();
    });

    it('goes forward at the pace of a catch-up when asked to catch up while rewinding', () => {
      const { p } = rig(700);
      p.rate = -4;
      p.catchUp();
      expect(p.rate).toBe(1);
      expect(p.catchingUp).toBe(true);
    });
  });

  it('does not open a subscription while rewinding', async () => {
    const src = source();
    const { p } = rig(700, { src });
    p.rate = -2;
    await settle();
    later();
    p.advance(1);
    expect(p.queued).toEqual([]);
    p.close();
  });
});

describe('Playback rewinding, further', () => {
  it('gives the seek the state was folded from, so a failed scrub can resume from the state on screen', () => {
    const { p, seeks } = rig(700);
    p.rate = -4;
    later();
    p.advance(1);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]!.tick).toBe(p.state.latest);
    expect(seeks[0]!.districts.map((d) => d.offset)).toEqual([686, 686]);
  });

  it('abandons the hour fetch when the playback closes', async () => {
    const { p, signals } = rig(300, { gate: true });
    p.rate = -1;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    p.close();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('catches up from where the rewind left the playhead, not from where the forward play had got to', () => {
    const { p } = rig(700);
    p.rate = -8;
    for (let i = 0; i < 6; i++) {
      later();
      p.advance(1);
    }
    const head = p.head;
    expect(head).toBe(508);
    p.catchUp();
    later();
    p.advance(0.1);
    // At most 960 ticks a second for a tenth of a second.
    expect(p.shown).toBeGreaterThan(head);
    expect(p.shown).toBeLessThan(head + 100);
  });

  it('rewinds across an hour it has just played forward through', async () => {
    const src = source();
    const { p, fetched } = rig(715, { src });
    for (let i = 0; i < 8; i++) {
      later();
      p.advance(0.5);
      await settle();
    }
    expect(p.head).toBeGreaterThan(720);
    p.rate = -8;
    await settle();
    expect(fetched[0]).toBe(719);
    later();
    p.advance(1);
    expect(p.head).toBeLessThan(720);
    expect(kinds(p.state)).toEqual([Math.floor(p.head) + 2, Math.floor(p.head) + 2]);
    p.close();
  });

  describe('with keyframes on different ticks in each district', () => {
    /** District 0 keyframes at tick 240, district 1 at 250: neither is the hour's first tick for both. */
    const staggered = (d: number, tick: number): TickRecord => {
      const kf = tick === (d === 0 ? 240 : 250);
      return {
        ...record(d, tick),
        keyframe: kf ? { buildings: [[d, tick, 0]] } : null,
        events: kf ? [] : [{ type: 'built', lot: d, kind: tick, rotation: 0 }],
      };
    };
    const seekStaggered = (tick: number): SeekResult => ({
      tick,
      requested: tick,
      exact: true,
      districts: [240, 250].map((from, d) => ({
        records: Array.from({ length: tick - from + 1 }, (_, i) => staggered(d, from + i)),
        offset: tick,
        before: [],
      })),
    });

    it('refolds inside the part of the hour every district holds, and waits at the later keyframe', () => {
      const fetched: number[] = [];
      const from = seekStaggered(300);
      const state = new CityState(city, trips, DISTRICTS);
      fold(state, from);
      const p = new Playback(null, state, from, {
        tail: () => 5000,
        fresh: () => new CityState(city, trips, DISTRICTS),
        onState: () => {},
        hourAt: async (tick) => {
          fetched.push(tick);
          return seekStaggered(tick);
        },
      });
      p.rate = -8;
      later();
      p.advance(1);
      expect(p.head).toBe(268);
      expect(kinds(p.state)).toEqual([270, 270]);
      later();
      p.advance(1);
      // 250 is where both districts can fold from; the hour before is asked for, once.
      expect(p.head).toBe(250);
      later();
      p.advance(1);
      expect(p.head).toBe(250);
      expect(fetched).toEqual([249]);
    });
  });
});
