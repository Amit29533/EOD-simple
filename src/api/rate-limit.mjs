/**
 * Request budgets for the self-hosted server (`server.mjs`; the Netlify
 * transport has no app-level limiter and relies on the platform's).
 *
 * Budgets are per CLIENT, not per address. An exam room is many candidates
 * behind one NAT or proxy address, and the exam hall's own traffic — a lock, a
 * refetch and a draft or two for every 30-second objective question — is
 * 13–17 API requests a minute per seat. The previous budget, 200 API requests
 * a minute per address, was full at 11–15 seats: past that, every lock and
 * every draft from the whole room was refused for the rest of the minute
 * while the exam clocks kept running.
 *
 *  - session: an API request carrying a bearer token the app has accepted
 *    draws on that token's own budget. One candidate flat out (typing notes
 *    through a two-minute open answer) is ~50 requests a minute; an admin
 *    import is a handful.
 *  - anon: everything a client can do without being signed in draws on the
 *    address's anonymous budget — the public routes (sign-in, bootstrap)
 *    whether or not a token is attached, requests without a token, and
 *    requests whose token the app rejected (charged after the fact). A token
 *    the app has not yet accepted earns nothing: while the address's
 *    anonymous budget is exhausted, requests on unknown tokens are refused
 *    too, so rotating made-up tokens buys no more than sending none. Brute
 *    force on credentials is the login throttle's job (per address and per
 *    account); this budget bounds request floods on the public routes, which
 *    each cost the server a password verification.
 *  - address ceilings: every API request also counts against a high
 *    per-address ceiling, and every request of any kind (static files
 *    included — the browser caches them for an hour, a cold seat is ~17 of
 *    them) against a total one. They bound a runaway client, or a room of
 *    them, and are sized for a room rather than a laptop.
 *
 * Fixed one-minute windows per key; a refusal says how long is left.
 */
import { createHash } from 'node:crypto';

export const WINDOW_MS = 60_000;

/** Production defaults; `server.mjs` reads overrides from the environment. */
export const PRODUCTION_LIMITS = Object.freeze({
  session: 200, // per accepted bearer token
  anon: 600, // per address: public routes, no token, rejected tokens
  addressApi: 2400, // per address, all API requests (≈ 140 seats at exam pace)
  addressTotal: 4000, // per address, everything including static files
});

/** Development and tests: never in the way. */
export const DEVELOPMENT_LIMITS = Object.freeze({
  session: 1000, anon: 1000, addressApi: 10_000, addressTotal: 20_000,
});

/** How long an accepted token stays known without being seen again. */
const TRUST_MS = 10 * 60_000;

/** Budget names in the order a refusal is reported. */
const ORDER = ['session', 'anon', 'addressApi', 'addressTotal'];

const tokenKey = (token) => createHash('sha256').update(String(token)).digest('base64url').slice(0, 22);

/** The bearer token of a request, or '' — the same rule the app uses. */
export function bearerOf(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

export function createRateLimiter({ limits = PRODUCTION_LIMITS, windowMs = WINDOW_MS, now = Date.now } = {}) {
  const buckets = new Map(); // key -> { count, resetAt }
  const trusted = new Map(); // token key -> last seen

  const live = (key, t) => {
    const b = buckets.get(key);
    return b && b.resetAt > t ? b : null;
  };
  const retryIn = (b, t) => Math.max(1, Math.ceil((b.resetAt - t) / 1000));
  const hit = (key, limit, t) => {
    let b = live(key, t);
    if (!b) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count > limit ? retryIn(b, t) : 0;
  };
  /** Seconds left on a bucket with no room for one more, without charging it; 0 if it has room. */
  const exhausted = (key, limit, t) => {
    const b = live(key, t);
    return b && b.count >= limit ? retryIn(b, t) : 0;
  };

  return {
    limits,
    /**
     * Charge a request to its budgets. Returns `null` when admitted, else
     * `{ budget, retryAfter }` — the first budget that refused it and the
     * seconds until that window resets. Refused requests still count, so a
     * client that keeps retrying stays refused until the window turns over.
     * `anonymous` marks a public route (the sign-in and bootstrap calls),
     * which draws on the anonymous budget whatever token it carries.
     */
    check({ ip = 'unknown', isApi = false, token = '', anonymous = false } = {}) {
      const t = now();
      const refused = {};
      if (isApi) {
        if (anonymous || !token) refused.anon = hit(`a:${ip}`, limits.anon, t);
        else {
          const key = tokenKey(token);
          if (trusted.has(key)) trusted.set(key, t);
          else refused.anon = exhausted(`a:${ip}`, limits.anon, t);
          if (!refused.anon) refused.session = hit(`s:${key}`, limits.session, t);
        }
        refused.addressApi = hit(`api:${ip}`, limits.addressApi, t);
      }
      refused.addressTotal = hit(`all:${ip}`, limits.addressTotal, t);
      for (const budget of ORDER) {
        if (refused[budget]) return { budget, retryAfter: refused[budget] };
      }
      return null;
    },
    /** The app resolved this token: from now on it draws on its own budget. */
    accepted({ token = '' } = {}) {
      if (token) trusted.set(tokenKey(token), now());
    },
    /** The app answered 401 to a token request: the attempt was anonymous after all. */
    rejected({ ip = 'unknown' } = {}) {
      hit(`a:${ip}`, limits.anon, now());
    },
    /** Drop windows that have turned over and tokens not seen lately (call periodically). */
    sweep() {
      const t = now();
      for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
      for (const [k, seen] of trusted) if (seen + TRUST_MS <= t) trusted.delete(k);
    },
    get size() { return buckets.size + trusted.size; },
  };
}

/** Limits from the environment (`RATE_<NAME>_PER_MIN`), falling back per key. */
export function limitsFromEnv(env = {}, base = PRODUCTION_LIMITS) {
  const names = { session: 'RATE_SESSION_PER_MIN', anon: 'RATE_ANON_PER_MIN', addressApi: 'RATE_ADDRESS_API_PER_MIN', addressTotal: 'RATE_ADDRESS_TOTAL_PER_MIN' };
  const out = { ...base };
  for (const [key, name] of Object.entries(names)) {
    const n = Number(env[name]);
    if (env[name] !== undefined && Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
  }
  return out;
}
