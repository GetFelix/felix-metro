// What the page can tell about who is signed in, from the provider's address and the ID token.

/** Whether `issuer` is the development stand-in identity provider, which runs on the loopback. A real provider never does. */
export function isStandIn(issuer: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(issuer).hostname);
  } catch {
    return false;
  }
}

/** The `sub` claim of an ID token, or `null` when it has none. */
export function subjectOf(token: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}
