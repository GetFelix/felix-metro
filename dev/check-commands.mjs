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
// Reads ticks with a small decoder of the record layout in docs/design.md, so it
// needs no wasm build. It reads the events of keyframe records too, and the
// check fails when a command's result never shows up. Between the build and the
// demolish it waits for the district's next keyframe, which must list the lot.
const GATEWAY = process.env.GATEWAY_URL ?? "ws://127.0.0.1:8787/ws";
const IDP = process.env.IDP_URL ?? "http://127.0.0.1:9400";
const DISTRICTS = Number(process.env.DISTRICTS ?? 4);
const city = process.argv[2] ?? process.env.CHECK_CITY ?? "pinecrest";

// Result codes of a `command` event, from core/src/record.rs.
const APPLIED = 0;
const OCCUPIED = 3;
const UNKNOWN = 2;
const UNSUPPORTED = 7;
// Ticks a command may take from publish to its record; one tick is the promise, the rest is the network.
const MAX_TICKS = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
  console.error(`${city}: ${message}`);
  process.exit(1);
};

async function token(sub) {
  const { id_token } = await (await fetch(`${IDP}/token?sub=${sub}&aud=felix-metro`)).json();
  return id_token;
}

function varint(bytes, at) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const b = bytes[at.i++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return value;
  }
}

function delta(bytes, at, prev) {
  const z = varint(bytes, at);
  return prev + (z % 2 === 1 ? -(z + 1) / 2 : z / 2);
}

/** Walks the keyframe at `at.i`, returning the lots it lists as differing from the generated city. */
function keyframe(bytes, at) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buildings = new Map();
  let lot = 0;
  for (let n = varint(bytes, at); n > 0; n--) {
    lot = delta(bytes, at, lot);
    buildings.set(lot, view.getUint16(at.i, true));
    at.i += 3;
  }
  for (let n = varint(bytes, at); n > 0; n--) {
    delta(bytes, at, 0);
    at.i += 1;
  }
  for (let n = varint(bytes, at); n > 0; n--) {
    delta(bytes, at, 0);
    at.i += 1; // the resident's frame tag
    at.i += varint(bytes, at);
  }
  for (let n = 0; n < 4; n++) varint(bytes, at);
  return buildings;
}

