// What the dev scripts share to build the way a mayor does, from a plain client with no browser: sign in
// at the dev IdP (no Origin header), join a city at the gateway, publish commands and read their results back
// from the districts' ticks. The tick decoder reads the record layout in docs/design.md, so it needs no wasm build.
export const GATEWAY = process.env.GATEWAY_URL ?? "ws://127.0.0.1:8787/ws";
export const IDP = process.env.IDP_URL ?? "http://127.0.0.1:9400";
export const DISTRICTS = Number(process.env.DISTRICTS ?? 4);

// Result codes of a `command` event, from core/src/record.rs.
export const APPLIED = 0;
export const UNKNOWN = 2;
export const OCCUPIED = 3;
export const EMPTY = 4;
export const BAD_KIND = 5;
export const UNSUPPORTED = 7;
export const IN_USE = 8;
export const BUSY = 9;
export const RESULT_NAMES = {
  0: "applied",
  1: "malformed",
  2: "unknown",
  3: "occupied",
  4: "empty",
  5: "bad-kind",
  6: "bad-speed",
  7: "unsupported",
  8: "in-use",
  9: "busy",
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function token(sub) {
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
    // Read the length first: `at.i += varint(...)` takes at.i before the varint moves it.
    const length = varint(bytes, at);
    at.i += length;
  }
  for (let n = 0; n < 4; n++) varint(bytes, at);
  return buildings;
}

/** A tick record's header, its keyframe's building diff (or null) and its events. */
export function decode(bytes) {
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

export function commandBytes(name, id, command) {
  const display = Buffer.from(name);
  const head = Buffer.alloc(5);
  head[0] = 2;
  head.writeUInt32LE(id, 1);
  return Buffer.concat([head, Buffer.from([display.length]), display, command]);
}
export const build = (lot, kind = 0, rotation = 0) => {
  const b = Buffer.alloc(8);
  b[0] = 3;
  b.writeUInt32LE(lot, 1);
  b.writeUInt16LE(kind, 5);
  b[7] = rotation;
  return b;
};
export const demolish = (lot) => {
  const b = Buffer.alloc(5);
  b[0] = 4;
  b.writeUInt32LE(lot, 1);
  return b;
};
export const placeRoad = (a, z) => {
  const b = Buffer.alloc(9);
  b[0] = 1;
  b.writeUInt32LE(a, 1);
  b.writeUInt32LE(z, 5);
  return b;
};

/**
 * One signed-in client of a city. `keep` retains every decoded record in `records` (for scripts that scan
 * them); without it only `newest` and the `command` results are kept, so a long run does not grow.
 * Failures throw; after the join, a socket error is passed to `onFatal` (default: thrown from the handler).
 */
export class Session {
  constructor(city, who, { name = who, keep = true, onFatal } = {}) {
    this.city = city;
    this.who = who;
    this.name = name;
    this.keep = keep;
    this.onFatal = onFatal ?? ((err) => { throw err; });
    this.records = [];
    this.newest = -1;
    this.acks = new Map();
    this.results = new Map();
    this.waiting = new Map();
    this.nextId = 1;
  }

  async join() {
    const jwt = await token(this.who);
    this.ws = new WebSocket(GATEWAY);
    const hello = new Promise((resolve, reject) => {
      this.onHello = resolve;
      this.ws.onerror = () => {
        const err = new Error(`${this.who}: websocket error`);
        if (this.onHello) reject(err);
        else this.onFatal(err);
      };
    });
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: "join", protocol: 1, features: ["slots", "shards"], city: this.city, token: jwt }));
    this.ws.onmessage = ({ data }) => this.message(JSON.parse(data));
    await hello;
    this.onHello = null;
  }

  message(m) {
    if (m.type === "hello") {
      this.onHello?.(m);
    } else if (m.type === "event") {
      const record = decode(Buffer.from(m.payload, "base64"));
      if (!record) return;
      this.newest = Math.max(this.newest, record.tick);
      if (this.keep) this.records.push(record);
      for (const e of record.events) {
        if (e.type !== "command") continue;
        const result = { ...e, record };
        this.results.set(e.id, result);
        this.waiting.get(e.id)?.(result);
      }
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
    return Promise.race([answer, sleep(10_000).then(() => ({ type: "error", code: "timeout" }))]).finally(() => this.acks.delete(id));
  }

  /** Resolves with the `command` event of command `id`, or null when none shows within `ms`. */
  result(id, ms) {
    const seen = this.results.get(id);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, ms);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(r);
      });
    });
  }

  /** Publishes one command and waits up to `ms` for its result: the `command` event, or null. */
  async command(id, command, ms = 15_000) {
    const answer = await this.publish(commandBytes(this.name, id, command));
    if (answer.type !== "ack") throw new Error(`publishing ${id} was refused: ${answer.code} ${answer.message ?? ""}`);
    return this.result(id, ms);
  }

  /** Publishes the commands and waits for each id's `command` event; throws when one never shows. */
  async send(commands, maxTicks = 16) {
    const sentAt = this.newest;
    for (const [id, command] of commands) {
      const answer = await this.publish(commandBytes(this.name, id, command));
      if (answer.type !== "ack") throw new Error(`publishing ${id} was refused: ${answer.code} ${answer.message ?? ""}`);
    }
    const seen = new Map();
    await Promise.all(commands.map(async ([id]) => {
      const r = await this.result(id, 15_000);
      if (r) seen.set(id, r);
    }));
    if (seen.size < commands.length) {
      const missing = commands.map(([id]) => id).filter((id) => !seen.has(id));
      throw new Error(`no command event for ${missing.length} of ${commands.length} commands, first id ${missing[0]}`);
    }
    for (const s of seen.values()) {
      if (s.record.tick - sentAt > maxTicks) throw new Error(`command ${s.id} took ${s.record.tick - sentAt} ticks (sent after tick ${sentAt})`);
    }
    return seen;
  }

  /**
   * Waits until the sim answers a command. It opens its command subscription in the background, so commands sent
   * before it is up are lost. A build past the last lot is refused and changes nothing, which makes it a harmless
   * probe: send one until a result comes back. Ids are `base`, `base + 1`, ...
   */
  async ready(base = 500, ms = 120_000) {
    const deadline = Date.now() + ms;
    for (let n = 0; ; n++) {
      await this.command(base + n, build(4_000_000_000), 5000);
      for (let id = base; id <= base + n; id++) if (this.results.has(id)) return;
      if (Date.now() > deadline) throw new Error("the sim never answered a command");
    }
  }

  close() {
    this.ws.onclose = null;
    this.ws.close();
  }
}

// The stack is up before every shard serves, so a refused join is tried again.
export async function joined(city, who, options) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const s = new Session(city, who, options);
    try {
      await s.join();
      return s;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(2000);
    }
  }
}
