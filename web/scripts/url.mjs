// The page installs its `window.__live`, `__metro` and `__seek` hooks only under ?trace (or in a dev build), so every
// check opens the page through this.

/** `url` with the `trace` flag in its query; the hash is kept. */
export function withTrace(url) {
  const u = new URL(url);
  u.searchParams.set('trace', '');
  return u.toString();
}
