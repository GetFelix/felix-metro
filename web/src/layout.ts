// The generated city as the page reads it: rows from core's `generate` JSON, and how each row maps onto the models.
import type { Pack } from './assets';

export interface Lot {
  id: number;
  x: number;
  z: number;
  zone: string;
  kind: number;
  /** Quarter turns from facing south: 0 south, 1 east, 2 north, 3 west. */
  facing: number;
}
export interface Road {
  x: number;
  z: number;
  piece: number;
  rot: number;
  mask: number;
  avenue: boolean;
}
export interface City {
  seed: string;
  tiles: number;
  /** Which map edge the sea lies along: 0 north, 1 east, 2 south, 3 west, or null for a dry city. */
  shore: number | null;
  tower: number;
  lots: Lot[];
  roads: Road[];
  water: [number, number][];
}

/** Rows are arrays in the order named by the `*Columns` entries; read them by name so a new column cannot shift them. */
export function parseCity(json: string): City {
  const raw = JSON.parse(json);
  const rows = (columns: string[], data: unknown[][]) =>
    data.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  return {
    seed: raw.seed,
    tiles: raw.tiles,
    shore: raw.shore,
    tower: raw.tower,
    lots: rows(raw.lotColumns, raw.lots) as unknown as Lot[],
    roads: rows(raw.roadColumns, raw.roads).map((r) => ({ ...r, avenue: r.avenue === 1 })) as unknown as Road[],
    water: raw.water,
  };
}

// ?layout=frame is the style frame's hand-made city; anything else draws the generated one.
export type Layout = 'frame' | 'city';

/** The seed from the URL hash (`/#harbor`), or `harbor` when it is missing or not one core accepts. */
export function seedFromHash(hash: string): string {
  const seed = decodeURIComponent(hash.replace(/^#/, ''));
  return seed.split('~').every((part) => /^[a-z0-9-]{1,32}$/.test(part)) ? seed : 'harbor';
}

/** The model for a road piece and the quarter turns clockwise (seen from above) to apply to it. */
export function roadModel(piece: number, rot: number, avenue: boolean): { name: string; turns: number } {
  switch (piece) {
    case 0: // straight, modelled along X like the base
      return { name: 'road-straight', turns: rot };
    case 1: // corner: the models connect west and south where the base is east and south
      return { name: avenue ? 'road-bend-square' : 'road-bend', turns: rot - 1 };
    case 2: // three ways
      return { name: 'road-intersection-path', turns: rot };
    case 3:
      return { name: 'road-crossroad-path', turns: 0 };
    default: // dead end: the model opens east where the base opens south
      return { name: 'road-end', turns: rot + 1 };
  }
}

/** Rotation about Y for quarter turns clockwise seen from above (positive Y turns counter-clockwise). */
export const clockwise = (turns: number) => (-turns * Math.PI) / 2;

/** Rotation about Y that turns a model's front (+Z, south) to the lot's facing. */
export const facingAngle = (facing: number) => (facing * Math.PI) / 2;

export type LotLook = 'skyscraper' | 'commercial' | 'house' | 'factory' | 'prop' | 'tree' | 'plaza';

/** What a lot's model is, from its name, so the scale and variant rules need no kind numbers. */
export function lotLook(pack: Pack, model: string): LotLook {
  if (model.startsWith('tree')) return 'tree';
  if (model === 'planter' || model.startsWith('detail-parasol')) return 'plaza';
  if (pack === 'industrial') return model.startsWith('building') ? 'factory' : 'prop';
  if (pack === 'suburban') return 'house';
  return model.startsWith('building-skyscraper') ? 'skyscraper' : 'commercial';
}
