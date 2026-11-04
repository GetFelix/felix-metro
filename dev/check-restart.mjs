// Checks that a sim restarted over its log carries on, from a plain client through the gateway. Three phases; the sim
// is stopped before the second and started after it:
//
//   node dev/check-restart.mjs before [city]    builds on a few lots and notes where each district's log stands
//   (stop the sim)
//   node dev/check-restart.mjs offline [city]   sends a demolish while the sim is down
//   (start the sim)
//   node dev/check-restart.mjs after [city]     the ticks from the noted offsets run on one after another, with
//                                               none repeated or missing; the command sent while the sim was
//                                               down ran once; the keyframes after the restart still list the
//                                               builds and say who built each, and when. Then it takes them down.
//
// The notes between phases are in CHECK_RESTART_FILE (default: the temp directory).
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APPLIED, DISTRICTS, build, commandBytes, decodeMarkers, demolish, joined, sleep } from "./lib/gateway.mjs";

const NO_BUILDING = 65535;
const NAME = "check-restart";
const phase = process.argv[2];
const city = process.argv[3] ?? process.env.CHECK_CITY ?? "pinecrest";
const FILE = process.env.CHECK_RESTART_FILE ?? path.join(os.tmpdir(), `check-restart-${city}.json`);
const OFFLINE_ID = 7000;
const fail = (message) => {
  console.error(`${city}: ${message}`);
  process.exit(1);
};
process.on("uncaughtException", (err) => fail(err.message));
process.on("unhandledRejection", (err) => fail(err.message ?? String(err)));

if (phase === "before") {
  const mayor = await joined(city, "mayor", { name: NAME });
  mayor.follow();
  while (mayor.newest < 0) await sleep(200);
  await mayor.ready();
  // Build until a few lots have taken it: some hold a building, so probe a batch at a time.
  const taken = [];
  for (let first = 0; first < 400 && taken.length < 4; first += 8) {
    const lots = Array.from({ length: 8 }, (_, i) => first + i);
    const seen = await mayor.send(lots.map((lot) => [1000 + lot, build(lot)]));
    for (const lot of lots) {
      const command = seen.get(1000 + lot);
      if (command.result === APPLIED) taken.push({ lot, district: command.record.district, tick: command.record.tick });
    }
  }
  if (taken.length < 2) fail(`only ${taken.length} lots took a build`);
  while (mayor.last.size < DISTRICTS) await sleep(200);
  const last = Array.from({ length: DISTRICTS }, (_, d) => mayor.last.get(d));
  await writeFile(FILE, JSON.stringify({ taken, last }));
  console.log(`${city}: built on lots ${taken.map((t) => t.lot)}; districts at ticks ${last.map((l) => l.tick)}`);
  mayor.close();
  process.exit(0);
}

const state = JSON.parse(await readFile(FILE, "utf8"));

if (phase === "offline") {
  const mayor = await joined(city, "mayor", { name: NAME });
  const lot = state.taken.at(-1).lot;
  const answer = await mayor.publish(commandBytes(NAME, OFFLINE_ID, demolish(lot)));
  if (answer.type !== "ack") fail(`publishing the demolish of lot ${lot} was refused: ${answer.code} ${answer.message ?? ""}`);
  console.log(`${city}: sent a demolish of lot ${lot} while the sim is down`);
  mayor.close();
  process.exit(0);
}

if (phase !== "after") fail("usage: check-restart.mjs before|offline|after [city]");

const mayor = await joined(city, "mayor", { name: NAME });
mayor.follow(state.last.map((l) => l.offset));
const noted = Math.max(...state.last.map((l) => l.tick));
const deadline = Date.now() + 240_000;
const byDistrict = (d) => mayor.records.filter((r) => r.district === d);

// Ticks well past the restart in every district, and the keyframe after the restart in each district that was built in.
const wanted = new Set(state.taken.map((t) => t.district));
const frames = () => [...wanted].every((d) => byDistrict(d).some((r) => r.keyframe && r.tick > noted));
while (Date.now() < deadline) {
  const ticked = Array.from({ length: DISTRICTS }, (_, d) => byDistrict(d).at(-1)?.tick ?? -1).every((t) => t > noted + 40);
  if (ticked && frames()) break;
  await sleep(500);
}
if (Date.now() >= deadline) fail("the city did not carry on, or no keyframe came after the restart");

