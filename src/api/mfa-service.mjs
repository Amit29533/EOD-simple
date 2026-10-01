import { randomBytes } from 'node:crypto';
import { decryptMfa, encryptMfa, matchingCounter, newMfaSecret, recoveryCodeHash } from '../core/mfa.mjs';
import { newToken } from '../core/ids.mjs';

export async function consumeMfa(store, user, code) {
  if (!user.mfa_json?.enabled) return true;
  const secret = decryptMfa(user.mfa_json.secret, user.id);
  const counter = matchingCounter(secret, code, user.mfa_json.last_counter ?? -1);
  const recoveryHash = typeof code === 'string' && /^[a-f0-9-]{16,20}$/i.test(code) ? recoveryCodeHash(code) : null;
  if (counter === null && !user.mfa_json.recovery_hashes?.includes(recoveryHash)) return false;
  const decide = (current) => {
    const m = current?.mfa_json;
    if (!m?.enabled || current.active === false || current.password_hash !== user.password_hash
      || current.session_generation !== user.session_generation || JSON.stringify(m.secret) !== JSON.stringify(user.mfa_json.secret)) return undefined;
    if (counter !== null && counter > (m.last_counter ?? -1)) return { mfa_json: { ...m, last_counter: counter } };
    if (recoveryHash && m.recovery_hashes?.includes(recoveryHash))
      return { mfa_json: { ...m, recovery_hashes: m.recovery_hashes.filter((h) => h !== recoveryHash) } };
    return undefined;
  };
  if (typeof store.changeRow === 'function') return (await store.changeRow('users', { id: user.id }, decide)).changed;
  const current = await store.get('users', user.id), patch = decide(current);
  if (!patch) return false;
  await store.update('users', user.id, patch); return true;
}
export async function beginMfa(store, user) {
  const secret = newMfaSecret();
  const patch = { mfa_json: { enabled: false, pending: encryptMfa(secret, user.id), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } };
  if (typeof store.changeRow === 'function') {
    const result = await store.changeRow('users', { id: user.id }, (current) =>
      current?.active !== false && current?.password_hash === user.password_hash
      && current?.session_generation === user.session_generation && !current?.mfa_json?.enabled ? patch : undefined);
    if (!result.changed) return null;
  } else await store.update('users', user.id, patch);
  return { secret };
}
export async function enableMfa(store, user, session, code) {
  const m = user.mfa_json;
  if (!m?.pending || m.enabled || !Number.isFinite(Date.parse(m.expires_at)) || Date.parse(m.expires_at) <= Date.now()) return null;
  const secret = decryptMfa(m.pending, user.id);
  const counter = matchingCounter(secret, code);
  if (counter === null) return null;
  const recovery_codes = Array.from({ length: 8 }, () => randomBytes(8).toString('hex'));
  const generation = newToken();
  await store.update('sessions', session.id, { session_generation: generation });
  const patch = { session_generation: generation, mfa_json: {
    enabled: true, secret: encryptMfa(secret, user.id), last_counter: counter,
    recovery_hashes: recovery_codes.map(recoveryCodeHash),
  } };
  if (typeof store.changeRow === 'function') {
    const result = await store.changeRow('users', { id: user.id }, (current) =>
      current?.active !== false && current?.session_generation === user.session_generation
      && current?.password_hash === user.password_hash
      && JSON.stringify(current?.mfa_json) === JSON.stringify(m)
      && Date.parse(m.expires_at) > Date.now() ? patch : undefined);
    if (!result.changed) return null;
  } else await store.update('users', user.id, patch);
  return { recovery_codes };
}
