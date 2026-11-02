import { describe, expect, it, vi } from 'vitest';
import type { Journey, Voyage } from './city';
import {
  Following,
  archetypeLabel,
  blockAt,
  dayTime,
  doing,
  parseProfile,
  schedule,
  type CardView,
  type Deps,
  type Profile,
} from './follow';

const at = (hour: number, minute = 0) => hour * 240 + minute * 4;

/** An office worker's day: home until 07:48, work until 12:00, the shops until 12:30, work until 17:15, home from then. */
const day: Profile = {
  id: 12,
  name: 'Ada Marsh',
  archetype: 'office',
  home: 4,
  vehicle: 2,
  blocks: [
    { activity: 'home', lot: 4, leave: at(7, 48) },
    { activity: 'work', lot: 20, leave: at(12) },
    { activity: 'shop', lot: 31, leave: at(12, 30) },
    { activity: 'work', lot: 20, leave: at(17, 15) },
    { activity: 'home', lot: 4, leave: at(22, 30) },
  ],
};

describe('parseProfile', () => {
  it('reads what core wrote', () => {
    expect(parseProfile(JSON.stringify(day))).toEqual(day);
  });

  it('refuses nothing, a mangled string or a day it does not know how to read', () => {
    expect(parseProfile(undefined)).toBeNull();
    expect(parseProfile('')).toBeNull();
    expect(parseProfile('{')).toBeNull();
    expect(parseProfile(JSON.stringify({ ...day, blocks: [] }))).toBeNull();
    expect(parseProfile(JSON.stringify({ ...day, archetype: 'wizard' }))).toBeNull();
    expect(parseProfile(JSON.stringify({ ...day, blocks: [{ activity: 'flying', lot: 1, leave: 2 }] }))).toBeNull();
  });
});

describe('the day', () => {
  it('is in the block whose predecessor has left, and closes after the last', () => {
    expect(blockAt(day, at(3))).toBe(0);
    expect(blockAt(day, at(7, 47))).toBe(0);
    expect(blockAt(day, at(7, 48))).toBe(1);
    expect(blockAt(day, at(12, 20))).toBe(2);
    expect(blockAt(day, at(15))).toBe(3);
    expect(blockAt(day, at(18))).toBe(4);
    expect(blockAt(day, at(23, 30))).toBe(0);
  });

  it('is the same on every day', () => {
    expect(blockAt(day, 5760 * 3 + at(13))).toBe(blockAt(day, at(13)));
  });

  it('reads a time of day as hours and minutes', () => {
    expect(dayTime(at(7, 48))).toBe('07:48');
    expect(dayTime(at(0))).toBe('00:00');
    expect(dayTime(5760 - 1)).toBe('23:59');
  });

  it('lists the blocks with where they are and when they end', () => {
    const rows = schedule(day, (lot) => (lot === 20 ? 'Quay Works' : null));
    expect(rows.map((r) => [r.label, r.place, r.until])).toEqual([
      ['At home', null, '07:48'],
      ['At work', 'Quay Works', '12:00'],
      ['Shopping', null, '12:30'],
      ['At work', 'Quay Works', '17:15'],
      ['At home', null, '22:30'],
    ]);
  });

  it('names a kind of resident in words', () => {
    expect(archetypeLabel('night')).toBe('Night worker');
    expect(archetypeLabel('office')).toBe('Office worker');
  });
});

describe('what a resident is doing', () => {
  it('follows the trip on the road: by car or on foot, to what', () => {
    expect(doing(day, at(8), { car: true, to: 20 })).toEqual({ text: 'Driving to work', block: null, lot: 20 });
    expect(doing(day, at(12, 5), { car: false, to: 31 }).text).toBe('Walking to the shops');
    expect(doing(day, at(17, 30), { car: true, to: 4 }).text).toBe('Driving to home');
  });

  it('follows the schedule indoors, and sleeps at home through the night', () => {
    expect(doing(day, at(10), null)).toEqual({ text: 'At work', block: 1, lot: 20 });
    expect(doing(day, at(12, 20), null).text).toBe('Shopping');
    expect(doing(day, at(19), null).text).toBe('At home');
    expect(doing(day, at(23), null)).toMatchObject({ text: 'Asleep at home', block: 0, lot: 4 });
    expect(doing(day, at(5), null).text).toBe('Asleep at home');
    expect(doing(day, at(6, 30), null).text).toBe('At home');
  });
});

/** A trip of ten ticks that ends at lot `to`. */
const voyage = (resident: number, depart: number, to: number): Voyage => {
  const journey: Journey = {
    arrive: () => depart + 10,
    positionAt() {},
    lots(out) {
      out[0] = 0;
      out[1] = to;
    },
    free() {},
  };
  return { resident, vehicle: 2, depart, journey };
};

