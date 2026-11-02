// Sets one of the mayor's policies from a plain client: signs in as the dev IdP's `mayor`, sends a `policy` command
// through the gateway and prints how the sim answered.
//
//   node dev/policy.mjs <city> <avenue|street|shops> <value>
//
// `avenue` and `street` are speed limits in percent of the road's speed (30 to 100); `shops` is the hours shops stay
// open past their usual close (0 to 3). Each policy can change once a city day.
import { RESULT_NAMES, joined, policy, sleep } from "./lib/gateway.mjs";

const KINDS = { shops: 0, avenue: 1, street: 2 };
const [city, name, text] = process.argv.slice(2);
const kind = KINDS[name];
const value = Number(text);
if (!city || kind === undefined || !Number.isInteger(value) || value < 0 || value > 255) {
  console.error("usage: node dev/policy.mjs <city> <avenue|street|shops> <value>");
  process.exit(2);
}

const mayor = await joined(city, "mayor", { name: "policy" });
mayor.follow();
while (mayor.newest < 0) await sleep(200);
// The sim opens its command subscription in the background, so a command sent before it is up is lost.
await mayor.ready();
const id = Math.floor(Date.now() / 1000);
const seen = await mayor.send([[id, policy(kind, value)]]);
const result = seen.get(id).result;
console.log(`${city}: ${name} limit ${value}: ${RESULT_NAMES[result] ?? result}`);
mayor.close();
process.exit(result === 0 ? 0 : 1);
