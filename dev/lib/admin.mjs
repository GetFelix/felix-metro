// What dev/seed.mjs and dev/provision.mjs share to set Felix up: talk to the control plane as the dev
// stack's admin and create a city's streams with the access its roles need.
import { createHash } from "node:crypto";

const env = (name, fallback) => process.env[name] || fallback;

export const CONTROL_PLANE = env("METRO_FELIX_CONTROL_PLANE", "http://controlplane:8443");
export const IDP = env("METRO_IDP", "http://idp:9400");
export const TENANT = env("METRO_TENANT", "metro");
export const NAMESPACE = env("METRO_NAMESPACE", "default");
export const AUDIENCE = "felix-metro";
export const RETENTION_SECONDS = 7 * 24 * 60 * 60;
// Per stream, so a dev machine's disk is safe at any speed.
export const MAX_BYTES = 1024 ** 3;

export async function request(method, url, { token, headers = {}, body } = {}) {
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
export { issuer };

// Felix keys RBAC on sha256(issuer|subject), not on the subject itself.
export const principal = (subject) => createHash("sha256").update(`${issuer}|${subject}`).digest("hex");

export async function exchange(subject, body) {
  const { id_token } = await request("GET", `${IDP}/token?sub=${subject}&aud=${AUDIENCE}`);
  const url = `${CONTROL_PLANE}/v1/tenants/${TENANT}/token/exchange`;
  return (await request("POST", url, { token: id_token, body })).felix_token;
}

export const object = (kind, name) => `${kind}:${TENANT}/${NAMESPACE}/${name}`;

export const grant = (token, subject, name, action) =>
  request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/rbac/policies`, {
    token,
    body: { subject, object: object("stream", name), action },
  });

export const createStream = (token, stream, shards, retention, maxBytes) => {
  console.log(`stream ${stream}, ${shards} shard${shards === 1 ? "" : "s"}`);
  return request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces/${NAMESPACE}/streams`, {
    token,
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

/** The names a city's roles go by. A fork uses the roles of the city it began from. */
export const roles = (root) => ({ watch: `role:metro-${root}-watch`, build: `role:metro-${root}-build` });

/**
 * A city's two streams: the events, one shard per district, and the commands. The city's name is the one
 * its streams carry, so a fork's has no `~`.
 */
export async function createCityStreams(token, name, districts) {
  const events = `metro.events.${name}`;
  const commands = `metro.commands.${name}`;
  await createStream(token, events, districts, RETENTION_SECONDS, MAX_BYTES);
  await createStream(token, commands, 1, RETENTION_SECONDS, MAX_BYTES);
  return { events, commands };
}
