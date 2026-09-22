import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { resetLoginThrottle } from '../src/api/handlers/auth.mjs';

/**
 * The failed-login throttle used to be keyed on the username alone, so eight
 * wrong passwords from ANY address locked the account's real owner out for
 * ten minutes — a remote denial of service against a guessable username
 * (`admin`, or the e-mail local-part the bulk import derives logins from),
 * and against a candidate whose exam clock kept running meanwhile.
 */

let app;
const login = (username, password, ip) =>
  app({ method: 'POST', path: '/auth/login', body: { username, password }, headers: {}, ip });
const strike = async (username, ip, n) => {
  for (let i = 0; i < n; i += 1) await login(username, 'wrong-password-x', ip);
};

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-throttle-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', email: 'admin@example.com',
    password_hash: hashPassword('correct-horse-9'), active: true,
  });
  await store.insert('users', {
    username: 'rohit.verma', name: 'Rohit', role: 'candidate', email: 'rohit@example.com',
    password_hash: hashPassword('candidate-pw-9'), active: true,
  });
});

beforeEach(() => resetLoginThrottle());

test('eight failures from one address lock that address out of the account (self-lockout still holds)', async () => {
  await strike('admin', '10.0.0.1', 8);
  const blocked = await login('admin', 'correct-horse-9', '10.0.0.1');
  assert.equal(blocked.status, 429);
});

test('a stranger hammering the username cannot lock the real owner out', async () => {
  await strike('admin', '198.51.100.7', 8);
  const owner = await login('admin', 'correct-horse-9', '203.0.113.9');
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.ok(owner.body.token);
});

test('the account-wide ceiling still stops distributed guessing from rotating addresses', async () => {
  for (let i = 0; i < 32; i += 1) await login('admin', 'wrong-password-x', `198.51.100.${i}`);
  // A brand-new address that has never signed in to this account is refused,
  // even with the right password (it has no trust to lean on)…
  const stranger = await login('admin', 'correct-horse-9', '192.0.2.200');
  assert.equal(stranger.status, 429);
});

test('an address that recently signed in is trusted past the account-wide ceiling', async () => {
  const home = await login('admin', 'correct-horse-9', '203.0.113.9');
  assert.equal(home.status, 200);
  for (let i = 0; i < 40; i += 1) await login('admin', 'wrong-password-x', `198.51.100.${i}`);
  const again = await login('admin', 'correct-horse-9', '203.0.113.9');
  assert.equal(again.status, 200, 'the usual network is not locked out by strangers');
});

test('a successful login forgives only its own address, never a stranger\'s strikes', async () => {
  await strike('rohit.verma', '198.51.100.7', 7);
  const owner = await login('rohit.verma', 'candidate-pw-9', '203.0.113.9');
  assert.equal(owner.status, 200);
  // The attacker's bucket is untouched: one more strike and that address is out.
  await strike('rohit.verma', '198.51.100.7', 1);
  const attacker = await login('rohit.verma', 'candidate-pw-9', '198.51.100.7');
  assert.equal(attacker.status, 429);
});

test('the throttle keys are per username: strikes against one account do not touch another', async () => {
  await strike('admin', '10.0.0.1', 8);
  const other = await login('rohit.verma', 'candidate-pw-9', '10.0.0.1');
  assert.equal(other.status, 200);
});

test('a transport that supplies no address falls back to the per-username rule', async () => {
  await strike('admin', undefined, 8);
  const blocked = await login('admin', 'correct-horse-9', undefined);
  assert.equal(blocked.status, 429);
  const elsewhere = await login('admin', 'correct-horse-9', '203.0.113.9');
  assert.equal(elsewhere.status, 200);
});

test('the Netlify wrapper hands the platform client address to the throttle', async () => {
  const { clientIp } = await import('../netlify/functions/api.mjs');
  assert.equal(clientIp({ headers: { 'x-nf-client-connection-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1, 203.0.113.9' } }), '203.0.113.9');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } }), '198.51.100.7');
  assert.equal(clientIp({ headers: {} }), '');
  assert.equal(clientIp({}), '');
});
