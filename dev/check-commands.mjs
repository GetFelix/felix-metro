// Checks that a builder's command published through the gateway reaches the
// city: signs in as the dev IdP's `mayor` from a plain client (no Origin
// header), publishes build commands and reads the districts' ticks for the
// `command` event, with who sent it, and the `built` event it caused in the
// same record. Then it publishes commands the sim must refuse and checks that
// each is recorded with its reason and changes nothing. Last it lays a road
// over the cleared ground, takes it away again and checks both `roadwork`
// events. A `viewer` has no right to publish.
//
//   node dev/check-commands.mjs [city]   (default: CHECK_CITY, else pinecrest)
//
// Reads ticks with dev/lib/gateway.mjs, a small decoder of the record layout in
// docs/design.md, so it needs no wasm build. It reads the events of keyframe records too, and the
// check fails when a command's result never shows up. Between the build and the
// demolish it waits for the district's next keyframe, which must list the lot.
import {
  APPLIED,
  NOT_BUILT,
  NOT_STRAIGHT,
  OCCUPIED,
  ROAD_ADDED,
  ROAD_BLOCKED,
  ROAD_EXISTS,
  ROAD_REMOVED,
  UNKNOWN,
  UNSUPPORTED,
  build,
  commandBytes,
  decodeMarkers,
  demolish,
  joined,
  placeRoad,
  removeRoad,
  sleep,
} from "./lib/gateway.mjs";

const city = process.argv[2] ?? process.env.CHECK_CITY ?? "pinecrest";

// The one pair of nodes in each 2 by 2 city that a road may join over the cleared ground and empty plots alone, and
// the district of node a, where its commands are recorded. Found by trying every pair against core's
// `Metro.roadCheck` and keeping those whose tiles are all bare development or doorless lots; core/examples/fixture.rs
// lays the same two.
const ROADS = { harbor: { a: 6, b: 7, district: 1 }, pinecrest: { a: 65, b: 75, district: 3 } };
/** A `zone` command: lot and zone, which the sim does not carry out yet. */
const zone = (lot, z) => {
  const b = Buffer.alloc(6);
  b[0] = 2;
  b.writeUInt32LE(lot, 1);
  b[5] = z;
  return b;
};
const CHANGED = ["built", "demolished", "road", "roadwork"];
const NAME = "check-commands";
const fail = (message) => {
  console.error(`${city}: ${message}`);
  process.exit(1);
};
process.on("uncaughtException", (err) => fail(err.message));
process.on("unhandledRejection", (err) => fail(err.message ?? String(err)));

const viewer = await joined(city, "viewer", { name: NAME });
const refused = await viewer.publish(commandBytes(NAME, 1, build(0)));
if (refused.type !== "error") fail("a viewer's command was taken");
viewer.close();

const mayor = await joined(city, "mayor", { name: NAME });
mayor.follow();
while (mayor.newest < 0) await sleep(200);

// The sim opens its command subscription in the background, so commands sent before it is up are lost.
await mayor.ready();

// Some lots hold a building, so probe for ground that is free: a batch at a time, until one of them takes the build.
let built = null;
const taken = [];
for (let first = 0; first < 400 && !built; first += 8) {
  const lots = Array.from({ length: 8 }, (_, i) => first + i);
  const seen = await mayor.send(lots.map((lot) => [1000 + lot, build(lot)]));
  for (const lot of lots) {
    const command = seen.get(1000 + lot);
    if (command.result === APPLIED) {
      const same = command.record.events.find((e) => e.type === "built" && e.lot === lot);
      if (!same) fail(`lot ${lot}: the command was applied but its record has no built event`);
      built ??= { lot, command };
      taken.push(lot);
    }
  }
}
if (!built) fail("no lot took a build in the first 400");
if (built.command.principal === 0n) fail("the command event carries no sender");
console.log(`${city}: build of lot ${built.lot} applied at tick ${built.command.record.tick} in district ${built.command.record.district}, sender ${built.command.principal.toString(16)}`);

// Refusals are recorded with their reason and change nothing: no built, demolished or road event beside them. Node 0
// is in district 0 in every city, and so is segment 0's node a.
const cases = [
  ["a second build on the same lot", build(built.lot, 1), OCCUPIED, built.command.record.district],
  ["a build past the last lot", build(4_000_000_000), UNKNOWN, 0],
  ["a zone", zone(0, 1), UNSUPPORTED, 0],
  ["a road from a node to itself", placeRoad(0, 0), NOT_STRAIGHT, 0],
  ["a road past the last node", placeRoad(4_000_000_000, 0), UNKNOWN, 0],
  ["taking away a road the city was generated with", removeRoad(0), NOT_BUILT, 0],
];
const refusedAt = [];
if (city === "pinecrest") {
  cases.push(["a road where one already runs", placeRoad(0, 1), ROAD_EXISTS, 0], ["a road over other roads", placeRoad(0, 2), ROAD_BLOCKED, 0]);
}
{
  const seen = await mayor.send(cases.map(([, command], i) => [2000 + i, command]));
  cases.forEach(([what, , result, district], i) => {
    const e = seen.get(2000 + i);
    refusedAt.push(e.record.tick);
    if (e.result !== result) fail(`${what}: result ${e.result}, wanted ${result}`);
    if (e.record.district !== district) fail(`${what}: recorded in district ${e.record.district}, wanted ${district}`);
    if (e.principal !== built.command.principal) fail(`${what}: the sender changed`);
    if (e.record.events.some((x) => CHANGED.includes(x.type))) fail(`${what}: changed something`);
    console.log(`${city}: ${what} refused with ${result} in district ${e.record.district}`);
  });
}

