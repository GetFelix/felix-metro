// The recorded day the sim wrote (`sim/src/world/tests.rs` rewrites it), read back through core's decoder.
import { readFileSync } from 'node:fs';
import { decodeRecord, initSync } from './core/felix_metro_core.js';
import type { TickRecord } from './city';
import type { DayEntry } from './day';

interface Fixture {
  seed: string;
  districts: number;
  /** The last tick recorded. */
  through: number;
  residents: { id: number; days: Record<string, unknown>[][] }[];
  records: { district: number; tick: number; hex: string }[];
}

const here = (name: string) => new URL(name, import.meta.url);

/** The records of the recorded day, decoded by the WebAssembly build, and what the panel must show for each resident. */
export function recordedDay(): {
  through: number;
  records: TickRecord[];
  expected: Map<number, DayEntry[][]>;
} {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
  const fixture = JSON.parse(readFileSync(here('./day-fixture.json'), 'utf8')) as Fixture;
  const records = fixture.records.map(
    (r) => JSON.parse(decodeRecord(Uint8Array.from(r.hex.match(/../g)!, (byte) => parseInt(byte, 16)))) as TickRecord,
  );
  const expected = new Map(fixture.residents.map((r) => [r.id, r.days as unknown as DayEntry[][]]));
  return { through: fixture.through, records, expected };
}
