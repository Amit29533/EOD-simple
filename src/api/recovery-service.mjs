import { createHash } from 'node:crypto';
import { newToken } from '../core/ids.mjs';
import { hashPasswordAsync } from '../core/passwords.mjs';
import { withLock } from './mutex.mjs';
import { createGate } from '../core/gate.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const recoveryGate = createGate({ concurrency: 2, maxWaiting: 8 });
export async function issueRecoveryLink(store, user, currentSession = null) {
  const generation = newToken();
  if (currentSession) await store.update('sessions', currentSession.id, { session_generation: generation });
  await store.update('users', user.id, { session_generation: generation });
  const token = newToken();
  const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
  await store.insert('sessions', { token: digest(token), purpose: 'recovery', user_id: user.id,
    session_generation: generation, expires_at });
  return { token, expires_at };
}

export async function redeemRecoveryLink(store, token, password) {
  const link = (await store.list('sessions', { token: digest(token) })).find((s) => s.purpose === 'recovery');
  if (!link || !Number.isFinite(Date.parse(link.expires_at)) || Date.parse(link.expires_at) <= Date.now()) return false;
  return withLock(`identity:${link.user_id}`, async () => {
    const current = await store.get('users', link.user_id);
    if (!current || current.active === false || current.session_generation !== link.session_generation) return false;
    const password_hash = await recoveryGate.run(() => hashPasswordAsync(password));
    const patch = (user) => Date.parse(link.expires_at) > Date.now() && user && user.active !== false && user.session_generation === link.session_generation
      ? { password_hash, session_generation: newToken() } : undefined;
    let changed;
    if (typeof store.changeRow === 'function') changed = (await store.changeRow('users', { id: link.user_id }, patch)).changed;
    else {
      const user = await store.get('users', link.user_id);
      const update = patch(user);
      changed = Boolean(update);
      if (update) await store.update('users', user.id, update);
    }
    if (!changed) return false;
    const sessions = await store.list('sessions', { user_id: link.user_id });
    await Promise.all(sessions.map((s) => store.remove('sessions', s.id).catch(() => {})));
    return true;
  });
}
