import { describe, expect, it, vi } from 'vitest';
import {
  GO_UP_TEXT,
  LEAD_TICKS,
  builderName,
  cardText,
  goUpTick,
  principalHash,
  provenance,
  whenText,
} from './attribution';
import { CityState, NO_BUILDING, type TickRecord, type Trips } from './city';
import type { City } from './layout';

// Lot 0 is a generated building, lot 1 a generated park, lot 2 bare, lot 3 a generated building on the other side.
const city = {
  lots: [
    { id: 0, district: 0, kind: 3 },
    { id: 1, district: 0, kind: 40 },
    { id: 2, district: 0, kind: NO_BUILDING },
    { id: 3, district: 1, kind: 20 },
  ],
} as unknown as City;
const trips = {} as Trips;
const record = (tick: number, events: TickRecord['events'], keyframe: TickRecord['keyframe'] = null) =>
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

const ana = 'ana-principal';
const builtBy = (who: string, lot: number, tick: number): TickRecord =>
  record(tick, [
    { type: 'command', principal: principalHash(who), name: 'Ana', id: 1, result: 0 },
    { type: 'built', lot, kind: 7, rotation: 0 },
  ]);

describe('principalHash', () => {
  // The same vectors core/src/record/tests.rs pins, so the page and the sim agree on who a hash names.
  it('is FNV-1a over the UTF-8 bytes', () => {
    expect(principalHash('')).toBe('cbf29ce484222325');
    expect(principalHash('a')).toBe('af63dc4c8601ec8c');
    expect(principalHash('mayor')).not.toBe(principalHash('viewer'));
  });

  it('hashes the bytes of non-ASCII text, not its characters', () => {
    expect(principalHash('é')).toBe('0ac21707b7181e01');
  });
});

describe('provenance', () => {
  it('names the builder and the tick for a building someone put up', () => {
    const state = new CityState(city, trips, 2);
    state.apply(builtBy('x', 0, 7000));
    expect(provenance(0, city, state, null)).toEqual({ kind: 'built', name: 'Ana', mine: false, tick: 7000 });
  });

  it('says it was you when the hash is the signed-in principal’s', () => {
    const state = new CityState(city, trips, 2);
    state.apply(builtBy(ana, 0, 7000));
    expect(provenance(0, city, state, ana)).toMatchObject({ mine: true });
    expect(provenance(0, city, state, 'someone-else')).toMatchObject({ mine: false });
    expect(provenance(0, city, state, null)).toMatchObject({ mine: false });
  });

  it('says a generated building has been here since the start', () => {
    const state = new CityState(city, trips, 2);
    expect(provenance(0, city, state, null)).toEqual({ kind: 'start' });
    expect(provenance(3, city, state, null)).toEqual({ kind: 'start' });
  });

  it('says nothing about trees, bare ground or a lot that was demolished', () => {
    const state = new CityState(city, trips, 2);
    expect(provenance(1, city, state, null)).toBeNull();
    expect(provenance(2, city, state, null)).toBeNull();
    state.apply(record(5, [{ type: 'demolished', lot: 0, kind: 3, rotation: 0 }]));
    expect(provenance(0, city, state, null)).toBeNull();
  });

  it('says a building the log does not name was built earlier, and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = new CityState(city, trips, 2);
    state.apply(record(240, [], { buildings: [[2, 7, 0]], roads: [] }), true);
    expect(provenance(2, city, state, null)).toEqual({ kind: 'earlier' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('has an answer for a lot the city does not have', () => {
    const state = new CityState(city, trips, 2);
    expect(provenance(99, city, state, null)).toBeNull();
  });
});

describe('the card', () => {
  it('reads "Built by Ana · Day 2, 09:12"', () => {
    // Day 2 starts at tick 5760; 09:12 is 9.2 hours, 9.2 * 240 ticks in.
    const tick = 5760 + 2208;
    expect(whenText(tick)).toBe('Day 2, 09:12');
    expect(cardText({ kind: 'built', name: 'Ana', mine: false, tick })).toBe('Built by Ana · Day 2, 09:12');
  });

  it('reads "Built by you" for your own building', () => {
    expect(cardText({ kind: 'built', name: 'Ana', mine: true, tick: 0 })).toBe('Built by you · Day 1, 00:00');
  });

  it('reads "Here since the start" and "Built earlier"', () => {
    expect(cardText({ kind: 'start' })).toBe('Here since the start');
    expect(cardText({ kind: 'earlier' })).toBe('Built earlier');
  });

  it('keeps the system’s words out of what a player reads', () => {
    const lines = [
      cardText({ kind: 'built', name: 'Ana', mine: false, tick: 100 }),
      cardText({ kind: 'built', name: 'Ana', mine: true, tick: 100 }),
      cardText({ kind: 'start' }),
      cardText({ kind: 'earlier' }),
      GO_UP_TEXT,
    ];
    for (const line of lines)
      expect(line, line).not.toMatch(/\b(logs?|streams?|offsets?|ticks?|keyframes?|districts?)\b/i);
    for (const line of lines) expect(line, line).not.toMatch(/[–—]/);
  });

  it('puts a builder who calls themselves "you" in quotes, so only the real you reads as you', () => {
    expect(builderName('you')).toBe('“you”');
    expect(builderName(' You ')).toBe('“You”');
    expect(cardText({ kind: 'built', name: 'you', mine: false, tick: 0 })).toBe('Built by “you” · Day 1, 00:00');
    expect(cardText({ kind: 'built', name: 'you', mine: true, tick: 0 })).toBe('Built by you · Day 1, 00:00');
  });

  it('does not leave a gap for a builder with no name', () => {
    expect(builderName('')).toBe('someone');
    expect(builderName('  ')).toBe('someone');
    expect(cardText({ kind: 'built', name: '', mine: false, tick: 0 })).toBe('Built by someone · Day 1, 00:00');
  });

  it('counts the clock to the minute', () => {
    expect(whenText(239)).toBe('Day 1, 00:59');
    expect(whenText(240)).toBe('Day 1, 01:00');
    expect(whenText(5759)).toBe('Day 1, 23:59');
    expect(whenText(5760)).toBe('Day 2, 00:00');
  });
});

describe('See it go up', () => {
  it('goes to two ticks before the building was built', () => {
    expect(LEAD_TICKS).toBe(2);
    expect(goUpTick({ kind: 'built', name: 'Ana', mine: false, tick: 7000 })).toBe(6998);
  });

  it('stops at the start of the city', () => {
    expect(goUpTick({ kind: 'built', name: 'Ana', mine: false, tick: 1 })).toBe(0);
  });

  it('has no tick to go to for a building the log does not date', () => {
    expect(goUpTick({ kind: 'start' })).toBeNull();
    expect(goUpTick({ kind: 'earlier' })).toBeNull();
  });
});
