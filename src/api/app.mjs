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

  return async function app({ method, path, query = {}, headers = {}, body }) {
    try {
      // Basic path sanitization
      if (typeof path !== 'string' || path.length > 2000 || path.includes('\0')) {
        return { status: 400, body: { error: 'Invalid request path' } };
      }
      const auth = await resolveAuth(headers);
      const result = await dispatch(routes, {
        store, method, path, query, body: body || {}, auth,
        helpers: { newToken, sessionTtlHours: SESSION_TTL_HOURS },
      });
      return result;
    } catch (err) {
      // Never leak internal details to client
      console.error(`[api] ${method} ${path} failed:`, err.message, err.stack?.slice(0, 500));
      return { status: 500, body: { error: 'Internal error. Please try again.' } };
    }
  };
}

export { unauthorized };
