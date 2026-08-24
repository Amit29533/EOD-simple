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

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401) { session.token = null; onUnauthorized(); }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

export const login = (username, password) => api('/auth/login', { method: 'POST', body: { username, password } });
export const logout = () => api('/auth/logout', { method: 'POST' }).catch(() => {});
export const me = () => api('/auth/me');
export const bootstrap = () => api('/meta/bootstrap');
