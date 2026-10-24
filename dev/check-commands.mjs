// Checks that a builder's command published through the gateway reaches the
// city: signs in as the dev IdP's `mayor` from a plain client (no Origin
// header), publishes build commands and reads the districts' ticks for the
// `command` event, with who sent it, and the `built` event it caused in the
// same record. Then it publishes commands the sim must refuse and checks that
// each is recorded with its reason and changes nothing. A `viewer` has no
// right to publish.
//
//   node dev/check-commands.mjs [city]   (default: CHECK_CITY, else pinecrest)
//
// Reads ticks with dev/lib/gateway.mjs, a small decoder of the record layout in
// docs/design.md, so it needs no wasm build. It reads the events of keyframe records too, and the
// check fails when a command's result never shows up. Between the build and the
// demolish it waits for the district's next keyframe, which must list the lot.
import { APPLIED, OCCUPIED, UNKNOWN, UNSUPPORTED, build, commandBytes, demolish, joined, placeRoad, sleep } from "./lib/gateway.mjs";

const city = process.argv[2] ?? process.env.CHECK_CITY ?? "pinecrest";
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

// Refusals are recorded with their reason and change nothing: no built, demolished or road event beside them.
const cases = [
  ["a second build on the same lot", build(built.lot, 1), OCCUPIED, built.command.record.district],
  ["a build past the last lot", build(4_000_000_000), UNKNOWN, 0],
  ["a road", placeRoad(0, 1), UNSUPPORTED, 0],
];
{
  const seen = await mayor.send(cases.map(([, command], i) => [2000 + i, command]));
  cases.forEach(([what, , result, district], i) => {
    const e = seen.get(2000 + i);
    if (e.result !== result) fail(`${what}: result ${e.result}, wanted ${result}`);
    if (e.record.district !== district) fail(`${what}: recorded in district ${e.record.district}, wanted ${district}`);
    if (e.principal !== built.command.principal) fail(`${what}: the sender changed`);
    if (e.record.events.some((x) => ["built", "demolished", "road"].includes(x.type))) fail(`${what}: changed something`);
    console.log(`${city}: ${what} refused with ${result} in district ${e.record.district}`);
  });
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
}
mayor.close();
console.log(`${city}: commands applied, attributed and refused as expected`);
process.exit(0);
