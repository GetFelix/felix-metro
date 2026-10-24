// The list of cities, as the registry stream tells it: every `created` and `forked` record, in the order they were
// written. Followed through the same session as the city on screen.
import { decodeRecord } from './core/felix_metro_core.js';
import { Gateway, GatewayError, type EventFrame } from './gateway';

const STREAM = 'cities';
const SLOT = 'cities';

/** One city of the registry. */
export interface CityEntry {
  name: string;
  /** Districts on a side; 0 for a fork, which has its parent's. */
  districts: number;
  /** The city this one was forked from, or null. */
  parent: string | null;
  wallUs: number;
}

/** The entry a registry record adds, or `null` for bytes that are not one. */
export function parseEntry(bytes: Uint8Array): CityEntry | null {
  try {
    const record = JSON.parse(decodeRecord(bytes));
    if (record.kind !== 'registry' || typeof record.name !== 'string') return null;
    return {
      name: record.name,
      districts: record.type === 'created' ? Number(record.districts) : 0,
      parent: record.type === 'forked' ? String(record.parent) : null,
      wallUs: Number(record.wallUs),
    };
  } catch (err) {
    console.error('a registry record did not decode', err);
    return null;
  }
}

/** "harbor" as "Harbor"; a fork's lineage name is shown as it is written. */
export function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Districts on a side of `city`; a fork has the size of the city it came from. 0 when the registry does not say. */
export function citySize(city: CityEntry, entries: ReadonlyMap<string, CityEntry>): number {
  let entry: CityEntry | undefined = city;
  for (let hops = 0; entry && hops < 32; hops++) {
    if (entry.districts > 0) return entry.districts;
    entry = entry.parent ? entries.get(entry.parent) : undefined;
  }
  return 0;
}

/** Follows the registry stream from the first record, and again from the last one handled plus one after a drop. */
export class Registry {
  readonly cities = new Map<string, CityEntry>();
  readonly slot = SLOT;
  /** The offset of the last record handled, or -1 before any. */
  private last = -1;
  private gateway: Gateway | null = null;
  private resyncing = false;

  constructor(private readonly onChange: (cities: CityEntry[]) => void = () => {}) {}

  /** Follow through `gateway`, a new session after the first. Never throws: a page without a registry still works. */
  async attach(gateway: Gateway): Promise<void> {
    this.gateway = gateway;
    this.resyncing = false;
    await this.subscribe(gateway);
  }

  /** The subscription dropped records or ended. */
  lost(): void {
    const gateway = this.gateway;
    if (!gateway || this.resyncing) return;
    this.resyncing = true;
    void this.subscribe(gateway).finally(() => {
      if (gateway === this.gateway) this.resyncing = false;
    });
  }

  private async subscribe(gateway: Gateway): Promise<void> {
    let from = this.last + 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await gateway.subscribe(STREAM, SLOT, 0, from, (frame) => this.onFrame(gateway, frame));
        return;
      } catch (err) {
        // Retention is off for the registry, but if it ever trims, start from what is left.
        if (err instanceof GatewayError && err.code === 'trimmed' && err.oldest !== undefined) {
          from = err.oldest;
          this.last = from - 1;
          continue;
        }
        console.warn('the city list is not available', err);
        return;
      }
    }
  }

  private onFrame(gateway: Gateway, frame: EventFrame): void {
    if (gateway !== this.gateway || frame.offset === null || frame.offset <= this.last) return;
    if (frame.skippedBefore > 0 || (this.last >= 0 && frame.offset !== this.last + 1)) return this.lost();
    this.last = frame.offset;
    const entry = parseEntry(frame.payload);
    if (!entry || this.cities.has(entry.name)) return;
    this.cities.set(entry.name, entry);
    this.onChange([...this.cities.values()]);
  }
}
