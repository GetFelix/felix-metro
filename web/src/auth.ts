// Signing in at the gateway's OpenID Connect provider: the authorization code flow with PKCE, as a public client. The
// ID token it returns goes in the gateway's `join`.

export interface Oidc {
  issuer: string;
  client_id: string;
  scopes: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

const TOKEN_KEY = 'metro.token';
const FLOW_KEY = 'metro.auth';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** The PKCE S256 challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

const isLoopback = (url: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

/**
 * Where to send the browser to sign in. The development provider skips its chooser when told who is signing in, so a
 * page on a loopback provider asks for `viewer`; a real provider never sees the extra parameter.
 */
export function authorizeUrl(
  oidc: Oidc,
  endpoint: string,
  redirectUri: string,
  state: string,
  challenge: string,
  user = 'viewer',
): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: oidc.client_id,
    redirect_uri: redirectUri,
    scope: oidc.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  if (isLoopback(oidc.issuer)) url.searchParams.set('sub', user);
  return url.href;
}

/** What the gateway says about signing in, or `null` when nothing here answers like a gateway. */
export async function fetchOidc(base: string): Promise<Oidc | null> {
  try {
    const response = await fetch(new URL('oidc', base), { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const json = await response.json();
    return typeof json.issuer === 'string' && typeof json.client_id === 'string' ? (json as Oidc) : null;
  } catch {
    return null;
  }
}

/** The query and hash the page had before it went to sign in, while the provider's return is still being handled. */
export function beforeSignIn(): { search: string; hash: string } | null {
  try {
    if (!new URLSearchParams(location.search).has('code')) return null;
    const flow = JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? 'null');
    return flow ? { search: String(flow.search), hash: String(flow.hash) } : null;
  } catch {
    return null;
  }
}

function expiry(token: string): number {
  try {
    const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return Number(claims.exp) * 1000;
  } catch {
    return 0;
  }
}

function remembered(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    return token && expiry(token) > Date.now() + 60_000 ? token : null;
  } catch {
    return null;
  }
}

/**
 * An ID token for the gateway. Returns the one this tab already has, finishes a sign-in the provider just sent the
 * browser back from, or sends the browser to the provider and never returns.
 */
export async function signIn(oidc: Oidc): Promise<string> {
  const held = remembered();
  if (held) return held;
  const discovery = (await (
    await fetch(`${oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
  ).json()) as Discovery;
  const here = new URL(location.href);
  const redirectUri = here.origin + here.pathname;
  const code = here.searchParams.get('code');
  if (code) {
    const flow = JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? 'null') as {
      state: string;
      verifier: string;
      search: string;
      hash: string;
    } | null;
    sessionStorage.removeItem(FLOW_KEY);
    // A return that matches no flow here would only start another sign-in and loop.
    if (!flow || flow.state !== here.searchParams.get('state')) throw new Error('sign-in did not match this tab');
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: oidc.client_id,
        redirect_uri: redirectUri,
        code_verifier: flow.verifier,
      }),
    });
    if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
    const token = String((await response.json()).id_token);
    sessionStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, '', redirectUri + flow.search + flow.hash);
    return token;
  }
  const flow = { state: random(), verifier: random(), search: location.search, hash: location.hash };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  location.assign(
    authorizeUrl(oidc, discovery.authorization_endpoint, redirectUri, flow.state, await challengeFor(flow.verifier)),
  );
  return new Promise(() => {});
}