/** A tick record's header, its keyframe's building diff (or null) and its events. */
function decode(bytes) {
  if (bytes[0] !== 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { district: view.getUint16(5, true), tick: view.getUint32(7, true), keyframe: null, events: [] };
  const count = view.getUint16(29, true);
  const at = { i: 31 };
  if ((bytes[12] & 1) !== 0) out.keyframe = keyframe(bytes, at);
  for (let n = 0; n < count; n++) {
    const tag = bytes[at.i++];
    const length = varint(bytes, at);
    const body = new DataView(bytes.buffer, bytes.byteOffset + at.i, length);
    at.i += length;
    if (tag === 7 || tag === 8) {
      out.events.push({ type: tag === 7 ? "built" : "demolished", lot: body.getUint32(0, true), kind: body.getUint16(4, true) });
    } else if (tag === 10) {
      const nameLength = body.getUint8(8);
      const id = body.getUint32(9 + nameLength, true);
      out.events.push({ type: "command", principal: body.getBigUint64(0, true), id, result: body.getUint8(13 + nameLength) });
    } else if (tag === 9) {
      out.events.push({ type: "road" });
    }
  }
  return out;
}

function commandBytes(id, command) {
  const name = Buffer.from("check-commands");
  const head = Buffer.alloc(5);
  head[0] = 2;
  head.writeUInt32LE(id, 1);
  return Buffer.concat([head, Buffer.from([name.length]), name, command]);
}
const build = (lot, kind = 0, rotation = 0) => {
  const b = Buffer.alloc(8);
  b[0] = 3;
  b.writeUInt32LE(lot, 1);
  b.writeUInt16LE(kind, 5);
  b[7] = rotation;
  return b;
};
const demolish = (lot) => {
  const b = Buffer.alloc(5);
  b[0] = 4;
  b.writeUInt32LE(lot, 1);
  return b;
};
const placeRoad = (a, z) => {
  const b = Buffer.alloc(9);
  b[0] = 1;
  b.writeUInt32LE(a, 1);
  b.writeUInt32LE(z, 5);
  return b;
};

class Session {
  constructor(who) {
    this.who = who;
    this.records = [];
    this.newest = -1;
    this.acks = new Map();
    this.nextId = 1;
  }

  async join() {
    const jwt = await token(this.who);
    this.ws = new WebSocket(GATEWAY);
    this.ws.onerror = () => fail(`${this.who}: websocket error`);
    const hello = new Promise((resolve) => (this.onHello = resolve));
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: "join", protocol: 1, features: ["slots", "shards"], city, token: jwt }));
    this.ws.onmessage = ({ data }) => this.message(JSON.parse(data));
    await hello;
  }

  message(m) {
    if (m.type === "hello") {
      this.onHello?.(m);
    } else if (m.type === "event") {
      const record = decode(Buffer.from(m.payload, "base64"));
      if (!record) return;
      this.newest = Math.max(this.newest, record.tick);
      this.records.push(record);
    } else if (m.type === "ack" || m.type === "error") {
      this.acks.get(m.id)?.(m);
    }
  }

  follow() {
    for (let shard = 0; shard < DISTRICTS; shard++) {
      this.ws.send(JSON.stringify({ type: "subscribe", stream: "events", from: "live", shard, slot: `d${shard}` }));
    }
  }

  publish(payload) {
    const id = this.nextId++;
    const answer = new Promise((resolve) => this.acks.set(id, resolve));
    this.ws.send(JSON.stringify({ type: "publish", stream: "commands", payload: payload.toString("base64"), ack: true, id }));
    return Promise.race([answer, sleep(10_000).then(() => ({ type: "error", code: "timeout" }))]);
  }

  /** Publishes the commands and waits for each id's `command` event; fails when one never shows. */
  async send(commands) {
    const before = this.records.length;
    const sentAt = this.newest;
    for (const [id, command] of commands) {
      const answer = await this.publish(commandBytes(id, command));
      if (answer.type !== "ack") fail(`publishing ${id} was refused: ${answer.code} ${answer.message ?? ""}`);
    }
    const ids = new Set(commands.map(([id]) => id));
    const deadline = Date.now() + 15_000;
    const seen = new Map();
    while (seen.size < ids.size && Date.now() < deadline) {
      for (const record of this.records.slice(before)) {
        for (const e of record.events) {
          if (e.type === "command" && ids.has(e.id) && !seen.has(e.id)) seen.set(e.id, { ...e, record });
        }
      }
      await sleep(100);
    }
    if (seen.size < ids.size) {
      const missing = [...ids].filter((id) => !seen.has(id));
      fail(`no command event for ${missing.length} of ${ids.size} commands, first id ${missing[0]}`);
    }
    for (const s of seen.values()) {
      if (s.record.tick - sentAt > MAX_TICKS) fail(`command ${s.id} took ${s.record.tick - sentAt} ticks (sent after tick ${sentAt})`);
    }
    return seen;
  }

  close() {
    this.ws.onclose = null;
    this.ws.close();
  }
}

// The stack is up before every shard serves, so a refused join is tried again.
async function joined(who) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const s = new Session(who);
    try {
      await s.join();
      return s;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(2000);
    }
  }
}

const viewer = await joined("viewer");
const refused = await viewer.publish(commandBytes(1, build(0)));
if (refused.type !== "error") fail("a viewer's command was taken");
viewer.close();

const mayor = await joined("mayor");
mayor.follow();
while (mayor.newest < 0) await sleep(200);

// The sim opens its command subscription in the background, so commands sent before it is up are not seen.
// A command past the last lot is refused and changes nothing, which makes it a harmless probe: send one
// until its result comes back.
{
  const deadline = Date.now() + 120_000;
  for (let n = 0; ; n++) {
    const answer = await mayor.publish(commandBytes(500 + n, build(4_000_000_000)));
    if (answer.type !== "ack") fail(`the readiness probe was refused: ${answer.code}`);
    const until = Date.now() + 5000;
    while (Date.now() < until && !mayor.records.some((r) => r.events.some((e) => e.type === "command" && e.id === 500 + n))) await sleep(100);
    if (mayor.records.some((r) => r.events.some((e) => e.type === "command" && e.id >= 500 && e.id <= 500 + n))) break;
    if (Date.now() > deadline) fail("the sim never answered a command");
  }
}

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
