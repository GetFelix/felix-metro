import { describe, expect, it, vi } from 'vitest';
import { CityState, NO_BUILDING, type TickEvent, type TickRecord, type Trips } from './city';
import { WINDOW, fallScale, progress, riseScale } from './construction';
import type { City } from './layout';

vi.mock('./core/felix_metro_core.js', () => ({
  decodeRecord: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  districtKey: (district: number, _shards: number, routing: string) => `${routing}.${district}`,
}));
vi.mock('./auth', () => ({ signIn: async () => 'token' }));
const { fold } = await import('./seek');
type SeekResult = Parameters<typeof fold>[1];

describe('progress', () => {
  it('rises over eight ticks from the event and holds at either end', () => {
    expect(WINDOW).toBe(8);
    expect(progress(100, 99)).toBe(0);
    expect(progress(100, 100)).toBe(0);
    expect(progress(100, 104)).toBe(0.5);
    expect(progress(100, 107.5)).toBe(0.9375);
    expect(progress(100, 108)).toBe(1);
    expect(progress(100, 500)).toBe(1);
  });

  it('is a function of the two ticks alone, so the way back retraces the way forward', () => {
    const forward = [100, 102, 104, 106, 108].map((t) => riseScale(100, t));
    const back = [108, 106, 104, 102, 100].map((t) => riseScale(100, t)).reverse();
    expect(back).toEqual(forward);
    expect(forward).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('brings a demolished building down to nothing, from full height or from where a rise had got to', () => {
    expect(fallScale(100, 100)).toBe(1);
    expect(fallScale(100, 104)).toBe(0.5);
    expect(fallScale(100, 108)).toBe(0);
    expect(fallScale(100, 104, 0.5)).toBe(0.25);
    expect(fallScale(100, 99, 0.5)).toBe(0.5);
  });
});

const city = { lots: [0, 1, 2, 3].map((id) => ({ id, district: 0 })) } as unknown as City;
const trips: Trips = { trip: () => undefined };
const record = (tick: number, events: TickEvent[] = [], keyframe: TickRecord['keyframe'] = null) =>
  ({
    kind: 'tick',
    epoch: 1,
    district: 0,
    tick,
    speed: 4,
    keyframeOffset: 0,
    wallUs: 0,
    keyframe,
    events,
  }) as TickRecord;
const built = (lot: number, kind = 3): TickEvent => ({ type: 'built', lot, kind, rotation: 1 });
const demolished = (lot: number, kind = 3): TickEvent => ({ type: 'demolished', lot, kind, rotation: 1 });
const run = (from: number, to: number, events: Record<number, TickEvent[]> = {}) => {
  const state = new CityState(city, trips, 1);
  for (let t = from; t <= to; t++) state.apply(record(t, events[t] ?? []));
  return state;
};

describe('the start tick in the fold', () => {
  it('is the tick of the built event while the window is open and gone after it', () => {
    expect(run(98, 104, { 100: [built(1)] }).rising.get(1)).toEqual({ kind: 3, rotation: 1, tick: 100 });
    expect(run(98, 120, { 100: [built(1)] }).rising.size).toBe(0);
  });

  it('is the same wherever the fold began, so scrubbing back into the window shows the same partial state', () => {
    const events = { 100: [built(1)] };
    const forward = run(98, 105, events);
    const refolded = run(100, 105, events);
    expect(refolded.rising.get(1)).toEqual(forward.rising.get(1));
    // Below the event the lot has nothing to draw.
    expect(run(98, 99, events).rising.size).toBe(0);
    expect(run(98, 99, events).built.size).toBe(0);
  });

  it('keeps the old building of a demolition, and a rebuild ends the fall', () => {
    const state = run(98, 103, { 100: [demolished(2, 5)] });
    expect(state.falling.get(2)).toEqual({ kind: 5, rotation: 1, tick: 100, from: 1 });
    expect(state.built.get(2)?.kind).toBe(NO_BUILDING);
    state.apply(record(104, [built(2, 6)]));
    expect(state.falling.size).toBe(0);
    expect(state.rising.get(2)?.tick).toBe(104);
  });

  it('brings down from the height reached when a building is demolished during its rise', () => {
    const state = run(98, 105, { 100: [built(1)], 104: [demolished(1)] });
    expect(state.rising.size).toBe(0);
    expect(state.falling.get(1)).toEqual({ kind: 3, rotation: 1, tick: 104, from: 0.5 });
    expect(fallScale(104, 106, state.falling.get(1)!.from)).toBe(0.375);
  });

  it('does not know a start from a keyframe, which lists the finished lot', () => {
    const state = new CityState(city, trips, 1);
    state.apply(record(240, [], { buildings: [[1, 3, 1]] }));
    expect(state.built.get(1)).toEqual({ kind: 3, rotation: 1 });
    expect(state.rising.size).toBe(0);
  });
});

describe('recovering a start from before the keyframe', () => {
  const keyframe = record(240, [], { buildings: [[1, 3, 1]] });
  const seek = (before: TickRecord[], records: TickRecord[]): SeekResult =>
    ({
      tick: records.at(-1)!.tick,
      requested: 0,
      exact: true,
      districts: [{ records, offset: 0, before }],
    }) as SeekResult;

  it('finds the tick a building went up at just before the keyframe', () => {
    const state = new CityState(city, trips, 1);
    fold(state, seek([record(237), record(238, [built(1)]), record(239)], [keyframe, record(241), record(242)]));
    expect(state.rising.get(1)).toEqual({ kind: 3, rotation: 1, tick: 238 });
    expect(riseScale(238, 242)).toBe(0.5);
  });

  it('matches a fold that never crossed the keyframe', () => {
    const through = run(236, 242, { 238: [built(1)] });
    const state = new CityState(city, trips, 1);
    fold(state, seek([record(238, [built(1)])], [keyframe, record(241), record(242)]));
    expect(state.rising.get(1)).toEqual(through.rising.get(1));
  });

  it('takes the event the records after the keyframe carry over an older one', () => {
    const state = new CityState(city, trips, 1);
    fold(state, seek([record(238, [built(1)])], [keyframe, record(241, [built(1)]), record(242)]));
    expect(state.rising.get(1)?.tick).toBe(241);
  });

  it('leaves a lot the keyframe no longer matches drawn as the keyframe has it', () => {
    const state = new CityState(city, trips, 1);
    fold(state, seek([record(238, [built(1, 9)])], [keyframe, record(241)]));
    expect(state.rising.size).toBe(0);
  });

  it('recovers a demolition from before the keyframe', () => {
    const state = new CityState(city, trips, 1);
    const empty = record(240, [], { buildings: [[2, NO_BUILDING, 0]] });
    fold(state, seek([record(239, [demolished(2, 5)])], [empty, record(241)]));
    expect(state.falling.get(2)).toEqual({ kind: 5, rotation: 1, tick: 239, from: 1 });
  });

  it('forgets a start whose window ended before the fold did', () => {
    const state = new CityState(city, trips, 1);
    fold(
      state,
      seek(
        [record(238, [built(1)])],
        [keyframe, ...[241, 242, 243, 244, 245, 246, 247, 248, 249, 250].map((t) => record(t))],
      ),
    );
    expect(state.rising.size).toBe(0);
  });
});
