import { verifyPassword } from '../../core/passwords.mjs';
import { ok, bad, unauthorized, tooMany, missing, audit, str } from '../helpers.mjs';
import { publicUser } from '../projections.mjs';

const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map(); // in-memory login throttle (per instance)

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

    // opportunistically clear expired sessions
    for (const s of await store.list('sessions')) {
      if (new Date(s.expires_at).getTime() < Date.now()) await store.remove('sessions', s.id).catch(() => {});
    }
    const token = helpers.newToken();
    const expires = new Date(Date.now() + helpers.sessionTtlHours * 3600 * 1000).toISOString();
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
