import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, hashPasswordAsync, hashPasswordsAsync, verifyPassword, verifyPasswordAsync, BULK_HASH_CONCURRENCY,
} from '../src/core/passwords.mjs';

test('sync and async hashes verify with either verifier', async () => {
  const a = hashPassword('correct horse');
  const b = await hashPasswordAsync('correct horse');
  assert.match(a, /^s2:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.match(b, /^s2:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.notEqual(a, b, 'a fresh salt every time');
  for (const h of [a, b]) {
    assert.equal(verifyPassword('correct horse', h), true);
    assert.equal(await verifyPasswordAsync('correct horse', h), true);
    assert.equal(verifyPassword('wrong', h), false);
    assert.equal(await verifyPasswordAsync('wrong', h), false);
  }
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPasswordAsync('x', null), false);
  assert.equal(await verifyPasswordAsync('x', 's2:abcd:zz'), false, 'a truncated digest never matches');
});

test('bulk hashing keeps results in order and never has more than the bound in flight', async () => {
  // The candidate import used to hash every row with one `Promise.all`,
  // which parks 2000 scrypt jobs on the 4-thread libuv pool ahead of every
  // other user's login for the length of the import. The bounded helper is
  // what keeps a bulk onboarding from turning into a site-wide login stall.
  const passwords = Array.from({ length: 9 }, (_, i) => `pw-${i}`);
  const hashes = await hashPasswordsAsync(passwords);
  assert.equal(hashes.length, 9);
  hashes.forEach((h, i) => assert.equal(verifyPassword(`pw-${i}`, h), true, `hash ${i} lines up with password ${i}`));
  assert.equal(new Set(hashes).size, 9);
  assert.deepEqual(await hashPasswordsAsync([]), []);
  assert.ok(BULK_HASH_CONCURRENCY >= 1 && BULK_HASH_CONCURRENCY <= 2, 'leaves threadpool room for logins');
});

test('a login is not starved while a bulk hash is running', async () => {
  // Measured, not asserted on exact numbers: with the bounded helper a
  // verify that arrives mid-import waits for at most a couple of scrypt
  // jobs, not for the whole batch. The unbounded version made a login wait
  // for every queued row (≈ the whole import) — seconds, not milliseconds.
  const stored = hashPassword('login-pw');
  const rows = Array.from({ length: 40 }, () => 'pw');
  const job = hashPasswordsAsync(rows);
  await new Promise((r) => setTimeout(r, 25));
  const t = Date.now();
  assert.equal(await verifyPasswordAsync('login-pw', stored), true);
  const waited = Date.now() - t;
  const all = await job;
  assert.equal(all.length, 40);
  // 40 unbounded jobs take ~700 ms+ on the pool; a login queued behind
  // at most BULK_HASH_CONCURRENCY jobs completes in a small fraction of that.
  assert.ok(waited < 600, `login waited ${waited} ms behind the bulk hash`);
});
