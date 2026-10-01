import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { base32, totp, encryptMfa, decryptMfa } from '../src/core/mfa.mjs';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';

test('TOTP matches RFC 6238 SHA-1 test vectors; encrypted secrets are bound to their user', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])
    assert.equal(totp(secret, seconds * 1000, 8), expected);
  const previous = process.env.SECURITY_ENCRYPTION_KEY;
  process.env.SECURITY_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    const value = encryptMfa(secret, 'one');
    assert.equal(decryptMfa(value, 'one'), secret);
    assert.throws(() => decryptMfa(value, 'two'));
  } finally { previous === undefined ? delete process.env.SECURITY_ENCRYPTION_KEY : process.env.SECURITY_ENCRYPTION_KEY = previous; }
});

test('authenticator setup, one-time login codes, backup codes and disable preserve only the current session', async (t) => {
  const previous = process.env.SECURITY_ENCRYPTION_KEY;
  process.env.SECURITY_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  t.after(() => { previous === undefined ? delete process.env.SECURITY_ENCRYPTION_KEY : process.env.SECURITY_ENCRYPTION_KEY = previous; });
  const w = await makeWorld({ t });
  const other = await w.login('admin', ADMIN_PASSWORD);
  const call = (path, body, token = w.tok) => w.call('POST', path, { token, body });
  assert.equal((await call('/auth/mfa/setup', { password: 'wrong' })).status, 403);
  const setup = await call('/auth/mfa/setup', { password: ADMIN_PASSWORD });
  assert.equal(setup.status, 200);
  const enabled = await call('/auth/mfa/enable', { otp: totp(setup.body.secret) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recovery_codes.length, 8);
  assert.equal((await w.call('GET', '/auth/me', { token: other })).status, 401);
  assert.equal((await w.call('GET', '/auth/me', { token: w.tok })).status, 200);
  const signIn = (otp) => w.call('POST', '/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD, otp } });
  assert.equal((await signIn()).status, 401);
  assert.equal((await signIn(totp(setup.body.secret))).status, 401, 'setup code cannot be replayed');
  const backup = enabled.body.recovery_codes[0];
  const login = await signIn(backup);
  assert.equal(login.status, 200);
  assert.equal((await signIn(backup)).status, 401, 'backup code cannot be replayed');
  const user = (await w.store.list('users', { username: 'admin' }))[0];
  assert.ok(!JSON.stringify(user.mfa_json).includes(setup.body.secret));
  assert.ok(!JSON.stringify(user.mfa_json).includes(backup));
  assert.equal((await call('/auth/mfa/disable', { password: ADMIN_PASSWORD, otp: enabled.body.recovery_codes[1] }, login.body.token)).status, 200);
  assert.equal((await signIn()).status, 200);
});
