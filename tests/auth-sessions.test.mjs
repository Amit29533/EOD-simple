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
    username: 'admin', name: 'Admin', role: 'admin', email: '',
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
