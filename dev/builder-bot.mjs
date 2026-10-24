// Grows a neighbourhood on camera: signs in as the dev IdP's `mayor` from a plain client, waits until the sim
// answers a probe, then publishes `build` commands through the gateway one at a time, on the lots nearest a chosen
// point first. Homes go on suburban land, shops on corners and arterials, offices toward the centre and
// factories on industrial land. Every result is read: a refusal moves on to the next lot and a lot is never
// sent twice.
//
//   node dev/builder-bot.mjs [city] [flags]      (default city: pinecrest)
//
//   --interval <s>        wall seconds after each build that took (default 2)
//   --count <n>           stop after this many buildings (default 12)
//   --district <n>        the district to grow in (default: the one with the most lots a builder may change)
//   --centre <x,z>        tile to grow around (default: the middle of the densest spot of such lots)
//   --demolish-after <s>  once done, wait this long and take buildings down again, newest first
//   --demolish <n>        how many to take down (default 3)
//   --json <path|->       one JSON object a line: start, each build/demolish with its tick, end ("-" is stdout)
//   --side <n>            districts per side of the city (default DISTRICTS_PER_SIDE, else 4)
//   --city-file <path>    the city as `city_json` prints it (default: run that example with cargo)
//   --result-timeout <s>  how long a command may go unanswered before it counts as lost (default 30)
//
// The city comes from `cargo run -p felix-metro-core --example city_json`, which also lists the lots residents go to.
// Those refuse any change, so the bot leaves them alone; a lot with a building is demolished first, then built on.
// SIGINT or SIGTERM stops after the command in flight and writes the end line. Exit 1 when a command got no result
// or nothing was built. Roads are not placed: the sim refuses them.
import { execFileSync } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { APPLIED, EMPTY, RESULT_NAMES, build, demolish, joined, sleep } from "./lib/gateway.mjs";

const NAME = "builder-bot";
const FIRST_FILLER = 38; // kinds from here are trees and plaza props: nothing a builder counts as a building
// [first kind, how many] of each family in core/src/kinds.rs.
const COMMERCIAL = [0, 14];
const SKYSCRAPERS = [14, 4];
const HOUSES = [19, 10];
const FACTORIES = [29, 6];

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    interval: { type: "string", default: "2" },
    count: { type: "string", default: "12" },
    district: { type: "string" },
    centre: { type: "string" },
    "demolish-after": { type: "string" },
    demolish: { type: "string", default: "3" },
    json: { type: "string" },
    side: { type: "string", default: process.env.DISTRICTS_PER_SIDE ?? "4" },
    "city-file": { type: "string" },
    "result-timeout": { type: "string", default: "30" },
  },
});
const city = positionals[0] ?? process.env.CHECK_CITY ?? "pinecrest";
const interval = Number(flags.interval) * 1000;
const count = Number(flags.count);
const resultMs = Number(flags["result-timeout"]) * 1000;
const demolishAfter = flags["demolish-after"] === undefined ? null : Number(flags["demolish-after"]) * 1000;
const demolishCount = Number(flags.demolish);

function usage(message) {
  console.error(`builder-bot: ${message}`);
  process.exit(2);
}
for (const [what, v] of [["interval", interval], ["count", count], ["result-timeout", resultMs], ["demolish", demolishCount]]) {
  if (!Number.isFinite(v) || v < 0) usage(`--${what} must be a number of at least 0`);
}
if (demolishAfter !== null && !(demolishAfter >= 0)) usage("--demolish-after must be a number of at least 0");

const log = (message) => console.error(`${city}: ${message}`);

// The JSON log: one object a line, written as it happens so a recording script can follow it.
const out = flags.json === undefined ? null : flags.json === "-" ? process.stdout : createWriteStream(flags.json);
const emit = (entry) => out?.write(`${JSON.stringify({ ...entry, at: Date.now() })}\n`);

