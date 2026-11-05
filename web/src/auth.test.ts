import { afterEach, describe, expect, it, vi } from 'vitest';
import { askedFor, authorizeUrl, challengeFor, signIn, signedInAs, userFrom } from './auth';
import { subjectOf } from './identity';

const oidc = { issuer: 'http://127.0.0.1:9400', client_id: 'felix-metro', scopes: 'openid profile' };

describe('challengeFor', () => {
  it('is the S256 challenge of RFC 7636', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('authorizeUrl', () => {
  const at = (issuer: string) =>
    new URL(authorizeUrl({ ...oidc, issuer }, `${issuer}/authorize`, 'http://127.0.0.1:8088/', 'st', 'ch'));

  it('asks for the code flow with PKCE', () => {
    const url = at('https://login.example.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'felix-metro',
      redirect_uri: 'http://127.0.0.1:8088/',
      scope: 'openid profile',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('names the user for a provider on the loopback, which has a chooser, and for no other', () => {
    expect(at('http://127.0.0.1:9400').searchParams.get('sub')).toBe('viewer');
    expect(at('http://localhost:9400').searchParams.get('sub')).toBe('viewer');
    expect(at('https://login.example.com').searchParams.has('sub')).toBe(false);
  });
});

describe('userFrom', () => {
  it('signs in as the viewer unless the address names someone', () => {
    expect(userFrom('')).toBe('viewer');
    expect(userFrom('?tier=low')).toBe('viewer');
    expect(userFrom('?as=')).toBe('viewer');
    expect(userFrom('?tier=low&as=mayor')).toBe('mayor');
    expect(userFrom('?as= architect ')).toBe('architect');
  });
});

describe('askedFor', () => {
  it('is the user the address names, or null', () => {
    expect(askedFor('')).toBeNull();
    expect(askedFor('?as=')).toBeNull();
    expect(askedFor('?tier=low&as= mayor ')).toBe('mayor');
  });
});

describe('signedInAs', () => {
  it('sets ?as and keeps the rest of the address', () => {
    expect(signedInAs('http://127.0.0.1:8088/?tier=low&as=viewer#harbor', 'mayor')).toBe(
      'http://127.0.0.1:8088/?tier=low&as=mayor#harbor',
    );
    expect(signedInAs('http://127.0.0.1:8088/#pier', 'mayor')).toBe('http://127.0.0.1:8088/?as=mayor#pier');
  });
});

const token = (claims: object, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `h.${btoa(JSON.stringify({ exp, ...claims }))}.s`;

describe('subjectOf', () => {
  it('reads the sub claim', () => {
    expect(subjectOf(token({ sub: 'mayor' }))).toBe('mayor');
    expect(subjectOf(token({}))).toBeNull();
    expect(subjectOf('nonsense')).toBeNull();
    expect(subjectOf(`h.${btoa(String.fromCharCode(...new TextEncoder().encode('{"sub":"José"}')))}.s`)).toBe('José');
  });
});

describe('signIn with a token the tab already holds', () => {
  const store = new Map<string, string>();
  const sent: string[] = [];

  /** A tab on `search` that holds `held`, signing in at `issuer`. */
  const tab = (search: string, held: string | null, issuer: string, keep = false) => {
    if (!keep) store.clear();
    sent.length = 0;
    if (held) store.set('metro.token', held);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('location', {
      href: `http://127.0.0.1:8088/${search}`,
      search,
      hash: '',
      assign: (url: string) => void sent.push(url),
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` }),
        ),
    );
    return signIn({ ...oidc, issuer });
  };

  afterEach(() => vi.unstubAllGlobals());

  const viewer = token({ sub: 'viewer' });

  it('keeps it when the address asks for no one', async () => {
    expect(await tab('', viewer, oidc.issuer)).toBe(viewer);
    expect(sent).toEqual([]);
  });

  it('keeps it when ?as names the user it is for', async () => {
    expect(await tab('?as=viewer', viewer, oidc.issuer)).toBe(viewer);
    expect(sent).toEqual([]);
  });

  it('drops it and signs in again when ?as names someone else, on the stand-in', async () => {
    void tab('?as=mayor', viewer, oidc.issuer);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(new URL(sent[0]!).searchParams.get('sub')).toBe('mayor');
    expect(store.has('metro.token')).toBe(false);
  });

  it('does not ask again when the provider answered a different user than asked for', async () => {
    store.set('metro.asked', 'mayor');
    expect(await tab('?as=mayor', viewer, oidc.issuer, true)).toBe(viewer);
    expect(sent).toEqual([]);
  });

  it('ignores ?as with a real provider', async () => {
    expect(await tab('?as=mayor', viewer, 'https://login.example.com')).toBe(viewer);
    expect(sent).toEqual([]);
  });
});
