// A stand-in OpenID Connect provider for the sim's integration test. It signs
// an ID token for any subject asked for, so never expose it.
//
// GET /token?sub=<subject>&aud=<audience> mints an ID token for the seed script.
import { createServer } from "node:http";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

const PORT = Number(process.env.IDP_PORT ?? 9400);
const ISSUER = process.env.IDP_ISSUER ?? `http://127.0.0.1:${PORT}`;
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const kid = randomUUID();
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }],
};
const discovery = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks.json`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["ES256"],
};

const base64url = (value) => Buffer.from(value).toString("base64url");

function mint(subject, audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const claims = base64url(
    JSON.stringify({ iss: ISSUER, sub: subject, aud: audience, iat: now, exp: now + TOKEN_TTL_SECONDS }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

createServer((request, response) => {
  const url = new URL(request.url, ISSUER);
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/jwks.json") return reply(200, jwks);
  if (url.pathname === "/.well-known/openid-configuration") return reply(200, discovery);
  const subject = url.searchParams.get("sub");
  const audience = url.searchParams.get("aud");
  if (url.pathname === "/token" && subject && audience) {
    return reply(200, { id_token: mint(subject, audience) });
  }
  return reply(404, { error: "not found" });
}).listen(PORT, () => console.log(`IdP ${ISSUER} listening on ${PORT}`));
