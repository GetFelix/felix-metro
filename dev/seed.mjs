// Seeds a Felix for the sim, the gateway and the web app: bootstrap a tenant
// that trusts idp.mjs, create the city registry and, for each city, an event
// stream with a shard for every district and a command stream. Gives the sim
// its rights, gives each city a watch and a build role, and writes the
// broker's and the sim's tokens to the state directory. Safe to run again:
// existing objects are kept.
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";

const env = (name, fallback) => process.env[name] || fallback;

const CONTROL_PLANE = env("METRO_FELIX_CONTROL_PLANE", "http://controlplane:8443");
const BOOTSTRAP = env("METRO_FELIX_BOOTSTRAP", "http://controlplane:9095");
const BOOTSTRAP_TOKEN = env("METRO_FELIX_BOOTSTRAP_TOKEN", "dev-bootstrap");
const IDP = env("METRO_IDP", "http://idp:9400");
const STATE = env("METRO_STATE_DIR", "/state");
const TENANT = env("METRO_TENANT", "metro");
const NAMESPACE = env("METRO_NAMESPACE", "default");
// City names with their districts: harbor:4 is a city of 4 districts.
const CITIES = env("METRO_CITIES", "harbor:4,pinecrest:4").split(/[\s,]+/).filter(Boolean);
// Who may watch every city, and who may also build in it.
const WATCHERS = env("METRO_WATCHERS", "viewer").split(",").filter(Boolean);
const BUILDERS = env("METRO_BUILDERS", "mayor").split(",").filter(Boolean);
const AUDIENCE = "felix-metro";
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
// Per stream, so a dev machine's disk is safe at any speed.
const MAX_BYTES = 1024 ** 3;

async function request(method, url, { token, headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 409) {
    console.log(`  ${method} ${url}: already exists`);
    return null;
  }
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const { issuer } = await request("GET", `${IDP}/.well-known/openid-configuration`);
// Felix keys RBAC on sha256(issuer|subject), not on the subject itself.
const principal = (subject) => createHash("sha256").update(`${issuer}|${subject}`).digest("hex");

async function exchange(subject, body) {
  const { id_token } = await request("GET", `${IDP}/token?sub=${subject}&aud=${AUDIENCE}`);
  const url = `${CONTROL_PLANE}/v1/tenants/${TENANT}/token/exchange`;
  return (await request("POST", url, { token: id_token, body })).felix_token;
}

const object = (kind, name) => `${kind}:${TENANT}/${NAMESPACE}/${name}`;

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
console.log(`namespace ${NAMESPACE}`);
await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces`, {
  token: admin,
  body: { namespace: NAMESPACE, display_name: NAMESPACE },
});

const grant = (subject, name, action) =>
  request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/rbac/policies`, {
    token: admin,
    body: { subject, object: object("stream", name), action },
  });

const createStream = (stream, shards, retention, maxBytes) => {
  console.log(`stream ${stream}, ${shards} shard${shards === 1 ? "" : "s"}`);
  return request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces/${NAMESPACE}/streams`, {
    token: admin,
    body: {
      stream,
      kind: "Stream",
      shards,
      replication_factor: 1,
      retention: { max_age_seconds: retention, max_size_bytes: maxBytes },
      consistency: "Leader",
      delivery: "AtLeastOnce",
      durable: true,
    },
  });
};

// Every city that exists, kept for good.
await createStream("metro.cities", 1, null, null);
await grant("role:sim", "metro.cities", "stream.publish");
await grant("role:sim", "metro.cities", "stream.subscribe");

for (const city of CITIES) {
  const [name, districts] = city.split(":");
  const events = `metro.events.${name}`;
  const commands = `metro.commands.${name}`;
  await createStream(events, Number(districts), RETENTION_SECONDS, MAX_BYTES);
  await createStream(commands, 1, RETENTION_SECONDS, MAX_BYTES);
  // A commit needs publish, and reading the log or a state key needs subscribe.
  await grant("role:sim", events, "stream.publish");
  await grant("role:sim", events, "stream.subscribe");
  await grant("role:sim", commands, "stream.subscribe");
  // Exactly these actions: token exchange narrows by every action on every
  // resource a role holds (felix#968).
  const watch = `role:metro-${name}-watch`;
  const build = `role:metro-${name}-build`;
  await grant(watch, events, "stream.subscribe");
  await grant(build, events, "stream.subscribe");
  await grant(build, commands, "stream.publish");
  for (const [role, names] of [
    [watch, WATCHERS],
    [build, BUILDERS],
  ]) {
    console.log(`${role} for ${names.join(", ") || "nobody"}`);
    for (const user of names) {
      await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/rbac/groupings`, {
        token: admin,
        body: { user: principal(user), role },
      });
    }
  }
}

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
