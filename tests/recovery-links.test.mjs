import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';

test('admin recovery link is password gated, hashed, one-time, and revokes existing sessions', async (t) => {
  const w = await makeWorld({ t });
  const person = await w.assessorUser('recovery.person');
  const issue = (password) => w.call('POST', `/admin/users/${person.user.id}/recovery-link`, { token: w.tok, body: { password } });
  assert.equal((await issue('wrong-password')).status, 403);
  const link = await issue(ADMIN_PASSWORD);
  assert.equal(link.status, 200);
  assert.equal((await w.call('GET', '/auth/me', { token: person.token })).status, 401);
  const records = await w.store.list('sessions', { user_id: person.user.id });
  const saved = records.find((s) => s.purpose === 'recovery');
  assert.notEqual(saved.token, link.body.token, 'raw token is never stored');
  assert.equal((await w.call('GET', '/auth/me', { token: saved.token })).status, 401, 'recovery rows cannot authenticate as login sessions');
  const reset = () => w.call('POST', '/auth/recover', { body: { token: link.body.token, password: 'My-new-password-2026' } });
  assert.equal((await reset()).status, 200);
  assert.equal((await reset()).status, 403);
  assert.ok(await w.login(person.user.username, 'My-new-password-2026'));
});

test('expired links and links superseded by a new issue cannot reset a password', async (t) => {
  const w = await makeWorld({ t });
  const person = await w.assessorUser('expired.recovery');
  const issue = () => w.call('POST', `/admin/users/${person.user.id}/recovery-link`, { token: w.tok, body: { password: ADMIN_PASSWORD } });
  const old = await issue();
  const next = await issue();
  assert.equal((await w.call('POST', '/auth/recover', { body: { token: old.body.token, password: 'My-new-password-2026' } })).status, 403);
  for (const row of await w.store.list('sessions', { user_id: person.user.id }))
    if (row.purpose === 'recovery') await w.store.update('sessions', row.id, { expires_at: new Date(Date.now() - 1).toISOString() });
  assert.equal((await w.call('POST', '/auth/recover', { body: { token: next.body.token, password: 'My-new-password-2026' } })).status, 403);
});
