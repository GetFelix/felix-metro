import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeRecord, initSync } from './core/felix_metro_core.js';

const built = (name: string) => readFileSync(new URL(`./core/${name}`, import.meta.url));

/** What the native build wrote: each record's bytes, what it decodes to, and a hash of that JSON. */
const fixture = JSON.parse(built('fixture.json').toString()) as {
  records: { name: string; record: string; json: unknown; hash: string }[];
};
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));

/** FNV-1a over the UTF-8 text, as the fixture example computes it. */
function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

beforeAll(() => {
  initSync({ module: built('felix_metro_core_bg.wasm') });
});

describe('records in WebAssembly', () => {
  it('decodes every native record to the same JSON text', () => {
    const names = fixture.records.map((r) => r.name);
    for (const name of ['tick', 'keyframe', 'command', 'registry']) expect(names).toContain(name);
    for (const { record, json, hash } of fixture.records) {
      const text = decodeRecord(bytes(record));
      expect(fnv1a(text)).toBe(hash);
      expect(JSON.parse(text)).toEqual(json);
    }
  });

  it('reads a keyframe record’s header, diffs and counts', () => {
    const { record } = fixture.records.find((r) => r.name === 'keyframe')!;
    const key = JSON.parse(decodeRecord(bytes(record)));
    expect(key).toMatchObject({ kind: 'tick', tick: 240, keyframeOffset: 8192 });
    expect(key.keyframe.buildings).toHaveLength(2);
    expect(key.keyframe.counts).toEqual({ home: 120, atWork: 80, onRoad: 14, asleep: 6 });
  });

  it('refuses truncated bytes and unknown kinds', () => {
    const { record } = fixture.records.find((r) => r.name === 'tick')!;
    const whole = bytes(record);
    for (let n = 0; n < whole.length; n++) {
      expect(() => decodeRecord(whole.subarray(0, n))).toThrow();
    }
    expect(() => decodeRecord(new Uint8Array([99, 0, 0]))).toThrow('unknown record kind 99');
  });
});