// The timeline's markers: the day's list, kept in district 0's state, names the build, and who made it. The refused
// build of the same lot left nothing. A lot can be built and demolished more than once in a day (this check and the
// restart check both take the first free lot), so a marker is found by its tick. District 0 commits the tick on its
// own, so the list can trail the command's result by a moment.
const MARK_BUILT = 1;
const MARK_DEMOLISHED = 2;
const markersOf = async (tick, type, lot) => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const bytes = await mayor.stateGet(`markers.${Math.floor(tick / 5760)}`);
    const found = bytes && decodeMarkers(bytes)?.markers.filter((m) => m.tick === tick && m.type === type && m.subject === lot);
    if (found?.length || Date.now() > deadline) return found ?? [];
    await sleep(300);
  }
};
{
  const found = await markersOf(built.command.record.tick, MARK_BUILT, built.lot);
  if (found.length !== 1) fail(`the day's markers hold ${found.length} builds of lot ${built.lot}, wanted 1`);
  if (found[0].tick !== built.command.record.tick) fail(`the marker is at tick ${found[0].tick}, the build at ${built.command.record.tick}`);
  if (found[0].by !== NAME) fail(`the marker names "${found[0].by}", wanted "${NAME}"`);
  console.log(`${city}: the day's markers name the build of lot ${built.lot} at tick ${found[0].tick}, by ${found[0].by}`);
  // The refusals left no marker: none at their ticks, and no second build of the lot after the first.
  const days = new Set([built.command.record.tick, ...refusedAt].map((t) => Math.floor(t / 5760)));
  const listed = [];
  for (const d of days) {
    const bytes = await mayor.stateGet(`markers.${d}`);
    if (bytes) listed.push(...decodeMarkers(bytes).markers);
  }
  const stray = listed.filter((m) => refusedAt.includes(m.tick) && m.tick !== built.command.record.tick);
  if (stray.length) fail(`a refused command left markers: ${JSON.stringify(stray)}`);
  const again = listed.filter((m) => m.type === MARK_BUILT && m.subject === built.lot && m.tick >= built.command.record.tick);
  if (again.length !== 1) fail(`lot ${built.lot} has ${again.length} build markers from tick ${built.command.record.tick} on, wanted 1`);
  console.log(`${city}: the refused commands left no markers`);
}

// The district's next keyframe shows the build: it is a diff against the generated city, so the lot must be listed.
{
  const district = built.command.record.district;
  const after = built.command.record.tick;
  const deadline = Date.now() + 240_000;
  let frame;
  while (!(frame = mayor.records.find((r) => r.district === district && r.keyframe && r.tick > after)) && Date.now() < deadline) {
    await sleep(500);
  }
  if (!frame) fail(`no keyframe in district ${district} after tick ${after}`);
  if (!frame.keyframe.has(built.lot)) fail(`the keyframe at tick ${frame.tick} does not list the built lot ${built.lot}`);
  console.log(`${city}: keyframe at tick ${frame.tick} lists lot ${built.lot}`);
}

// Take what was built down again, so the city is as the next check expects. Each one is a demolish that must apply.
{
  const seen = await mayor.send(taken.map((lot) => [3000 + lot, demolish(lot)]));
  for (const lot of taken) {
    const e = seen.get(3000 + lot);
    if (e.result !== APPLIED) fail(`demolishing lot ${lot}: result ${e.result}`);
    if (!e.record.events.some((x) => x.type === "demolished" && x.lot === lot)) fail(`lot ${lot}: no demolished event`);
  }
  const last = taken.at(-1);
  const found = await markersOf(seen.get(3000 + last).record.tick, MARK_DEMOLISHED, last);
  if (found.length !== 1 || found[0].by !== NAME) fail(`the day's markers do not name the demolition of lot ${last}: ${JSON.stringify(found)}`);
}
// A road over the cleared ground is laid, and taken away again so the city is as the next check expects.
const road = ROADS[city];
if (road) {
  const [laid] = (await mayor.send([[4000, placeRoad(road.a, road.b)]])).values();
  if (laid.result !== APPLIED) fail(`the road from node ${road.a} to ${road.b}: result ${laid.result}`);
  if (laid.record.district !== road.district) fail(`the road was recorded in district ${laid.record.district}`);
  const work = laid.record.events.find((x) => x.type === "roadwork");
  if (!work || work.change !== ROAD_ADDED || work.a !== road.a || work.b !== road.b) fail(`no roadwork event for the road: ${JSON.stringify(work)}`);
  console.log(`${city}: road from node ${road.a} to ${road.b} laid as segment ${work.segment}`);
  const twice = (await mayor.send([[4001, placeRoad(road.a, road.b)]])).get(4001);
  if (twice.result !== ROAD_EXISTS) fail(`the same road again: result ${twice.result}, wanted ${ROAD_EXISTS}`);
  const [gone] = (await mayor.send([[4002, removeRoad(work.segment)]])).values();
  if (gone.result !== APPLIED) fail(`taking the road away: result ${gone.result}`);
  if (!gone.record.events.some((x) => x.type === "roadwork" && x.change === ROAD_REMOVED && x.segment === work.segment)) {
    fail("no roadwork event for taking the road away");
  }
  const again = (await mayor.send([[4003, removeRoad(work.segment)]])).get(4003);
  if (again.result !== NOT_BUILT) fail(`taking the road away twice: result ${again.result}, wanted ${NOT_BUILT}`);
  console.log(`${city}: road taken away again, and a second removal refused`);
}
mayor.close();
console.log(`${city}: commands applied, attributed and refused as expected`);
process.exit(0);
