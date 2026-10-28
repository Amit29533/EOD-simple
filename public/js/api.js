/** API client: token-bearing fetch wrapper. On 401 the session is dropped. */
const TOKEN_KEY = 'ecod.token';
let onUnauthorized = () => {};

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
};

export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

/**
 * The exam is bound to one device (EXAM_OTHER_DEVICE, handlers/candidate.mjs).
 * The running exam session registers a handler so a refused request swaps the
 * hall for the "open on another device" screen instead of a retry loop.
 */
let onExamOtherDevice = null;
export function setExamOtherDeviceHandler(fn) { onExamOtherDevice = fn; }

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

/**
 * A request without a deadline can hang forever: the exam's final submit then
 * leaves the candidate on the "Submitting your assessment…" panel with no
 * error, no retry and no way forward. `timeoutMs` gives the requests that must
 * *resolve* — the submit — a budget past which they fail like any other
 * network error, so the retry screen takes over. The deadline covers headers
 * AND the response body. Callers may override it for larger uploads.
 */
function timeoutError(ms) {
  return new ApiError(`The server did not respond within ${Math.round(ms / 1000)}s.`, 0, null);
}

/**
 * A random id for this browser, kept across sign-ins. The exam is bound to it
 * (one device at a time, handlers/candidate.mjs), so signing in again on the
 * same machine is not mistaken for a second device.
 */
export function deviceId() {
  try {
    let id = localStorage.getItem('ecod.device');
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
      localStorage.setItem('ecod.device', id);
    }
    return id;
  } catch { return ''; }
}

export async function api(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  const device = deviceId();
  if (device) headers['x-ecod-device'] = device;
  const requestToken = session.token;
  if (requestToken) headers.authorization = `Bearer ${requestToken}`;
  const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  let data = null;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    });
    try { data = await res.json(); }
    catch (err) {
      if (controller?.signal.aborted) throw err;
      // A proxy's HTML error page or a truncated response is not proof that
      // an answer/score was saved. Keep it retryable instead of returning null.
      if (res.ok && res.status !== 204)
        throw new ApiError('The server returned an invalid response. Please retry.', res.status, null);
    }
    if (controller?.signal.aborted) throw timeoutError(timeoutMs);
  } catch (err) {
    // An aborted fetch is a deadline we set ourselves, not a browser message.
    if (controller?.signal.aborted) throw timeoutError(timeoutMs);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    // Only treat this as a session drop when a session actually existed.
    // A failed sign-in attempt also returns 401 and must NOT wipe the
    // login form or re-render the page.
    if (res.status === 401 && requestToken && session.token === requestToken) {
      session.token = null;
      onUnauthorized();
    }
    if (res.status === 409 && data?.code === 'EXAM_OTHER_DEVICE' && onExamOtherDevice) onExamOtherDevice(data);
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

export const login = (username, password, otp) => api('/auth/login', { method: 'POST', body: { username, password, ...(otp ? { otp } : {}) } });
export const logout = () => api('/auth/logout', { method: 'POST' });
export const me = () => api('/auth/me');
export const bootstrap = () => api('/meta/bootstrap');
export const newRequestId = () => crypto.randomUUID();
