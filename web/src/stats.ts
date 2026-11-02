// The numbers on the stats panel: what the folded city holds at the tick on screen. They come from the same state the
// scene is drawn from, so a scrub, a rewind or a seek changes them with the picture.
import { NO_BUILDING, type CityState } from './city';
import { KINDS } from './kinds';
import { lotLook, type City, type LotLook } from './layout';

export type BuildingGroup = 'homes' | 'shops' | 'towers' | 'factories';

/** The kinds of building the panel counts, in the order it lists them. Trees, props and plaza fittings are not buildings. */
export const GROUPS: readonly { id: BuildingGroup; label: string }[] = [
  { id: 'homes', label: 'Homes' },
  { id: 'shops', label: 'Shops and offices' },
  { id: 'towers', label: 'Towers' },
  { id: 'factories', label: 'Factories' },
];

const GROUP_OF: Partial<Record<LotLook, BuildingGroup>> = {
  house: 'homes',
  commercial: 'shops',
  skyscraper: 'towers',
  factory: 'factories',
};

/** Which group a building kind is counted in, or undefined for a kind that is not a building (or no kind at all). */
export function groupOf(kind: number): BuildingGroup | undefined {
  const k = KINDS[kind];
  return k && GROUP_OF[lotLook(k.pack, k.model)];
}

export interface CityStats {
  /** Null until the state has seen a keyframe from every district at one tick. */
  population: number | null;
  /** On the road: in a car, or on foot. Null where there is no folded city, such as a page with no gateway. */
  cars: number | null;
  walkers: number | null;
  buildings: Record<BuildingGroup, number>;
}

const empty = (): Record<BuildingGroup, number> => ({ homes: 0, shops: 0, towers: 0, factories: 0 });

/**
 * A reader of the stats for one city. The generated city is counted once; a call then only looks at the lots that
 * differ from it. The population is kept once known, since a state folded from a seek may not hold every keyframe.
 */
export function createStats(city: City): (state: CityState | null, tick: number) => CityStats {
  const generated = empty();
  for (const lot of city.lots) {
    const g = groupOf(lot.kind);
    if (g) generated[g]++;
  }
  let population: number | null = null;
  return (state, tick) => {
    const buildings = { ...generated };
    if (!state) return { population: null, cars: null, walkers: null, buildings };
    for (const [id, b] of state.built) {
      const was = city.lots[id] && groupOf(city.lots[id].kind);
      if (was) buildings[was]--;
      const now = b.kind === NO_BUILDING ? undefined : groupOf(b.kind);
      if (now) buildings[now]++;
    }
    population = state.population ?? population;
    return { population, ...state.onRoad(tick), buildings };
  };
}
