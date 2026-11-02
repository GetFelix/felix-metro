// node --test dev/lib/gateway.test.mjs
// Builds tick records byte by byte from the layout in docs/design.md and reads them with the dev decoder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "./gateway.mjs";

const varint = (n) => {
  const out = [];
  for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
  out.push(n);
  return out;
};
const zigzag = (n) => varint(n < 0 ? -2 * n - 1 : 2 * n);
const u16 = (n) => [n & 0xff, n >> 8];
const u32 = (n) => [...u16(n & 0xffff), ...u16(n >>> 16)];
const u64 = (n) => [...u32(n), 0, 0, 0, 0];
/** An event frame: the body length above four bits of tag. */
const event = (tag, body) => [...varint(body.length * 16 + tag), ...body];

function tick({ district, tick, offset = 0, keyframe = [], events = [] }) {
  const flags = keyframe.length > 0 ? 1 : 0;
  return Uint8Array.from([
    4,
    ...varint(1),
    ...varint(district),
    ...varint(tick),
    4,
    flags,
    ...varint(offset),
    ...u64(0),
    ...varint(events.length),
    ...keyframe,
    ...events.flat(),
  ]);
}

test("reads the header and the events whatever size the varints are", () => {
  const events = [
    event(7, [...u32(12), ...u16(21), 1]),
    event(8, [...u32(300), ...u16(65535), 0]),
    event(9, [...u32(5), 1]),
    event(10, [...u64(99), 2, 0x6d, 0x65, ...u32(7), 2]),
    event(11, [8]),
  ];
  for (const [t, offset] of [[0, 0], [300, 128], [2 ** 21 + 5, 2 ** 21]]) {
    const out = decode(tick({ district: 3, tick: t, offset, events }));
    assert.equal(out.district, 3);
    assert.equal(out.tick, t);
    assert.equal(out.keyframe, null);
    assert.deepEqual(out.events.map((e) => e.type), ["built", "demolished", "road", "command"]);
    assert.deepEqual(out.events[0], { type: "built", lot: 12, kind: 21 });
    assert.deepEqual(out.events[1], { type: "demolished", lot: 300, kind: 65535 });
    assert.equal(out.events[3].principal, 99n);
    assert.equal(out.events[3].id, 7);
    assert.equal(out.events[3].result, 2);
  }
});

test("reads a keyframe's building diff and steps over the rest of it", () => {
  const keyframe = [
    ...varint(2), ...zigzag(10), ...u16(21), 0, ...zigzag(-4), ...u16(65535), 1, // buildings
    ...varint(1), ...zigzag(6), 1, // roads
    ...varint(2), // residents
    ...zigzag(1), ...varint(3 * 4 + 0), 1, 9, 2, // an activity: kind, lot, until
    ...zigzag(1), ...varint(1 * 4 + 1), 0, // a vehicle state, one byte
    ...varint(5), ...varint(1), ...varint(0), ...varint(0), // counts
  ];
  const events = [event(7, [...u32(50), ...u16(22), 0])];
  const out = decode(tick({ district: 0, tick: 240, offset: 240, keyframe, events }));
  assert.deepEqual([...out.keyframe], [[10, 21], [6, 65535]]);
  assert.deepEqual(out.events, [{ type: "built", lot: 50, kind: 22 }]);
});

test("ignores records of another kind", () => {
  assert.equal(decode(Uint8Array.from([1, 0, 0])), null);
});
