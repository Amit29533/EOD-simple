import { newToken } from '../core/ids.mjs';
import { SESSION_TTL_HOURS } from '../core/constants.mjs';
import { registerRoutes, dispatch } from './router.mjs';
import { unauthorized } from './helpers.mjs';

/**
 * Transport-agnostic application. `app({method, path, query, headers, body})`
 * resolves the session, enforces role guards, dispatches to a handler and
 * returns { status, body }. Used identically by the local dev server and the
 * Netlify function wrapper.
 */
export async function createApp(store) {
  const routes = registerRoutes();

  async function resolveAuth(headers = {}) {
    const raw = headers.authorization || headers.Authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(raw);
    if (!m) return null;
    const token = m[1].trim();
    // Basic token format validation (hex, 64 chars)
    if (!/^[a-f0-9]{32,128}$/i.test(token)) return null;
    const sessions = await store.list('sessions', { token });
    const session = sessions[0];
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await store.remove('sessions', session.id).catch(() => {});
      return null;
    }
    const user = await store.get('users', session.user_id);
    if (!user || user.active === false) return null;
    return { user, session, token };
  }

  return async function app({ method, path, query = {}, headers = {}, body, ip = '' }) {
    try {
      // Basic path sanitization
      if (typeof path !== 'string' || path.length > 2000 || path.includes('\0')) {
        return { status: 400, body: { error: 'Invalid request path' } };
      }
      // Handlers read `body.field` everywhere, so the body must be a plain
      // object: an array, string or number that parsed as valid JSON used to
      // reach them as-is and be treated as an empty body ("Username and
      // password are required") rather than as the malformed request it is.
      // Query strings are the same shape contract (`?limit[]=1` must not
      // become an array where a handler expects a scalar).
      if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
        return { status: 400, body: { error: 'Request body must be a JSON object.' } };
      }
      const auth = await resolveAuth(headers);
      const result = await dispatch(routes, {
        store, method, path, query: scalarQuery(query), body: body || {}, auth,
        // The client address as the transport saw it (socket / platform
        // header); only the login throttle keys on it, and never trusts it
        // for anything but bucketing.
        ip: typeof ip === 'string' ? ip.trim().slice(0, 64) : '',
        helpers: { newToken, sessionTtlHours: SESSION_TTL_HOURS },
      });
      // Whether the bearer token resolved to a live session — for the
      // transport's request budgets (a token earns its own budget only once
      // it has), not for the wire: non-enumerable, so it is never serialised
      // or compared as part of the response.
      if (result && typeof result === 'object') {
        Object.defineProperty(result, 'authenticated', { value: Boolean(auth), enumerable: false });
      }
      return result;
    } catch (err) {
      // A duplicate-id insert is a lost race between two writers (two
      // instances of a serverless deployment, where the per-process lock
      // cannot reach), not a server fault: tell the caller to retry.
      if (err?.code === 'DUPLICATE_ID') {
        console.warn(`[api] ${method} ${path}: ${err.message}`);
        return { status: 409, body: { error: 'That record was created by another request at the same time. Please refresh and try again.' } };
      }
      // A value the storage backend cannot hold (Airtable's 100,000-character
      // cell cap) is a request the caller can shrink — a shorter answer, a
      // capped allocation — not a server fault. Name the field.
      if (err?.code === 'VALUE_TOO_LARGE') {
        console.warn(`[api] ${method} ${path}: ${err.message}`);
        return { status: 413, body: { error: `This is too large for the storage backend to save (${err.field || 'a field'}). Reduce its size and try again.` } };
      }
      // The JSON store found its file changed underneath it by another
      // process and could not re-read it (mid-write, or hand-edited into
      // something unparseable). The mutation was rolled back; nothing is
      // wrong with the request, so say so and invite a retry.
      // Likewise the Blobs store, when another function instance kept
      // rewriting the same table faster than this one could re-read it
      // (compare-and-swap gave up): nothing was written, retry is safe.
      if (err?.code === 'STORE_STALE' || err?.code === 'STORE_CONFLICT') {
        console.warn(`[api] ${method} ${path}: ${err.message}`);
        return { status: 503, body: { error: 'The data store is being updated by another process. Please try again in a moment.' } };
      }
      // Never leak internal details to client
      console.error(`[api] ${method} ${path} failed:`, err.message, err.stack?.slice(0, 500));
      return { status: 500, body: { error: 'Internal error. Please try again.' } };
    }
  };
}

/**
 * Query parameters as scalars. Transports hand over `Object.fromEntries(url.searchParams)`
 * (last value wins, always a string), but a test harness or a future
 * transport may pass arrays; handlers index into `query.limit`, `query.q`,
 * `query.role_key` as strings, so anything structured is dropped here rather
 * than defended against at every use site.
 */
function scalarQuery(query) {
  if (!query || typeof query !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

export { unauthorized };
