// Seeds the sim's test broker: bootstrap a tenant that trusts idp.mjs, create
// each city's event stream with a shard for every district, let the sim
// publish to and read it, and write the broker's and the sim's tokens to the
// state directory.
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
// City names with their districts: harbor 4 is a city of 4 districts.
const CITIES = env("METRO_CITIES", "harbor:4").split(/[\s,]+/).filter(Boolean);
const AUDIENCE = "felix-metro";
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

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

for (const city of CITIES) {
  const [name, districts] = city.split(":");
  const stream = `metro.events.${name}`;
  console.log(`stream ${stream}, ${districts} shards`);
  await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces/${NAMESPACE}/streams`, {
    token: admin,
    body: {
      stream,
      kind: "Stream",
      shards: Number(districts),
      replication_factor: 1,
      retention: { max_age_seconds: RETENTION_SECONDS, max_size_bytes: null },
      consistency: "Leader",
      delivery: "AtLeastOnce",
      durable: true,
    },
  });
  // A commit needs publish, and reading the log or a state key needs subscribe.
  await grant("role:sim", stream, "stream.publish");
  await grant("role:sim", stream, "stream.subscribe");
}

// The broker runs as uid 65532 and writes its certificate here too.
await mkdir(STATE, { recursive: true });
await chmod(STATE, 0o777).catch(() => {});
const broker = await exchange("metro-broker", { audience: "felix-controlplane" });
await writeFile(`${STATE}/node.token`, broker, { mode: 0o644 });
const sim = await exchange("metro-sim", { requested: ["stream.publish", "stream.subscribe"] });
await writeFile(`${STATE}/sim.token`, sim, { mode: 0o644 });
console.log(`wrote node.token and sim.token to ${STATE}`);

// up.sh waits for this before it calls the stack ready.
await writeFile(`${STATE}/seeded`, "");
