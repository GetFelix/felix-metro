// Checks that a city can be forked through the gateway, from a plain client. A mayor sends `fork` for a recent
// tick of the city; the check then waits for the fork to appear in the registry, joins it under its gateway name
// (`pinecrest_<name>`) and checks that
//   - the fork's log holds the parent's history through the fork tick (every tick of every district, the same
//     number of commands, builds and keyframes as the parent has there) and ticks on past it;
//   - a build in the fork is applied there and never shows in the parent, and a build in the parent after the
//     fork never shows in the fork.
// Commands the sim must refuse (a bad name, a tick that has not happened, a name that is taken) are recorded with
// their reason.
//
//   node dev/check-fork.mjs [city]   (default: CHECK_CITY, else pinecrest)
import {
  APPLIED,
  BAD_FORK_NAME,
  DISTRICTS,
  FORK_EXISTS,
  FORK_TICK,
  build,
  felixName,
  fork,
  joined,
  sleep,
} from "./lib/gateway.mjs";

const city = process.argv[2] ?? process.env.CHECK_CITY ?? "pinecrest";
const NAME = "check-fork";
const fail = (message) => {
  console.error(`${city}: ${message}`);
  process.exit(1);
};
process.on("uncaughtException", (err) => fail(err.message));
process.on("unhandledRejection", (err) => fail(err.message ?? String(err)));

// Ids no other check uses: the fork keeps the parent's history, and with it the command results of earlier checks.
const ID = 900_000_000;

const waitFor = async (what, ms, test) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = test();
    if (found) return found;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await sleep(500);
  }
};

// A name no earlier run took.
const suffix = Date.now().toString(36);
const forkName = `fk-${suffix}`;
const lineage = `${city}~${forkName}`;

const parent = await joined(city, "mayor", { name: NAME });
const cities = [];
parent.followCities((record) => cities.push(record));
// The parent's whole history, to compare with the fork's.
parent.follow(Array.from({ length: DISTRICTS }, () => 0));
await waitFor("the parent's ticks", 120_000, () => parent.newest > 0);
await parent.ready(ID, 240_000);

// The newest tick every district has, so the fork tick is one the sim has committed.
const level = () => Math.min(...Array.from({ length: DISTRICTS }, (_, d) => parent.last.get(d)?.tick ?? -1));
await waitFor("every district's history", 300_000, () => level() > 200);
const tick = level() - 100;

const refusals = [
  ["a name with a capital", fork(tick, "Bridge"), BAD_FORK_NAME],
  ["an empty name", fork(tick, ""), BAD_FORK_NAME],
  ["a tick that has not happened", fork(parent.newest + 10_000, "later"), FORK_TICK],
];
for (const [i, [what, command, result]] of refusals.entries()) {
  const seen = await parent.command(ID + 10 + i, command);
  if (!seen) fail(`${what}: no result`);
  if (seen.result !== result) fail(`${what}: result ${seen.result}, wanted ${result}`);
  console.log(`${city}: ${what} refused with ${result}`);
}

const forked = await parent.command(ID + 20, fork(tick, forkName), 30_000);
if (!forked) fail("the fork command got no result");
if (forked.result !== APPLIED) fail(`the fork command was refused with ${forked.result}`);
const event = forked.record.events.find((e) => e.type === "forked");
if (!event || event.name !== lineage || event.tick !== tick) fail(`no forked event for ${lineage} at ${tick} beside the command`);
if (event.principal !== forked.principal) fail("the forked event names someone other than the sender");
console.log(`${city}: fork of tick ${tick} applied at tick ${forked.record.tick} as ${lineage}`);

const again = await parent.command(ID + 21, fork(tick, forkName), 30_000);
if (again?.result !== FORK_EXISTS) fail(`the same name again: result ${again?.result}, wanted ${FORK_EXISTS}`);

// The registry lists the fork once its history is copied, which takes a little while.
const listed = await waitFor(`${lineage} in the registry`, 300_000, () => cities.find((c) => c.name === lineage));
if (listed.type !== "forked" || listed.parent !== city || listed.tick !== tick) fail(`the registry says ${JSON.stringify(listed, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
if (listed.principal !== forked.principal) fail("the registry names someone other than the sender");
console.log(`${city}: ${lineage} is in the registry`);

// Join the fork and read its whole log.
const child = await joined(felixName(lineage), "mayor", { name: NAME });
child.follow(Array.from({ length: DISTRICTS }, () => 0));
await waitFor("the fork's ticks past the fork tick", 120_000, () => child.newest > tick + 20);
await child.ready(ID + 1000, 240_000);

const summary = (session, upTo) => {
  const out = [];
  for (let district = 0; district < DISTRICTS; district++) {
    const own = session.records.filter((r) => r.district === district && r.tick <= upTo);
    const ticks = own.map((r) => r.tick);
    if (ticks.length !== upTo + 1 || ticks.some((t, i) => t !== i)) fail(`${session.city}: district ${district} holds ${ticks.length} records of ticks 0..${upTo}, not every one once`);
    const count = (type) => own.flatMap((r) => r.events).filter((e) => e.type === type).length;
    out.push({ keyframes: own.filter((r) => r.keyframe).length, commands: count("command"), built: count("built"), demolished: count("demolished") });
  }
  return out;
};
const [theirs, ours] = [summary(parent, tick), summary(child, tick)];
if (JSON.stringify(theirs) !== JSON.stringify(ours)) fail(`the fork's history differs from the parent's: ${JSON.stringify(ours)} against ${JSON.stringify(theirs)}`);
console.log(`${city}: the fork holds the parent's ticks 0 to ${tick}, ${JSON.stringify(ours)}`);
const next = Math.min(...Array.from({ length: DISTRICTS }, (_, d) => child.records.filter((r) => r.district === d && r.tick > tick).length));
if (next < 10) fail("the fork did not run past its fork tick");

// A build in the fork stays in the fork. Some lots hold a building, so probe for ground that is free.
let lot = null;
for (let first = 0; first < 400 && lot === null; first += 8) {
  const lots = Array.from({ length: 8 }, (_, i) => first + i);
  const seen = await child.send(lots.map((l) => [ID + 100 + l, build(l)]));
  lot = lots.find((l) => seen.get(ID + 100 + l).result === APPLIED) ?? null;
}
if (lot === null) fail("no lot in the fork took a build");
const parentMark = parent.newest;
await waitFor("the parent to tick on", 60_000, () => parent.newest > parentMark + 8);
if (parent.results.has(ID + 100 + lot)) fail("the parent recorded the fork's build");
console.log(`${city}: lot ${lot} built in the fork and not in the parent`);

// And the other way: a command in the parent never reaches the fork.
const there = await parent.command(ID + 30, build(4_000_000_000));
if (!there || there.result === APPLIED) fail("the parent should have refused a build past the last lot");
const childMark = child.newest;
await waitFor("the fork to tick on", 60_000, () => child.newest > childMark + 8);
if (child.results.has(ID + 30)) fail("the fork recorded a command sent to the parent");

parent.close();
child.close();
console.log(`${city}: ${lineage} runs apart from its parent`);
process.exit(0);