function loadCity() {
  const text = flags["city-file"]
    ? readFileSync(flags["city-file"], "utf8")
    : execFileSync("cargo", ["run", "-q", "-p", "felix-metro-core", "--example", "city_json", "--", city, flags.side], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      });
  const raw = JSON.parse(text);
  const rows = (names, list) => list.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])));
  return {
    lots: rows(raw.lotColumns, raw.lots),
    segments: rows(raw.segmentColumns, raw.segments),
    centres: raw.centres,
    tower: raw.tower,
    inUse: new Set(raw.inUse),
  };
}

/** Whether a builder may change the lot: not the tower, and not one residents go to. */
const changeable = (world, lot) => lot.id !== world.tower && !world.inUse.has(lot.id);

function chooseDistrict(world) {
  const counts = new Map();
  for (const l of world.lots) if (changeable(world, l)) counts.set(l.district, (counts.get(l.district) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (!best) usage("the city has no lot a builder may change");
  return best[0];
}

/** The lot with the most others within `radius` tiles, so the first buildings stand close together. */
function chooseCentre(lots, radius = 8) {
  let best = null;
  for (const a of lots) {
    const near = lots.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) <= radius).length;
    if (!best || near > best.near) best = { x: a.x, z: a.z, near };
  }
  return best;
}

const hash = (id) => Math.imul(id + 1, 2654435761) >>> 0;
const pick = ([first, n], id) => first + (hash(id) % n);

/** The zone of the land around a lot: its own, or for a park the nearest lot that is not one. */
function landZone(byTile, lot) {
  if (lot.zone !== "park") return lot.zone;
  for (let r = 1; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const near = byTile.get(`${lot.x + dx},${lot.z + dz}`);
        if (near && near.zone !== "park") return near.zone;
      }
    }
  }
  return "suburban";
}

/** What to build on a lot: homes on suburban land, shops on corners and arterials, offices toward the centre. */
function kindFor(world, byTile, lot) {
  const zone = landZone(byTile, lot);
  const door = lot.doorSegment === null ? null : world.segments[lot.doorSegment];
  const onStreet = door && (door.avenue === 1 || lot.doorOffset === 0 || lot.doorOffset === door.length);
  const fromCentre = Math.min(...world.centres.map(([x, z]) => Math.hypot(lot.x - x, lot.z - z)));
  if (zone === "industrial") return pick(FACTORIES, lot.id);
  if (onStreet) return pick(COMMERCIAL, lot.id);
  if (zone === "downtown" || fromCentre <= 6) return pick(SKYSCRAPERS, lot.id);
  if (zone === "commercial") return pick(COMMERCIAL, lot.id);
  return pick(HOUSES, lot.id);
}

const world = loadCity();
const byTile = new Map(world.lots.map((l) => [`${l.x},${l.z}`, l]));
const district = flags.district === undefined ? chooseDistrict(world) : Number(flags.district);
const pool = world.lots.filter((l) => l.district === district && changeable(world, l));
if (pool.length === 0) usage(`district ${district} has no lot a builder may change`);
const [cx, cz] = flags.centre ? flags.centre.split(",").map(Number) : (({ x, z }) => [x, z])(chooseCentre(pool));
if (!Number.isFinite(cx) || !Number.isFinite(cz)) usage("--centre wants x,z");
// Nearest first, with parks pushed back a little: a building in green space is the last resort.
const order = pool
  .map((l) => ({ lot: l, cost: Math.hypot(l.x - cx, l.z - cz) + (l.zone === "park" ? 4 : 0) }))
  .sort((a, b) => a.cost - b.cost || a.lot.id - b.lot.id)
  .map((e) => e.lot);

let running = false;
const stop = new AbortController();
const stopped = () => stop.signal.aborted;
const summary = { built: 0, demolished: 0, refused: 0, unanswered: 0, sent: 0 };
const built = [];
const tried = new Set();
let session = null;

