/**
 * One CORS policy for both transports (server.mjs and the Netlify function).
 *
 * The SPA is served from the same origin as the API, so browsers never need a
 * cross-origin grant to use it. Both transports used to reflect *any* `Origin`
 * header back as `access-control-allow-origin` in production, which turns the
 * API into a cross-origin target for every site on the web (the login
 * endpoint included). The grant is now limited to:
 *
 *   - the request's own host (same-origin requests do carry an Origin header
 *     on POST/PUT/PATCH/DELETE, and behind a proxy the scheme may differ, so
 *     the comparison is by host, not full origin);
 *   - the `CORS_ORIGINS` environment variable — a comma-separated list of
 *     origins that may call the API from another site, or `*` to opt back
 *     into reflecting everything;
 *   - `*` when `permissive` is set (the local development server, where a
 *     separately served front-end is a normal thing to have).
 *
 * Returns the value to put in `access-control-allow-origin`, or null when the
 * request should get no CORS grant at all.
 */
export function corsAllowOrigin({ origin, host, allowlist, permissive = false } = {}) {
  if (!origin || origin === 'null') return permissive ? '*' : null;
  const list = String(allowlist ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*') || list.includes(origin)) return origin;
  let originHost = '';
  try { originHost = new URL(origin).host; } catch { return permissive ? '*' : null; }
  const hosts = String(host || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (originHost && hosts.includes(originHost.toLowerCase())) return origin;
  return permissive ? '*' : null;
}

/** The full CORS header set for a granted origin (empty when nothing is granted). */
export function corsHeaders(allowOrigin) {
  if (!allowOrigin) return {};
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    ...(allowOrigin === '*' ? {} : { vary: 'Origin' }),
  };
}
