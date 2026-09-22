import { verifyPasswordAsync } from '../../core/passwords.mjs';
import { createGate } from '../../core/gate.mjs';
import { ok, bad, unauthorized, tooMany, missing, audit, str } from '../helpers.mjs';
import { publicUser } from '../projections.mjs';

/**
 * Failed-login throttle.
 *
 * Keyed on username AND client address, not the username alone: a throttle
 * keyed on the username only was a remote lock-out lever — usernames are
 * guessable (`admin`; the bulk import derives them from the e-mail
 * local-part), so eight wrong passwords from anywhere put the real owner on a
 * 429 for the next ten minutes, with the correct password, repeatable
 * forever. For a candidate mid-exam that also burned their server-side clock.
 *
 * Two buckets per username:
 *  - `username|address`  — MAX_FAILURES in WINDOW_MS locks that address out
 *    of that account (a self-lockout after your own typos, the classic rule);
 *  - `username|*`        — every address together; MAX_FAILURES_ANY_ADDRESS
 *    bounds distributed guessing from rotating addresses, and is waived for
 *    an address that has signed in to that account within TRUST_MS, so a
 *    user on their usual network cannot be locked out by strangers.
 *
 * Both maps are in-memory and per process (per warm instance on Netlify).
 * A transport that does not supply an address (in-process callers, tests)
 * shares the `unknown` address, which reduces to the old per-username rule.
 */
const MAX_FAILURES = 8;
const MAX_FAILURES_ANY_ADDRESS = 32;
const WINDOW_MS = 10 * 60 * 1000;
const TRUST_MS = 24 * 60 * 60 * 1000;
const failures = new Map(); // `username|address` / `username|*` -> { count, resetAt }
const trusted = new Map();  // username -> Map<address, trustedUntil>

/**
 * Concurrent sessions kept per user. Cap bounds row growth on the login hot
 * path (every login used to sweep *all* sessions — a full-table scan plus one
 * store write per expired row — while still only ever producing one live
 * token per client); the oldest live sessions are revoked when the cap is hit.
 */
const MAX_SESSIONS_PER_USER = 10;

/**
 * A well-formed hash that matches no password. A failed login runs the same
 * scrypt work against it whether or not the account exists (or is disabled),
 * so the response time no longer tells a caller which usernames are real:
 * an unknown username used to be refused in ~0 ms and a wrong password for
 * a real one in ~40 ms.
 */
const DECOY_HASH = `s2:${'0'.repeat(32)}:${'0'.repeat(128)}`;

/**
 * Password verifications in flight, process-wide. A verify is ~45 ms of
 * scrypt on the libuv threadpool — four threads, FIFO, shared with every
 * `fs.promises` call the server makes — and each sign-in attempt costs one
 * whether or not the account exists (the decoy keeps the timing even). Left
 * ungated, a room signing in together or a flood of made-up usernames from
 * one address (the failed-login throttle is per username, so it never
 * engages) queued hundreds of scrypt jobs ahead of everything else: static
 * files took seconds, a genuine sign-in a second or more. Two in flight
 * leave two threads for the rest of the server; VERIFY_MAX_WAITING attempts
 * may queue behind them (a 140-seat room at the same second waits ≈ 4 s at
 * the back), and anything beyond that is told at once to try again.
 */
export const VERIFY_CONCURRENCY = 2;
export const VERIFY_MAX_WAITING = 200;
const verifyGate = createGate({ concurrency: VERIFY_CONCURRENCY, maxWaiting: VERIFY_MAX_WAITING });
export const loginGateState = () => ({ inFlight: verifyGate.inFlight, waiting: verifyGate.waiting });
const signInBusy = () => ({
  status: 503,
  headers: { 'retry-after': '2' },
  body: { error: 'Sign-in is busy right now. Please try again in a moment.' },
});

