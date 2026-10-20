import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, USER_PASSWORD } from './helpers/world.mjs';

test('email sign-in accepts the same email lengths permitted by account administration', async (t) => {
  const w = await makeWorld({ t });
  const email = `audit@${'a'.repeat(50)}.${'b'.repeat(50)}.example.com`;
  assert.ok(email.length > 100 && email.length <= 200);
  const user = await w.call('POST', '/admin/users', { token: w.tok, body: {
    username: 'long.email.assessor', name: 'Long Email Assessor', role: 'assessor', email, password: USER_PASSWORD,
  } });
  assert.equal(user.status, 201);
  const login = await w.call('POST', '/auth/login', { body: { username: `  ${email.toUpperCase()}  `, password: USER_PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.id, user.body.id);
  assert.equal((await w.call('POST', '/auth/login', { body: { username: email + 'x'.repeat(200), password: USER_PASSWORD } })).status, 400);
});
