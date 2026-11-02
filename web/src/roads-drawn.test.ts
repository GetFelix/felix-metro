import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CityState, ROAD_ADDED, ROAD_REMOVED, type TickEvent, type TickRecord } from './city';
import { Metro, generate, initSync } from './core/felix_metro_core.js';
import { parseCity, type City, type Road } from './layout';
import { RoadsOnScreen } from './roads-drawn';

let city: City;
beforeAll(() => {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
  city = parseCity(generate('harbor', 2));
});

const record = (tick: number, events: TickEvent[], keyframe: TickRecord['keyframe'] = null): TickRecord => ({
  kind: 'tick',
  epoch: 1,
  district: 0,
  tick,
  speed: 4,
  keyframeOffset: 0,
  wallUs: 0,
  keyframe,
  events,
});
/** Harbor's one road over the cleared ground, between nodes 6 and 7 on the north edge, and the tiles it covers. */
const LAID = { type: 'roadwork', segment: 104, change: ROAD_ADDED, a: 6, b: 7 } as const;
const GONE = { ...LAID, change: ROAD_REMOVED };
const between = (roads: Road[]) => roads.filter((r) => r.z === 0 && (r.x === 17 || r.x === 18));

const log = () => [record(240, [], { buildings: [], roads: [] }), record(241, [LAID]), record(242, [GONE])];
/** A state folded from the keyframe to `tick`, as a seek or a rewind makes it. */
const foldedTo = (tick: number) => {
  const state = new CityState(city, new Metro('harbor', 2), 1);
  for (const r of log()) if (r.tick <= tick) state.apply(r);
  return state;
};

describe('the roads on screen', () => {
  it('draws a road when the live city lays it, and takes it away again', () => {
    const drawn: Road[][] = [];
    const screen = new RoadsOnScreen(new Metro('harbor', 2), city.roads, (r) => drawn.push(r));
    const live = new CityState(city, new Metro('harbor', 2), 1);
    live.onRoads = () => screen.show(live);
    live.apply(log()[0]!);
    expect(drawn).toHaveLength(0);
    live.apply(log()[1]!);
    expect(between(screen.tiles)).toHaveLength(2);
    expect(screen.tiles.length).toBe(city.roads.length + 2);
    live.apply(log()[2]!);
    expect(between(screen.tiles)).toHaveLength(0);
    expect(drawn).toHaveLength(2);
  });

  it('undoes a road on a rewind to before it was laid, and brings back one taken away after the tick', () => {
    const screen = new RoadsOnScreen(new Metro('harbor', 2), city.roads, () => {});
    expect(screen.show(foldedTo(241))).toBe(true);
    expect(between(screen.tiles)).toHaveLength(2);
    // Back past the road's tick: it is gone from the screen.
    screen.show(foldedTo(240));
    expect(between(screen.tiles)).toHaveLength(0);
    // Forward past its removal, then back to between: the road is drawn again.
    screen.show(foldedTo(242));
    expect(between(screen.tiles)).toHaveLength(0);
    screen.show(foldedTo(241));
    expect(between(screen.tiles)).toHaveLength(2);
  });

  it('redraws nothing for a state with the same roads', () => {
    let draws = 0;
    const screen = new RoadsOnScreen(new Metro('harbor', 2), city.roads, () => draws++);
    expect(screen.show(foldedTo(240))).toBe(false);
    screen.show(foldedTo(241));
    expect(screen.show(foldedTo(241))).toBe(false);
    expect(draws).toBe(1);
  });
});
