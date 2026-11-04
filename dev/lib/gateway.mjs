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
export const NO_FUNDS = 10;
export const NOT_STRAIGHT = 22;
export const TOO_LONG = 23;
export const ROAD_EXISTS = 24;
export const ROAD_BLOCKED = 25;
export const NOT_BUILT = 26;
export const BAD_FORK_NAME = 16;
export const FORK_TOO_DEEP = 17;
export const FORK_TICK = 18;
export const FORK_EXISTS = 19;
export const FORK_TRIMMED = 20;
export const FORK_LIMIT = 21;
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
  10: "no-funds",
  11: "cooldown",
  12: "unchanged",
  16: "bad-fork-name",
  17: "fork-too-deep",
  18: "fork-tick",
  19: "fork-exists",
  20: "fork-trimmed",
  21: "fork-limit",
  22: "not-straight",
  23: "too-long",
  24: "road-exists",
  25: "road-blocked",
  26: "not-built",
};

/** The name a city has at the gateway and in its stream names: a fork's `~` becomes `_`. */
export const felixName = (city) => city.replaceAll("~", "_");

/** What a `roadwork` event's change says: a builder added the road, or took it away. */
export const ROAD_ADDED = 2;
export const ROAD_REMOVED = 3;

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

/**
 * Walks the keyframe at `at.i`, returning the lots it lists as differing from the generated city, and in `roads` the
 * roads builders added as `[segment, change, a, b]`.
 */
function keyframe(bytes, at) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buildings = new Map();
  let lot = 0;
  for (let n = varint(bytes, at); n > 0; n--) {
    lot = delta(bytes, at, lot);
    buildings.set(lot, view.getUint16(at.i, true));
    at.i += 3;
  }
  const roads = [];
  let segment = 0;
  for (let n = varint(bytes, at); n > 0; n--) {
    segment = delta(bytes, at, segment);
    const change = bytes[at.i++];
    roads.push([segment, change, varint(bytes, at), varint(bytes, at)]);
  }
  for (let n = varint(bytes, at); n > 0; n--) {
    delta(bytes, at, 0);
    // The frame head is the body length above two bits of tag.
    const length = Math.floor(varint(bytes, at) / 4);
    at.i += length;
  }
  for (let n = 0; n < 4; n++) varint(bytes, at);
  return { buildings, roads };
}

/** A registry record (`created` or `forked`), or null for another kind of record. */
export function decodeRegistry(bytes) {
  if (bytes[0] !== 3) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  const str = () => {
    const size = bytes[i++];
    const text = Buffer.from(bytes.subarray(i, i + size)).toString();
    i += size;
    return text;
  };
  if (bytes[1] === 1) return { type: "created", name: str(), seed: str() };
  if (bytes[1] !== 2) return null;
  const name = str();
  const parent = str();
  const tick = view.getUint32(i, true);
  return { type: "forked", name, parent, tick, principal: view.getBigUint64(i + 12, true) };
}

/** A tick record's header, its keyframe's building diff (or null) and its events. */
export function decode(bytes) {
  if (bytes[0] !== 4) return null;
  const at = { i: 1 };
  varint(bytes, at); // epoch
  const district = varint(bytes, at);
  const tick = varint(bytes, at);
  const flags = bytes[at.i + 1];
  at.i += 2; // speed, flags
  varint(bytes, at); // keyframe offset
  at.i += 8; // wall clock
  const count = varint(bytes, at);
  const out = { district, tick, keyframe: null, roads: null, events: [] };
  if ((flags & 1) !== 0) ({ buildings: out.keyframe, roads: out.roads } = keyframe(bytes, at));
  for (let n = 0; n < count; n++) {
    // The frame head is the body length above four bits of tag.
    const head = varint(bytes, at);
    const tag = head % 16;
    const length = Math.floor(head / 16);
    const start = at.i;
    const body = new DataView(bytes.buffer, bytes.byteOffset + at.i, length);
    at.i += length;
    if (tag === 1 || tag === 2 || tag === 3 || tag === 13) {
      // A resident's trip, change of route and arrival (alone, or with its activity as tag 13) all start with the resident.
      const type = tag === 1 ? "trip" : tag === 2 ? "replan" : "arrived";
      out.events.push({ type, resident: varint(bytes, { i: start }) });
    } else if (tag === 7 || tag === 8) {
      out.events.push({ type: tag === 7 ? "built" : "demolished", lot: body.getUint32(0, true), kind: body.getUint16(4, true) });
    } else if (tag === 10) {
      const nameLength = body.getUint8(8);
      const id = body.getUint32(9 + nameLength, true);
      out.events.push({ type: "command", principal: body.getBigUint64(0, true), id, result: body.getUint8(13 + nameLength) });
    } else if (tag === 9) {
      out.events.push({ type: "road" });
    } else if (tag === 15) {
      // An extended event names its kind first, as a varint.
      const ext = { i: 0 };
      const raw = new Uint8Array(body.buffer, body.byteOffset, length);
      const kind = varint(raw, ext);
      if (kind === 3) {
        // A builder's hash and display name, then a count and, per lot, a lot delta and a delta of its tick from the
        // record's.
        const principal = body.getBigUint64(1, true);
        const nameLength = body.getUint8(9);
        const name = Buffer.from(bytes.subarray(start + 10, start + 10 + nameLength)).toString("utf8");
        const inner = { i: start + 10 + nameLength };
        const lots = [];
        let lot = 0;
        for (let n = varint(bytes, inner); n > 0; n--) {
          lot = delta(bytes, inner, lot);
          lots.push([lot, delta(bytes, inner, tick)]);
        }
        out.events.push({ type: "author", principal, name, lots });
      } else if (kind === 6) {
        // A builder's road added or taken away.
        const segment = varint(raw, ext);
        const change = raw[ext.i++];
        out.events.push({ type: "roadwork", segment, change, a: varint(raw, ext), b: varint(raw, ext) });
      } else if (kind === 7) {
        // A fork: its tick, name and the principal who made it.
        const tick = varint(raw, ext);
        const size = raw[ext.i++];
        const name = Buffer.from(raw.subarray(ext.i, ext.i + size)).toString();
        ext.i += size;
        const principal = new DataView(raw.buffer, raw.byteOffset + ext.i, 8).getBigUint64(0, true);
        out.events.push({ type: "forked", tick, name, principal });
      }
    }
  }
  return out;
}