const bucket = (key) => {
  const f = failures.get(key);
  return f && f.resetAt > Date.now() ? f : null;
};
const bump = (key) => {
  const f = bucket(key);
  if (f) f.count += 1;
  else failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
};
const isTrusted = (username, address) => (trusted.get(username)?.get(address) || 0) > Date.now();
const throttled = (username, address) => {
  const own = bucket(`${username}|${address}`);
  if (own && own.count >= MAX_FAILURES) return true;
  if (isTrusted(username, address)) return false;
  const any = bucket(`${username}|*`);
  return Boolean(any && any.count >= MAX_FAILURES_ANY_ADDRESS);
};
const recordFailure = (username, address) => {
  bump(`${username}|${address}`);
  bump(`${username}|*`);
};
const recordSuccess = (username, address) => {
  // Only this address's own strikes are forgiven: a legitimate sign-in must
  // not reset the count an attacker is accumulating from elsewhere.
  failures.delete(`${username}|${address}`);
  if (!trusted.has(username)) trusted.set(username, new Map());
  trusted.get(username).set(address, Date.now() + TRUST_MS);
};

// Periodic cleanup of expired entries to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) {
    if (v.resetAt <= now) failures.delete(k);
  }
  for (const [username, addresses] of trusted) {
    for (const [address, until] of addresses) if (until <= now) addresses.delete(address);
    if (!addresses.size) trusted.delete(username);
  }
}, 60_000).unref?.();

/** Exposed for tests only: forget every strike and every trusted address. */
export function resetLoginThrottle() {
  failures.clear();
  trusted.clear();
}

export function authHandlers(route) {
  route('POST', '/auth/login', 'public', async ({ store, body, helpers, ip }) => {
    const need = missing(body, ['username', 'password']);
    if (need.length) return bad('Username and password are required.');
    const username = str(body.username, 100).toLowerCase();
    const address = typeof ip === 'string' && ip.trim() ? ip.trim() : 'unknown';
    if (throttled(username, address)) return tooMany('Too many failed attempts. Please wait a few minutes and try again.');

    const users = await store.list('users', { username });
    let user = users[0];
    // The sign-in form accepts "username or email". Usernames are unique; emails
    // are not, so an email match is only used when it is unambiguous.
    if (!user && username.includes('@')) {
      const matches = (await store.list('users'))
        .filter((u) => String(u.email || '').trim().toLowerCase() === username);
      if (matches.length === 1) user = matches[0];
    }
    // One verification, always: a missing or disabled account verifies
    // against the decoy so the failure costs the same as a wrong password.
    const eligible = Boolean(user) && user.active !== false;
    let okPass;
    try {
      okPass = await verifyGate.run(() => verifyPasswordAsync(body.password, (eligible && user.password_hash) || DECOY_HASH));
    } catch (err) {
      if (err?.code === 'GATE_FULL') return signInBusy();
      throw err;
    }
    if (!eligible || !okPass) {
      recordFailure(username, address);
      return unauthorized('Invalid username or password.');
    }
    recordSuccess(username, address);

    // Session hygiene is scoped to THIS user, never a full-table scan on the
    // login hot path: drop expired sessions and cap concurrent ones (oldest
    // first). Anything that expires between here and the next request is
    // removed lazily by resolveAuth when its token is presented.
    const now = Date.now();
    const mine = await store.list('sessions', { user_id: user.id });
    const live = mine
      .filter((s) => new Date(s.expires_at).getTime() >= now)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const drop = [
      ...mine.filter((s) => new Date(s.expires_at).getTime() < now),
      ...live.slice(MAX_SESSIONS_PER_USER - 1),
    ];
    await Promise.all(drop.map((s) => store.remove('sessions', s.id).catch(() => {})));

    const token = helpers.newToken();
    const expires = new Date(now + helpers.sessionTtlHours * 3600 * 1000).toISOString();
    await store.insert('sessions', { token, user_id: user.id, expires_at: expires });
    await audit(store, user, 'login', 'users', user.id, `${user.name} signed in`);

    let candidate = null;
    if (user.candidate_id) candidate = await store.get('candidates', user.candidate_id);
    return ok({
      token,
      user: publicUser(user),
      candidate: candidate ? { id: candidate.id, name: candidate.name, stage: candidate.stage } : null,
    });
  });

  route('POST', '/auth/logout', null, async ({ store, auth }) => {
    await store.remove('sessions', auth.session.id).catch(() => {});
    return ok({ ok: true });
  });

  route('GET', '/auth/me', null, async ({ store, auth }) => {
    let candidate = null;
    if (auth.user.candidate_id) candidate = await store.get('candidates', auth.user.candidate_id);
    return ok({
      user: publicUser(auth.user),
      candidate: candidate ? { id: candidate.id, name: candidate.name, stage: candidate.stage } : null,
    });
  });
}