function finish(reason, code) {
  const xs = built.map((b) => b.x);
  const zs = built.map((b) => b.z);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  emit({ type: "end", reason, ...summary, centre: built.length ? { x: mean(xs), z: mean(zs) } : null });
  log(`${reason}: ${summary.built} built, ${summary.demolished} demolished, ${summary.refused} refused, ${summary.unanswered} unanswered`);
  session?.close();
  const exit = () => process.exit(code ?? (summary.unanswered > 0 || (summary.built === 0 && reason !== "stopped") ? 1 : 0));
  if (out && out !== process.stdout) out.end(exit);
  else exit();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (running) stop.abort();
    else finish("stopped", 0);
  });
}
process.on("uncaughtException", (err) => {
  log(err.message);
  finish("error", 1);
});
process.on("unhandledRejection", (err) => {
  log(err?.message ?? String(err));
  finish("error", 1);
});

/** Sleeps `ms`, or until a stop. */
const nap = (ms) =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    stop.signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

emit({ type: "start", city, district, centre: { x: cx, z: cz }, interval: interval / 1000, count });
log(`growing district ${district} around ${cx},${cz}, ${pool.length} lots to try`);

session = await joined(city, "mayor", { name: NAME, keep: false });
session.follow();
for (const until = Date.now() + 120_000; session.newest < 0; await sleep(200)) {
  if (Date.now() > until) throw new Error("no tick arrived");
}
// Command ids only need to be unique among this builder's own: start where a rerun is unlikely to overlap.
let nextId = 1_000_000 + (Date.now() % 1_000_000) * 100;
await session.ready(nextId);
nextId += 1000;
running = true;

/** Sends one command and records its result. Returns the result code, or null when none came. */
async function send(type, lot, command, kind, phase = "grow") {
  const id = nextId++;
  summary.sent++;
  const result = await session.command(id, command, resultMs);
  const entry = { type, phase, id, lot: lot.id, x: lot.x, z: lot.z, zone: lot.zone, kind, district: lot.district };
  if (!result) {
    summary.unanswered++;
    emit({ ...entry, result: null, outcome: "no-result" });
    log(`${type} of lot ${lot.id}: no result`);
    return null;
  }
  const outcome = RESULT_NAMES[result.result] ?? `result-${result.result}`;
  emit({ ...entry, tick: result.record.tick, recordDistrict: result.record.district, result: result.result, outcome });
  if (result.result !== APPLIED) {
    summary.refused++;
    log(`${type} of lot ${lot.id} refused: ${outcome}`);
  }
  return result.result;
}

for (const lot of order) {
  if (stopped() || summary.built >= count) break;
  if (tried.has(lot.id)) continue;
  tried.add(lot.id);
  // A lot with a building is cleared first. Nothing there to demolish (an earlier run did it) is as good as done;
  // any other refusal, here or at the build, ends the lot's turn for good.
  if (lot.kind < FIRST_FILLER) {
    const cleared = await send("demolish", lot, demolish(lot.id), lot.kind);
    if (cleared !== APPLIED && cleared !== EMPTY) continue;
  }
  const kind = kindFor(world, byTile, lot);
  if ((await send("build", lot, build(lot.id, kind, lot.facing), kind)) !== APPLIED) continue;
  summary.built++;
  built.push({ ...lot, built: kind });
  log(`built kind ${kind} on lot ${lot.id} (${lot.zone}) at ${lot.x},${lot.z}: ${summary.built} of ${count}`);
  await nap(interval);
}

if (demolishAfter !== null && !stopped() && built.length > 0) {
  log(`done building; taking ${Math.min(demolishCount, built.length)} down in ${demolishAfter / 1000}s`);
  await nap(demolishAfter);
  for (const lot of built.slice().reverse().slice(0, demolishCount)) {
    if (stopped()) break;
    if ((await send("demolish", lot, demolish(lot.id), lot.built, "clear")) === APPLIED) summary.demolished++;
    await nap(interval);
  }
}
finish(stopped() ? "stopped" : summary.built >= count ? "done" : "out of lots");
