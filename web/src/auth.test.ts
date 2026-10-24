import { describe, expect, it } from 'vitest';
import { authorizeUrl, challengeFor } from './auth';

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
