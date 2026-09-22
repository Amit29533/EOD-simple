import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

/** Login session hygiene: per-user sweep + concurrent-session cap (no full-table scans). */

let app, store, adminId;
const call = (method, p, { token, body } = {}) =>
  app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = (u, p) => call('POST', '/auth/login', { body: { username: u, password: p } });

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-auth-sess-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  const admin = await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', email: 'admin@anthroprime.com',
    password_hash: hashPassword('admin-pw-123'), active: true,
  });
  adminId = admin.id;
  await store.insert('users', {
    username: 'other', name: 'Other', role: 'assessor', email: '',
    password_hash: hashPassword('other-pw-123'), active: true,
  });
});

test('login caps concurrent sessions per user and drops expired ones', async () => {
  // 12 logins: only the newest 10 sessions may remain for this user.
  const tokens = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await login('admin', 'admin-pw-123');
    assert.equal(res.status, 200, `login ${i}`);
    tokens.push(res.body.token);
  }
  const sessions = await store.list('sessions', { user_id: adminId });
  assert.equal(sessions.length, 10, `cap holds (${sessions.length})`);
  const all = await store.list('sessions');
  assert.equal(all.length, 10, 'sweep is scoped to the logging-in user only');

  // The NEWEST token works; the OLDEST live session was revoked.
  assert.equal((await call('GET', '/auth/me', { token: tokens[11] })).status, 200);
  assert.equal((await call('GET', '/auth/me', { token: tokens[0] })).status, 401);

  // Expired sessions of this user are swept on their next login...
  await store.insert('sessions', {
    token: 'expired-token', user_id: adminId,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  await login('admin', 'admin-pw-123');
  assert.equal((await store.list('sessions', { token: 'expired-token' })).length, 0);
  assert.equal((await store.list('sessions', { user_id: adminId })).length, 10);
  // ...but another user's expired session is left alone (never a global scan).
  await store.insert('sessions', {
    token: 'other-expired', user_id: (await store.list('users', { username: 'other' }))[0].id,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  await login('admin', 'admin-pw-123');
  assert.equal((await store.list('sessions', { token: 'other-expired' })).length, 1);
});

test('login accepts the account email as well as the username', async () => {
  const byEmail = await login('admin@anthroprime.com', 'admin-pw-123');
  assert.equal(byEmail.status, 200, JSON.stringify(byEmail.body));
  assert.equal(byEmail.body.user.username, 'admin');

  const mixedCase = await login('Admin@Anthroprime.com', 'admin-pw-123');
  assert.equal(mixedCase.status, 200);

  const unknown = await login('nobody@anthroprime.com', 'admin-pw-123');
  assert.equal(unknown.status, 401, 'unknown email is the same 401 as a bad username');
});

test('a failed login costs the same whether or not the account exists', async () => {
  // Username enumeration by clock: an unknown (or disabled) username used to
  // be refused before any password work, in ~0 ms, while a wrong password
  // for a real account took a full scrypt (~40 ms). Every failed login now
  // verifies against a decoy hash when there is no eligible account.
  await store.insert('users', {
    username: 'disabled', name: 'Disabled', role: 'assessor', email: '',
    password_hash: hashPassword('disabled-pw-123'), active: false,
  });
  const cost = async (username) => {
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      const t = process.hrtime.bigint();
      const res = await login(username, 'definitely-wrong-pw');
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid username or password.');
      runs.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return runs.sort((a, b) => a - b)[2]; // median
  };
  const real = await cost('other');
  const unknown = await cost('no.such.user');
  const disabled = await cost('disabled');
  const unknownEmail = await cost('nobody@anthroprime.com');
  // scrypt here is tens of milliseconds; the old fast path was well under one.
  for (const [label, ms] of [['unknown', unknown], ['disabled', disabled], ['unknown email', unknownEmail]]) {
    assert.ok(ms > real * 0.5, `${label} login refused in ${ms.toFixed(1)} ms vs ${real.toFixed(1)} ms for a real account — enumerable`);
  }
  // The decoy never authenticates anything, and real logins still work.
  assert.equal((await login('disabled', 'disabled-pw-123')).status, 401, 'a disabled account cannot sign in');
  assert.equal((await login('other', 'other-pw-123')).status, 200);
});
