// Same-origin CSRF guard for state-changing /ui requests (Gap H2).
//
// A cross-site forged browser POST always carries an `Origin` (and usually a `Referer`) naming the
// attacker's site, never ours — so we block any non-GET request whose Origin/Referer host differs
// from our own Host. A request with NEITHER header is not a cross-origin browser attack (browsers
// always attach one on cross-origin POSTs); it's a same-origin or non-browser client (curl, health
// probe, CLI), so we allow it. This is the standard header-based CSRF check (Rails/Django-style),
// and it composes with the default loopback bind (resolveBindHost) + SameSite=Strict session cookie.

type Headers = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function hostOf(urlish: string | undefined): string | undefined {
  if (!urlish) return undefined;
  try {
    return new URL(urlish).host;
  } catch {
    return undefined; // opaque "null" origin, malformed value, etc.
  }
}

/**
 * True when the request is safe to process: it is same-origin (Origin/Referer host === our Host),
 * OR it carries no cross-origin signal at all (no Origin and no Referer). False only on a genuine
 * cross-origin mismatch — the CSRF case we must block.
 */
export function isSameOrigin(req: { headers: Headers }): boolean {
  const host = first(req.headers.host);
  const origin = first(req.headers.origin);
  if (origin !== undefined) return !!host && hostOf(origin) === host;
  const referer = first(req.headers.referer) ?? first(req.headers.referrer);
  if (referer !== undefined) return !!host && hostOf(referer) === host;
  return true; // no Origin/Referer → not a cross-origin browser attack → allow
}