function setup() {
  const shown: (CardView | null)[] = [];
  const rig = {
    moveTo: vi.fn(),
    track: vi.fn(),
    view: vi.fn(() => ({ x: 0, z: 0, distance: 30, azimuth: 1, polar: 0.8 })),
  };
  const pins: (number | null)[] = [];
  const road = { x: 3.5, z: -2.5 };
  const deps: Deps = {
    profile: (resident) => (resident === day.id ? JSON.stringify(day) : undefined),
    lots: Array.from({ length: 40 }, (_, i) => ({ x: i + 10, z: i + 2, name: i === 20 ? 'Quay Works' : null })),
    half: 10,
    rig,
    positionOf: (v) => (v.resident === day.id ? road : null),
    pin: (resident) => void pins.push(resident),
    show: (view) => void shown.push(view),
  };
  return { following: new Following(deps), rig, shown, pins, road };
}

describe('Following', () => {
  it('follows a resident who is in the city and says so when none is', () => {
    const { following, pins } = setup();
    expect(following.start(999)).toBe(false);
    expect(following.resident).toBeNull();
    expect(following.start(12)).toBe(true);
    expect(following.resident).toBe(12);
    expect(pins).toEqual([12]);
  });

  it('brings the camera in close on the first frame, then tracks', () => {
    const { following, rig, road } = setup();
    following.start(12);
    following.frame(at(8, 10), (r) => (r === 12 ? voyage(12, at(8), 20) : undefined));
    expect(rig.moveTo).toHaveBeenCalledWith(road, 14, 1, 0.8, { ease: true });
    following.frame(at(8, 11), () => voyage(12, at(8), 20));
    expect(rig.moveTo).toHaveBeenCalledTimes(1);
    expect(rig.track).toHaveBeenCalledWith(road.x, road.z);
  });

  it('keeps a view a link carried', () => {
    const { following, rig } = setup();
    following.start(12, true);
    following.frame(at(8), () => voyage(12, at(8), 20));
    expect(rig.moveTo).toHaveBeenCalledWith(expect.anything(), 30, 1, 0.8, { ease: false });
  });

  it('goes to their building when they are indoors, in tiles from the middle of the map', () => {
    const { following, rig } = setup();
    following.start(12);
    following.frame(at(10), () => undefined);
    // Lot 20 stands at tile (30, 22); the middle of the map is 10 tiles in.
    expect(rig.moveTo).toHaveBeenCalledWith({ x: 20, z: 12 }, 14, 1, 0.8, { ease: true });
  });

  it('shows the card once, and again only when what they are doing changes', () => {
    const { following, shown } = setup();
    following.start(12);
    following.frame(at(10), () => undefined);
    following.frame(at(10, 5), () => undefined);
    following.frame(at(11), () => undefined);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      resident: 12,
      name: 'Ada Marsh',
      kind: 'Office worker',
      doing: 'At work',
      current: 1,
    });
    expect(shown[0]!.rows[1]).toEqual({ label: 'At work', place: 'Quay Works', until: '12:00' });
    following.frame(at(12, 5), () => voyage(12, at(12), 31));
    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatchObject({ doing: 'Driving to the shops', current: null });
  });

  it('goes on after a seek or rewind replaced the state: each frame asks the state on screen', () => {
    const { following, rig, shown } = setup();
    following.start(12);
    const live = new Map([[12, voyage(12, at(8), 20)]]);
    following.frame(at(8, 10), (r) => live.get(r));
    // A seek to the evening: a state that knows another trip, and a rewind back to a state with none.
    const evening = new Map([[12, voyage(12, at(17, 30), 4)]]);
    following.frame(at(17, 32), (r) => evening.get(r));
    following.frame(at(3), () => undefined);
    expect(shown.map((v) => v?.doing)).toEqual(['Driving to work', 'Driving to home', 'Asleep at home']);
    expect(rig.track).toHaveBeenCalledTimes(2);
    expect(following.resident).toBe(12);
  });

  it('knows a resident by number alone, so a crossing into another district changes nothing', () => {
    const { following, shown } = setup();
    following.start(12);
    // The trip arrives in a record of a different district; the lookup is by number and the district never appears.
    const lookups: number[] = [];
    following.frame(at(8, 10), (r) => {
      lookups.push(r);
      return voyage(12, at(8), 20);
    });
    expect(lookups).toEqual([12]);
    expect(shown[0]?.doing).toBe('Driving to work');
  });

  it('stops: the card goes, the pin goes and later frames do nothing', () => {
    const { following, shown, pins, rig } = setup();
    following.start(12);
    following.frame(at(10), () => undefined);
    following.stop();
    expect(shown.at(-1)).toBeNull();
    expect(pins).toEqual([12, null]);
    expect(following.resident).toBeNull();
    rig.track.mockClear();
    following.frame(at(11), () => undefined);
    expect(rig.track).not.toHaveBeenCalled();
    expect(shown).toHaveLength(2);
  });

  it('falls back to their building when the traffic cannot place a trip', () => {
    const { following, rig } = setup();
    following.start(12);
    following.frame(at(8), () => voyage(13, at(8), 20));
    // The voyage is another resident's, so positionOf has nothing and lot 20 (the trip's end) is used.
    expect(rig.moveTo).toHaveBeenCalledWith({ x: 20, z: 12 }, 14, 1, 0.8, { ease: true });
  });
});
