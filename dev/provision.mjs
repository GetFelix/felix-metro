// Makes the streams of a fork. A Felix client cannot create a stream, so the sim asks this service when a
// builder forks a city (SIM_FORK_PROVISION_URL), and it creates the fork's event and command streams and
// gives them the access of the city the fork began from.
//
//   POST /forks  {"city": "harbor~bridge", "parent": "harbor", "shards": 4}
//
// The call can be repeated: what exists is kept. It answers 200 once the streams exist and their access is
// in place. There is no authentication; it listens only on the stack's own network and is not published.
import http from "node:http";
import { createCityStreams, exchange, grant as grantOn, roles } from "./lib/admin.mjs";

const PORT = Number(process.env.METRO_PROVISION_PORT ?? 9500);
// A fork's lineage: parts of a-z, 0-9 and -, joined by ~, within the 64 bytes a stream name here may use.
const LINEAGE = /^[a-z0-9-]{1,32}(~[a-z0-9-]{1,32})+$/;
const MAX_SHARDS = 64;

/** The name a city's streams carry. The gateway keeps scope values to letters, digits, - and _. */
export const felixName = (city) => city.replaceAll("~", "_");

export async function makeFork({ city, parent, shards }) {
  if (typeof city !== "string" || city.length > 64 || !LINEAGE.test(city)) throw new Error(`${city}: not a fork's name`);
  if (city.slice(0, city.lastIndexOf("~")) !== parent) throw new Error(`${city} is not a fork of ${parent}`);
  if (!Number.isInteger(shards) || shards < 1 || shards > MAX_SHARDS) throw new Error(`${shards}: not a district count`);
  const admin = await exchange("metro-admin", { audience: "felix-controlplane" });
  const grant = (subject, name, action) => grantOn(admin, subject, name, action);
  const { events, commands } = await createCityStreams(admin, felixName(city), shards);
  // Everyone who can watch or build in the city it began from can in the fork.
  const { watch, build } = roles(city.split("~")[0]);
  await grant(watch, events, "stream.subscribe");
  await grant(build, events, "stream.subscribe");
  await grant(build, commands, "stream.publish");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 4096) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const reply = (status, text) => res.writeHead(status, { "content-type": "text/plain" }).end(`${text}\n`);
  try {
    if (req.method === "GET" && req.url === "/ready") return reply(200, "ready");
    if (req.method !== "POST" || req.url !== "/forks") return reply(404, "POST /forks");
    const fork = JSON.parse(await readBody(req));
    await makeFork(fork);
    console.log(`fork ${fork.city} ready`);
    reply(200, "ready");
  } catch (err) {
    console.error(`fork failed: ${err.message}`);
    reply(err instanceof SyntaxError || /not a /.test(err.message) ? 400 : 500, err.message);
  }
});
server.listen(PORT, () => console.log(`provisioner on ${PORT}`));