for (let d = 0; d < DISTRICTS; d++) {
  const records = byDistrict(d);
  if (records[0].tick !== state.last[d].tick) fail(`district ${d}: the first record read is tick ${records[0].tick}, noted ${state.last[d].tick}`);
  records.forEach((r, i) => {
    if (i > 0 && r.tick !== records[i - 1].tick + 1) fail(`district ${d}: tick ${r.tick} follows tick ${records[i - 1].tick}`);
  });
}
console.log(`${city}: every district's ticks run on from ${noted} with none repeated or missing`);

// The demolish sent while the sim was down ran once, and nothing the sim had already done ran again.
const lot = state.taken.at(-1).lot;
const ran = mayor.records.flatMap((r) => r.events.filter((e) => e.type === "command" && e.id === OFFLINE_ID));
if (ran.length !== 1 || ran[0].result !== APPLIED) fail(`the demolish sent while the sim was down shows ${JSON.stringify(ran.map((e) => e.result))}`);
const again = mayor.records.filter((r) => r.tick > noted).flatMap((r) => r.events.filter((e) => e.type === "command" && e.id !== OFFLINE_ID));
if (again.length > 0) fail(`a command the sim had already applied was applied again: ${again.map((e) => e.id)}`);
console.log(`${city}: the demolish of lot ${lot} sent while the sim was down ran once`);

// The keyframes after the restart list what stands: the builds, but not the lot that came down.
for (const { lot: l, district } of state.taken) {
  const frame = byDistrict(district).find((r) => r.keyframe && r.tick > noted);
  const kind = frame.keyframe.get(l);
  const standing = kind !== undefined && kind !== NO_BUILDING;
  if (standing === (l === lot)) fail(`the keyframe at tick ${frame.tick} has lot ${l} as ${kind}`);
}
console.log(`${city}: the keyframes after the restart list the builds`);

// The timeline's markers outlive the restart: each build is still listed, once, and the demolish sent while the sim
// was down was added to the day's list.
for (const { lot: l, tick } of state.taken) {
  const bytes = await mayor.stateGet(`markers.${Math.floor(tick / 5760)}`);
  const marks = bytes ? decodeMarkers(bytes).markers : [];
  // The same lot may have been built before in the day, so look at the build's own tick.
  const builds = marks.filter((m) => m.tick === tick && m.type === 1 && m.subject === l);
  if (builds.length !== 1 || builds[0].tick !== tick) fail(`the markers list lot ${l}'s build ${builds.length} times, wanted once at tick ${tick}`);
}
{
  const ticks = mayor.records.find((r) => r.events.some((e) => e.type === "command" && e.id === OFFLINE_ID)).tick;
  const bytes = await mayor.stateGet(`markers.${Math.floor(ticks / 5760)}`);
  const down = (bytes ? decodeMarkers(bytes).markers : []).filter((m) => m.tick === ticks && m.type === 2 && m.subject === lot);
  if (down.length !== 1) fail(`the markers list the demolish of lot ${lot} ${down.length} times, wanted once`);
}
console.log(`${city}: the markers survived the restart`);

// The same keyframe ticks say who built each lot and at which tick, and say nothing of the one that came down.
for (const { lot: l, district, tick } of state.taken) {
  const frame = byDistrict(district).find((r) => r.keyframe && r.tick > noted);
  const author = frame.events
    .filter((e) => e.type === "author")
    .flatMap((e) => e.lots.filter(([lot]) => lot === l).map(([, built]) => ({ name: e.name, tick: built })))[0];
  if (l === lot) {
    if (author) fail(`the keyframe at tick ${frame.tick} still names ${author.name} as the author of lot ${l}, which came down`);
  } else if (!author || author.name !== NAME || author.tick !== tick) {
    fail(`the keyframe at tick ${frame.tick} has ${JSON.stringify(author)} for lot ${l}, built by ${NAME} at tick ${tick}`);
  }
}
console.log(`${city}: the keyframes after the restart say who built each lot`);

// Leave the city as the next check expects.
const rest = state.taken.filter((t) => t.lot !== lot);
// The tick limit is about latency, and this reader may be well behind the live tip.
const seen = await mayor.send(rest.map((t) => [3000 + t.lot, demolish(t.lot)]), 1_000_000);
for (const t of rest) if (seen.get(3000 + t.lot).result !== APPLIED) fail(`demolishing lot ${t.lot} was refused`);
mayor.close();
console.log(`${city}: a restarted sim carried on from its log`);
process.exit(0);
