// Checks that ticks reach a browser-style client through the gateway: signs
// in as the dev IdP's `viewer`, joins each city, follows every district's
// shard live and waits for ticks on all of them.
//
//   node dev/check-ticks.mjs [city ...]   (default: harbor pinecrest)
const GATEWAY = process.env.GATEWAY_URL ?? "ws://127.0.0.1:8787/ws";
const IDP = process.env.IDP_URL ?? "http://127.0.0.1:9400";
const DISTRICTS = Number(process.env.DISTRICTS ?? 4);
const TICKS = Number(process.env.TICKS ?? 8);
const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 20) * 1000;

const cities = process.argv.slice(2);
if (cities.length === 0) cities.push("harbor", "pinecrest");

const { id_token: token } = await (await fetch(`${IDP}/token?sub=viewer&aud=felix-metro`)).json();

function check(city) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY);
    const seen = Array.from({ length: DISTRICTS }, () => ({ count: 0, last: -1 }));
    const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS / 1000}s; ticks per district: ${seen.map((d) => d.count)}`), TIMEOUT_MS);
    const fail = (message) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`${city}: ${message}`));
    };
    ws.onerror = () => fail("websocket error");
    ws.onclose = () => fail("websocket closed early");
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", protocol: 1, features: ["slots", "shards"], city, token }));
    };
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "hello") {
        for (const feature of ["slots", "shards"]) {
          if (!message.features.includes(feature)) return fail(`gateway lacks the ${feature} feature`);
        }
        for (let shard = 0; shard < DISTRICTS; shard++) {
          ws.send(JSON.stringify({ type: "subscribe", stream: "events", from: "live", shard, slot: `d${shard}` }));
        }
      } else if (message.type === "event") {
        const district = Number(message.slot.slice(1));
        const entry = seen[district];
        if (message.offset <= entry.last) return fail(`district ${district}: offset ${message.offset} after ${entry.last}`);
        if (!message.payload) return fail(`district ${district}: empty record at offset ${message.offset}`);
        entry.last = message.offset;
        entry.count++;
        if (seen.every((d) => d.count >= TICKS)) {
          clearTimeout(timer);
          ws.onclose = null;
          ws.close();
          console.log(`${city}: ticks received through the gateway, per district: ${seen.map((d) => d.count).join(" ")} (last offsets ${seen.map((d) => d.last).join(" ")})`);
          resolve();
        }
      } else if (message.type === "error") {
        fail(`gateway error ${message.code}: ${message.message ?? ""}`);
      }
    };
  });
}

// The stack is up before every shard serves and before the sim's first commit,
// so a refused join or subscribe is tried again until the deadline.
const deadline = Date.now() + Number(process.env.READY_S ?? 90) * 1000;
let failed = false;
for (const city of cities) {
  for (;;) {
    try {
      await check(city);
      break;
    } catch (err) {
      console.error(err.message);
      if (Date.now() > deadline) {
        failed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
process.exit(failed ? 1 : 0);
