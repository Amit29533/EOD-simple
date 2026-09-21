/** API client: token-bearing fetch wrapper. On 401 the session is dropped. */
const TOKEN_KEY = 'ecod.token';
let onUnauthorized = () => {};

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
};

export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

/**
 * A request without a deadline can hang forever: the exam's final submit then
 * leaves the candidate on the "Submitting your assessment…" panel with no
 * error, no retry and no way forward. `timeoutMs` gives the requests that must
 * *resolve* — the submit — a budget past which they fail like any other
 * network error, so the retry screen takes over. Only opt-in: the default
 * (0) keeps the browser's own behavior everywhere else.
 */
function timeoutError(ms) {
  return new ApiError(`The server did not respond within ${Math.round(ms / 1000)}s.`, 0, null);
}

export async function api(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    // An aborted fetch is a deadline we set ourselves, not a browser message.
    if (controller?.signal.aborted) throw timeoutError(timeoutMs);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    // Only treat this as a session drop when a session actually existed.
    // A failed sign-in attempt also returns 401 and must NOT wipe the
    // login form or re-render the page.
    if (res.status === 401) {
      const hadSession = !!session.token;
      session.token = null;
      if (hadSession) onUnauthorized();
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

/**
 * Fetch every page of a paginated list endpoint into one array. List routes
 * cap pages (200 by default, 500 max), so a single call silently drops rows
 * past the first page — this follows `offset` until `total` rows are in hand.
 * A response without pagination metadata ends the walk after one page, so
 * unpaginated routes stay single-request and the helper is stub-safe in tests.
 */
export async function apiAll(path, key, { limit = 500 } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const rows = [];
  let offset = 0;
  let total = Infinity;
  let guard = 0;
  while (rows.length < total && guard++ < 100) {
    const page = await api(`${path}${sep}limit=${limit}&offset=${offset}`);
    const batch = Array.isArray(page?.[key]) ? page[key] : [];
    rows.push(...batch);
    if (typeof page?.total !== 'number') break;
    total = page.total;
    offset = rows.length;
    if (!batch.length) break;
  }
  return rows;
}

export const login = (username, password) => api('/auth/login', { method: 'POST', body: { username, password } });
export const logout = () => api('/auth/logout', { method: 'POST' }).catch(() => {});
export const me = () => api('/auth/me');
export const bootstrap = () => api('/meta/bootstrap');
