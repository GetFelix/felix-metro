// One lot's turn for dev/builder-bot.mjs, kept apart from the network so a test can stand in for the sim.
import { APPLIED, EMPTY, OCCUPIED, build, demolish } from "./gateway.mjs";

/**
 * Builds `kind` on `lot` and returns whether it took.
 *
 * A lot that holds a building (`lot.kind` below `filler`) is left alone unless `rebuild`, which demolishes it first.
 * If the build is then refused, the old building is built back. `send(type, lot, command, kind, phase)` resolves to
 * the result code, or null when none came; `mark(lot)` says which lot is bare for now, `mark(null)` that none is;
 * `orphan(lot, restored)` reports a lot that was demolished and not built on, with `restored` true when the old
 * building stands again, false when the restore was refused and null when it got no answer.
 */
export async function takeTurn({ lot, kind, rebuild, filler, send, mark, orphan }) {
  let cleared = false;
  if (lot.kind < filler) {
    if (!rebuild) return false;
    // Marked before the command goes out: a hard exit while it is in flight must still report the lot.
    mark(lot);
    const result = await send("demolish", lot, demolish(lot.id), lot.kind);
    // Nothing to demolish (an earlier run did it) is as good as done. A demolish with no answer may have been applied
    // with the answer lost, so the lot counts as bare until a build or a restore says otherwise.
    cleared = result === APPLIED || result === null;
    if (!cleared) {
      mark(null);
      if (result !== EMPTY) return false;
    }
  }
  const placed = (await send("build", lot, build(lot.id, kind, lot.facing), kind)) === APPLIED;
  if (placed) {
    mark(null);
    return true;
  }
  if (cleared) {
    // The old building is gone, or may be, and nothing replaced it: put it back. A refusal as occupied means the
    // demolish never happened and the building still stands.
    const result = await send("build", lot, build(lot.id, lot.kind, lot.facing), lot.kind, "restore");
    mark(null);
    orphan(lot, result === null ? null : result === APPLIED || result === OCCUPIED);
  }
  return false;
}
