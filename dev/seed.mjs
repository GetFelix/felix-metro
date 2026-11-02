// Seeds a Felix for the sim, the gateway and the web app: bootstrap a tenant
// that trusts idp.mjs, create the city registry and, for each city, an event
// stream with a shard for every district and a command stream. Gives the sim
// its rights, gives each city a watch and a build role, and writes the
// broker's and the sim's tokens to the state directory. Also creates `lobby`, a
// city with no sim that a page joins only to read the list of cities. Safe to run
// again: existing objects are kept. Forks made later get their streams from
// dev/provision.mjs.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import {
  AUDIENCE,
  CONTROL_PLANE,
  IDP,
  NAMESPACE,
  TENANT,
  createCityStreams,
  createStream,
  exchange,
  grant as grantOn,
  issuer,
  object,
  principal,
  request,
  roles,
} from "./lib/admin.mjs";

const env = (name, fallback) => process.env[name] || fallback;

const STATE = env("METRO_STATE_DIR", "/state");
const BOOTSTRAP = env("METRO_FELIX_BOOTSTRAP", "http://controlplane:9095");
const BOOTSTRAP_TOKEN = env("METRO_FELIX_BOOTSTRAP_TOKEN", "dev-bootstrap");
// City names with their districts: harbor:4 is a city of 4 districts.
const CITIES = env("METRO_CITIES", "harbor:4,pinecrest:4").split(/[\s,]+/).filter(Boolean);
// Who may watch every city, and who may also build in it.
const WATCHERS = env("METRO_WATCHERS", "viewer").split(",").filter(Boolean);
const BUILDERS = env("METRO_BUILDERS", "mayor").split(",").filter(Boolean);

console.log(`bootstrap tenant ${TENANT}`);
await request("POST", `${BOOTSTRAP}/internal/bootstrap/tenants/${TENANT}/initialize`, {
  headers: { "x-felix-bootstrap-token": BOOTSTRAP_TOKEN },
  body: {
    display_name: "Felix Metro",
    idp_issuers: [
      {
        issuer,
        audiences: [AUDIENCE],
        jwks_url: `${IDP}/jwks.json`,
        claim_mappings: { subject_claim: "sub" },
      },
    ],
    initial_admin_principals: [principal("metro-admin")],
    policies: [
      { subject: "role:admin", object: object("stream", "*"), action: "stream.manage" },
      { subject: "role:broker", object: "cluster:*", action: "node.view" },
      { subject: "role:broker", object: "cluster:*", action: "node.manage" },
    ],
    groupings: [
      { user: principal("metro-admin"), role: "role:admin" },
      { user: principal("metro-broker"), role: "role:broker" },
      { user: principal("metro-sim"), role: "role:sim" },
    ],
  },
});

const admin = await exchange("metro-admin", { audience: "felix-controlplane" });
const grant = (subject, name, action) => grantOn(admin, subject, name, action);
console.log(`namespace ${NAMESPACE}`);
await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces`, {
  token: admin,
  body: { namespace: NAMESPACE, display_name: NAMESPACE },
});

// Every city that exists, kept for good.
await createStream(admin, "metro.cities", 1, null, null);
// The sim publishes and subscribes on every stream of the namespace. A token lists the streams it was minted
// for, so a stream made after the sim started (a fork's) is covered only by a wildcard.
await grant("role:sim", "*", "stream.publish");
await grant("role:sim", "*", "stream.subscribe");

// The city list is reached through a city, because the gateway opens streams only after a join. A page whose own
// city is refused joins this one just to read the list (LIST_CITY in web/src/live.ts). It is never simulated or
// listed, and nobody may build in it. Everyone who signs in may join it.
const LOBBY = "lobby";

async function seedCity(name, districts, { lobby = false } = {}) {
  const { events, commands } = await createCityStreams(admin, name, districts);
  // Exactly these actions: token exchange narrows by every action on every
  // resource a role holds (felix#968).
  const { watch, build } = roles(name);
  await grant(watch, events, "stream.subscribe");
  // Every role may follow the list of cities, which the gateway hands to every scope.
  await grant(watch, "metro.cities", "stream.subscribe");
  const members = [[watch, lobby ? [...new Set([...WATCHERS, ...BUILDERS])] : WATCHERS]];
  // Nobody builds in the lobby, but everyone who signs in may join it.
  if (!lobby) {
    await grant(build, events, "stream.subscribe");
    await grant(build, "metro.cities", "stream.subscribe");
    await grant(build, commands, "stream.publish");
    members.push([build, BUILDERS]);
  }
  for (const [role, names] of members) {
    console.log(`${role} for ${names.join(", ") || "nobody"}`);
    for (const user of names) {
      await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/rbac/groupings`, {
        token: admin,
        body: { user: principal(user), role },
      });
    }
  }
}

for (const city of CITIES) {
  const [name, districts] = city.split(":");
  await seedCity(name, Number(districts));
}
await seedCity(LOBBY, 1, { lobby: true });

// The broker runs as uid 65532 and writes its certificate here too.
await mkdir(STATE, { recursive: true });
await chmod(STATE, 0o777).catch(() => {});
const broker = await exchange("metro-broker", { audience: "felix-controlplane" });
await writeFile(`${STATE}/node.token`, broker, { mode: 0o644 });
const sim = await exchange("metro-sim", { requested: ["stream.publish", "stream.subscribe"] });
await writeFile(`${STATE}/sim.token`, sim, { mode: 0o644 });
console.log(`wrote node.token and sim.token to ${STATE}`);

// dev/up.sh and sim/ci/up.sh wait for this before they call the stack ready.
await writeFile(`${STATE}/seeded`, "");
