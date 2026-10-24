// Checks the JSON log of a dev/builder-bot.mjs run, for CI:
//
//   node dev/check-builder-bot.mjs <log> [--min <n>]
//
// The log must end cleanly, every command it sent must have a result, at least `--min` buildings (default 6)
// must have gone up in one district, and no lot may be tried again after a refusal or built twice.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { min: { type: "string", default: "6" } } });
const min = Number(values.min);
const fail = (message) => {
  console.error(`builder-bot log: ${message}`);
  process.exit(1);
};
if (!positionals[0]) fail("usage: check-builder-bot.mjs <log> [--min <n>]");
const lines = readFileSync(positionals[0], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const start = lines.find((l) => l.type === "start");
const end = lines.find((l) => l.type === "end");
if (!start) fail("no start line");
if (!end) fail("no end line, the bot did not finish");
const commands = lines.filter((l) => l.type === "build" || l.type === "demolish");
if (commands.length !== end.sent) fail(`${commands.length} commands logged but ${end.sent} sent`);
const lost = commands.filter((c) => c.result === null || c.result === undefined);
if (lost.length > 0 || end.unanswered > 0) fail(`${lost.length} commands got no result, first on lot ${lost[0]?.lot}`);

// A lot's turn ends at its first refusal. Nothing to demolish (result 4) is no refusal: the lot is free to build.
const over = new Set();
const builds = new Map();
for (const c of commands.filter((c) => c.phase === "grow")) {
  if (over.has(c.lot)) fail(`lot ${c.lot} was tried again after a refusal (${c.type})`);
  if (c.type === "build") {
    if (builds.has(c.lot)) fail(`lot ${c.lot} was built on twice`);
    builds.set(c.lot, c);
  }
  if (c.result !== 0 && !(c.type === "demolish" && c.result === 4)) over.add(c.lot);
}

const perDistrict = new Map();
for (const c of builds.values()) if (c.result === 0) perDistrict.set(c.recordDistrict, (perDistrict.get(c.recordDistrict) ?? 0) + 1);
const [district, n] = [...perDistrict.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
if (n < min) fail(`only ${n} buildings went up in the best district, wanted ${min}`);
console.log(`builder-bot log: ${n} buildings in district ${district}, ${commands.length} commands all answered, ${end.refused} refused, none retried`);