/** A day's timeline markers (kind 5): the day and the changes builders made in it, in order. Each is framed by its length. */
export function decodeMarkers(bytes) {
  if (bytes[0] !== 5) return null;
  const at = { i: 1 };
  const day = varint(bytes, at);
  let tick = day * 5760;
  const markers = [];
  for (let n = varint(bytes, at); n > 0; n--) {
    const length = varint(bytes, at);
    const end = at.i + length;
    tick = delta(bytes, at, tick);
    const type = bytes[at.i++];
    if (type >= 1 && type <= 3) {
      const subject = varint(bytes, at);
      const what = varint(bytes, at);
      const size = bytes[at.i++];
      const by = Buffer.from(bytes.subarray(at.i, at.i + size)).toString("utf8");
      markers.push({ tick, type, subject, what, by });
    }
    at.i = end;
  }
  return { day, markers };
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
/** A `policy` command: `kind` 0 shop hours, 1 avenue limit, 2 street limit. */
export const policy = (kind, value) => Buffer.from([7, kind, value]);
/** A `fork` command: the last tick to keep, and the fork's name. */
export const fork = (tick, name) => {
  const text = Buffer.from(name);
  const b = Buffer.alloc(6);
  b[0] = 6;
  b.writeUInt32LE(tick, 1);
  b[5] = text.length;
  return Buffer.concat([b, text]);
};
export const placeRoad = (a, z) => {
  const b = Buffer.alloc(9);
  b[0] = 1;
  b.writeUInt32LE(a, 1);
  b.writeUInt32LE(z, 5);
  return b;
};
export const removeRoad = (segment) => {
  const b = Buffer.alloc(5);
  b[0] = 8;
  b.writeUInt32LE(segment, 1);
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
    /** The newest record of each district: its offset and tick. */
    this.last = new Map();
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
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: "join", protocol: 1, features: ["slots", "shards", "state"], city: this.city, token: jwt }));
    this.ws.onmessage = ({ data }) => this.message(JSON.parse(data));
    await hello;
    this.onHello = null;
  }

  message(m) {
    if (m.type === "hello") {
      this.onHello?.(m);
    } else if (m.type === "event" && m.slot === "cities") {
      const record = decodeRegistry(Buffer.from(m.payload, "base64"));
      if (record) this.onCity?.(record);
    } else if (m.type === "event") {
      const record = decode(Buffer.from(m.payload, "base64"));
      if (!record) return;
      this.newest = Math.max(this.newest, record.tick);
      this.last.set(record.district, { offset: m.offset, tick: record.tick });
      if (this.keep) this.records.push(record);
      for (const e of record.events) {
        if (e.type !== "command") continue;
        const result = { ...e, record };
        this.results.set(e.id, result);
        this.waiting.get(e.id)?.(result);
      }
    } else if (m.type === "ack" || m.type === "state_value" || m.type === "error") {
      this.acks.get(m.id)?.(m);
    }
  }

  /** Follows every district from the tip, or from `offsets[district]`, a log offset of that district's shard. */
  follow(offsets) {
    for (let shard = 0; shard < DISTRICTS; shard++) {
      const from = offsets?.[shard] ?? "live";
      this.ws.send(JSON.stringify({ type: "subscribe", stream: "events", from, shard, slot: `d${shard}` }));
    }
  }

  /** Follows the registry of cities from its first record; `onRecord` is told each decoded one. */
  followCities(onRecord) {
    this.onCity = onRecord;
    this.ws.send(JSON.stringify({ type: "subscribe", stream: "cities", from: 0, shard: 0, slot: "cities" }));
  }

  publish(payload) {
    const id = this.nextId++;
    const answer = new Promise((resolve) => this.acks.set(id, resolve));
    this.ws.send(JSON.stringify({ type: "publish", stream: "commands", payload: payload.toString("base64"), ack: true, id }));
    return Promise.race([answer, sleep(10_000).then(() => ({ type: "error", code: "timeout" }))]).finally(() => this.acks.delete(id));
  }

  /** One key of the events stream's state in `shard`, as bytes, or null when nothing is set. */
  async stateGet(key, shard = 0) {
    const id = this.nextId++;
    const answer = new Promise((resolve) => this.acks.set(id, resolve));
    this.ws.send(JSON.stringify({ type: "state_get", stream: "events", key, shard, id }));
    const m = await Promise.race([answer, sleep(10_000).then(() => ({ type: "error", code: "timeout" }))]).finally(() => this.acks.delete(id));
    if (m.type === "error") throw new Error(`reading ${key} failed: ${m.code} ${m.message ?? ""}`);
    return m.payload === null ? null : Buffer.from(m.payload, "base64");
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
    // A socket that is being closed on purpose can still report an error; after the join that would be fatal.
    this.ws.onclose = null;
    this.ws.onerror = null;
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
