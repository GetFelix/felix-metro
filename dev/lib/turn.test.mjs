// node --test dev/lib/turn.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPLIED, BUSY, EMPTY, IN_USE, OCCUPIED } from "./gateway.mjs";
import { takeTurn } from "./turn.mjs";

const FILLER = 38;
const home = { id: 7, kind: 20, facing: 1 };

/** Runs a turn against a sim that answers each command from `answers`, in order, and returns what was seen. */
async function run(answers, options = {}) {
  const sent = [];
  const orphans = [];
  const marks = [];
  const built = await takeTurn({
    lot: home,
    kind: 21,
    rebuild: true,
    filler: FILLER,
    send: async (type, _lot, _command, _kind, phase = "grow") => {
      sent.push(`${type}:${phase}`);
      return answers.shift();
    },
    mark: (lot) => marks.push(lot?.id ?? null),
    orphan: (lot, restored) => orphans.push({ lot: lot.id, restored }),
    ...options,
  });
  return { built, sent, orphans, marks };
}

test("leaves a lot with a building alone unless it may rebuild", async () => {
  const r = await run([], { rebuild: false });
  assert.deepEqual(r, { built: false, sent: [], orphans: [], marks: [] });
});

test("demolishes then builds, and the lot is not bare afterwards", async () => {
  const r = await run([APPLIED, APPLIED]);
  assert.equal(r.built, true);
  assert.deepEqual(r.sent, ["demolish:grow", "build:grow"]);
  assert.deepEqual(r.marks, [7, null]);
  assert.deepEqual(r.orphans, []);
});

test("ends the turn at a demolish the sim refuses", async () => {
  const r = await run([IN_USE]);
  assert.equal(r.built, false);
  assert.deepEqual(r.sent, ["demolish:grow"]);
  assert.deepEqual(r.orphans, []);
});

test("builds on a lot that was already empty, with nothing to restore", async () => {
  const r = await run([EMPTY, BUSY]);
  assert.equal(r.built, false);
  assert.deepEqual(r.sent, ["demolish:grow", "build:grow"]);
  assert.deepEqual(r.orphans, []);
});

test("builds the old kind back when the build is refused after a demolish", async () => {
  const r = await run([APPLIED, BUSY, APPLIED]);
  assert.equal(r.built, false);
  assert.deepEqual(r.sent, ["demolish:grow", "build:grow", "build:restore"]);
  assert.deepEqual(r.orphans, [{ lot: 7, restored: true }]);
  assert.deepEqual(r.marks, [7, null]);
});

test("reports a restore that was refused", async () => {
  const r = await run([APPLIED, BUSY, BUSY]);
  assert.deepEqual(r.orphans, [{ lot: 7, restored: false }]);
});

test("treats a demolish with no answer as possibly applied", async () => {
  // The build is refused and the restore gets no answer either: the lot may be bare.
  const r = await run([null, BUSY, null]);
  assert.equal(r.built, false);
  assert.deepEqual(r.sent, ["demolish:grow", "build:grow", "build:restore"]);
  assert.deepEqual(r.orphans, [{ lot: 7, restored: null }]);
});

test("a demolish with no answer that was applied lets the build take", async () => {
  const r = await run([null, APPLIED]);
  assert.equal(r.built, true);
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.marks, [7, null]);
});

test("a demolish with no answer that never happened finds the building still standing", async () => {
  const r = await run([null, OCCUPIED, OCCUPIED]);
  assert.equal(r.built, false);
  assert.deepEqual(r.orphans, [{ lot: 7, restored: true }]);
});
