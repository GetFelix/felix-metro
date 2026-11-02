// Which road tiles are on screen. The page draws the roads of the state it shows, so a road laid or taken away in the
// live city, and a rewind or a seek to before one, redraws them; core lays the tiles, so the page and the sim agree.
import { syncRoads, type Trips } from './city';
import { parseRoads, type Road } from './layout';

/** Core's `Metro`, as far as drawing roads needs it. */
export interface RoadLayer extends Trips {
  roadsJson(): string;
}

export class RoadsOnScreen {
  private drawn: Uint32Array = new Uint32Array(0);
  /** The road tiles drawn now. */
  tiles: Road[];

  constructor(
    private readonly metro: RoadLayer,
    generated: Road[],
    private readonly draw: (roads: Road[]) => void,
  ) {
    this.tiles = generated;
  }

  /** Draw the roads of a state with `builtRoads`, if they differ from those drawn. True when they were redrawn. */
  show(state: { builtRoads(): Uint32Array }): boolean {
    const list = state.builtRoads();
    const same = list.length === this.drawn.length && list.every((n, i) => n === this.drawn[i]);
    if (same || !syncRoads(this.metro, list)) return false;
    this.drawn = list;
    this.tiles = parseRoads(JSON.parse(this.metro.roadsJson()));
    this.draw(this.tiles);
    return true;
  }
}
