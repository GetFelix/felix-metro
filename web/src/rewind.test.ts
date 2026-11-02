import { describe, expect, it } from 'vitest';
import type { TickRecord } from './city';
import { Hour, hourStart, neighbours } from './rewind';
import type { SeekResult } from './seek';

const record = (district: number, tick: number): TickRecord => ({
  kind: 'tick',
  epoch: 1,
  district,
  tick,
  speed: 4,
  keyframeOffset: hourStart(tick),
  wallUs: 0,
  keyframe: tick % 240 === 0 ? { buildings: [] } : null,
  events: [],
});

/** What a seek to `tick` returns when each district's log holds tick `n` at offset `n`. */
const seekTo = (tick: number, districts = 2): SeekResult => ({
  tick,
  requested: tick,
  exact: true,
  districts: Array.from({ length: districts }, (_, d) => ({
    records: Array.from({ length: tick - hourStart(tick) + 1 }, (_, i) => record(d, hourStart(tick) + i)),
    offset: tick,
    before: [],
  })),
});

describe('Hour', () => {
  it('holds the records from the keyframe to the tick a seek found', () => {
    const hour = Hour.from(seekTo(300));
    expect(hour.start).toBe(240);
    expect(hour.end).toBe(300);
    expect(hour.covers(240)).toBe(true);
    expect(hour.covers(300)).toBe(true);
    expect(hour.covers(239)).toBe(false);
    expect(hour.covers(301)).toBe(false);
  });

  it('answers any tick it covers with the records up to it and the offset of the last', () => {
    const at = Hour.from(seekTo(300)).at(262)!;
    expect(at.tick).toBe(262);
    expect(at.exact).toBe(true);
    for (const d of at.districts) {
      expect(d.records[0]!.tick).toBe(240);
      expect(d.records.at(-1)!.tick).toBe(262);
      expect(d.offset).toBe(262);
    }
  });

  it('answers a tick past its end with its newest, and a tick before its keyframe with nothing', () => {
    const hour = Hour.from(seekTo(300));
    expect(hour.at(400)).toMatchObject({ tick: 300, exact: false });
    expect(hour.at(239)).toBeNull();
  });

  it('settles on the earlier tick when one district skipped a tick', () => {
    const seek = seekTo(300);
    seek.districts[1]!.records = seek.districts[1]!.records.filter((r) => r.tick !== 270);
    seek.districts[1]!.offset = 299;
    const at = Hour.from(seek).at(270)!;
    expect(at.tick).toBe(269);
    expect(at.districts.map((d) => d.records.at(-1)!.tick)).toEqual([269, 269]);
  });

  it('keeps the records before the keyframe only for a tick inside the construction window', () => {
    const seek = seekTo(244);
    const early = record(0, 238);
    seek.districts[0]!.before = [early];
    const hour = Hour.from(seek);
    expect(hour.at(244)!.districts[0]!.before).toEqual([early]);
    expect(hour.at(250)).toMatchObject({ tick: 244 });
  });

  it('takes records played forward in order, and ignores one it already has', () => {
    const hour = Hour.from(seekTo(300));
    hour.add(0, 301, record(0, 301));
    hour.add(1, 301, record(1, 301));
    expect(hour.end).toBe(301);
    hour.add(0, 301, record(0, 301));
    hour.add(0, 303, record(0, 303));
    expect(hour.at(301)!.districts[0]!.records).toHaveLength(62);
    expect(hour.end).toBe(301);
  });

  it('starts over at a keyframe played forward, so the hour it leaves is no longer covered', () => {
    const hour = Hour.from(seekTo(479));
    for (let d = 0; d < 2; d++) hour.add(d, 480, record(d, 480));
    expect(hour.start).toBe(480);
    expect(hour.covers(479)).toBe(false);
    expect(hour.at(480)!.districts[0]!.offset).toBe(480);
  });

  it('reaches only as far as the districts that have rolled over until the rest do', () => {
    const hour = Hour.from(seekTo(479));
    hour.add(0, 480, record(0, 480));
    expect(hour.start).toBe(480);
    expect(hour.covers(480)).toBe(false);
    expect(hour.at(480)).toBeNull();
    hour.add(1, 480, record(1, 480));
    expect(hour.covers(480)).toBe(true);
  });

  it('has no start when a seek read no keyframe', () => {
    const bare = Hour.from({ tick: 5, requested: 5, exact: true, districts: [{ records: [], offset: 5, before: [] }] });
    expect(bare.start).toBeNull();
    expect(bare.covers(5)).toBe(false);
  });
});

describe('neighbours', () => {
  it('names the last tick of the hour before and of the hour after', () => {
    expect(neighbours(500, 0, 2000)).toEqual([479, 959]);
  });

  it('leaves out an hour the log does not hold', () => {
    expect(neighbours(500, 480, 2000)).toEqual([959]);
    expect(neighbours(500, 0, 600)).toEqual([479]);
    expect(neighbours(500, 0, 719)).toEqual([479]);
    expect(neighbours(500, 0, 800)).toEqual([479, 800]);
  });
});

describe('Hour with keyframes on different ticks', () => {
  const at = (d: number, tick: number): TickRecord => ({
    ...record(d, tick),
    keyframe: tick === (d === 0 ? 240 : 250) ? { buildings: [] } : null,
  });
  const seek = (tick: number): SeekResult => ({
    tick,
    requested: tick,
    exact: true,
    districts: [240, 250].map((from, d) => ({
      records: Array.from({ length: tick - from + 1 }, (_, i) => at(d, from + i)),
      offset: tick,
      before: [],
    })),
  });

  it('starts at the latest keyframe, and covers only from there', () => {
    const hour = Hour.from(seek(300));
    expect(hour.start).toBe(250);
    expect(hour.covers(249)).toBe(false);
    expect(hour.covers(250)).toBe(true);
  });

  it('folds each district from its own keyframe', () => {
    const result = Hour.from(seek(300)).at(260)!;
    expect(result.districts.map((d) => d.records[0]!.tick)).toEqual([240, 250]);
    expect(result.districts.map((d) => d.records.at(-1)!.tick)).toEqual([260, 260]);
    expect(Hour.from(seek(300)).at(249)).toBeNull();
  });

  it('judges the construction window by the keyframe of each district', () => {
    const early = record(1, 248);
    const s = seek(300);
    s.districts[1]!.before = [early];
    const hour = Hour.from(s);
    expect(hour.at(255)!.districts[1]!.before).toEqual([early]);
    expect(hour.at(259)!.districts[1]!.before).toEqual([]);
  });
});
