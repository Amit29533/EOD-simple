import { verifyPassword } from '../../core/passwords.mjs';
import { ok, bad, unauthorized, tooMany, missing, audit, str } from '../helpers.mjs';
import { publicUser } from '../projections.mjs';

const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map(); // in-memory login throttle (per instance)

/**
 * Concurrent sessions kept per user. Cap bounds row growth on the login hot
 * path (every login used to sweep *all* sessions — a full-table scan plus one
 * store write per expired row — while still only ever producing one live
 * token per client); the oldest live sessions are revoked when the cap is hit.
 */
const MAX_SESSIONS_PER_USER = 10;

const throttled = (key) => {
  const f = failures.get(key);
  return f && f.count >= MAX_FAILURES && f.resetAt > Date.now();
};
const recordFailure = (key) => {
  const f = failures.get(key);
  if (!f || f.resetAt <= Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else f.count += 1;
};

export function authHandlers(route) {
  route('POST', '/auth/login', 'public', async ({ store, body, helpers, audit: _a }) => {
    const need = missing(body, ['username', 'password']);
    if (need.length) return bad('Username and password are required.');
    const username = str(body.username, 100).toLowerCase();
    if (throttled(username)) return tooMany('Too many failed attempts. Please wait a few minutes and try again.');

    const users = await store.list('users', { username });
    const user = users[0];
    if (!user || user.active === false || !verifyPassword(body.password, user.password_hash)) {
      recordFailure(username);
      return unauthorized('Invalid username or password.');
    }
    failures.delete(username);

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
