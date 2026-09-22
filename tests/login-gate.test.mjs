/**
 * Password verification is gated, process-wide.
 *
 * A scrypt verify is ~45 ms on Node's libuv threadpool — four threads, FIFO,
 * shared with every `fs.promises` call the server makes — and every sign-in
 * attempt costs one whether or not the account exists (the decoy hash keeps
 * the timing even). Left ungated, a burst of attempts queued hundreds of
 * scrypt jobs ahead of everything else: measured on the production-mode
 * server, a flood of made-up usernames from ONE address (the failed-login
 * throttle is per username, so it never engaged) took a genuine sign-in from
 * 54 ms to ~1 s and a static file from 11 ms to 2.7 s at p95. Two verifies
 * in flight leave two threads for the rest of the server; a bounded line
 * waits behind them and anything beyond it is refused at once with a 503.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createGate } from '../src/core/gate.mjs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { VERIFY_CONCURRENCY, VERIFY_MAX_WAITING, loginGateState, resetLoginThrottle } from '../src/api/handlers/auth.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await tick();
  return pred();
};

test('createGate runs `concurrency` jobs at once, queues the rest in order, and refuses beyond `maxWaiting`', async () => {
  const gate = createGate({ concurrency: 2, maxWaiting: 3 });
  const release = [];
  const order = [];
  const job = (id) => () => new Promise((resolve) => { order.push(`start ${id}`); release.push(() => { order.push(`end ${id}`); resolve(id); }); });
  const runs = [1, 2, 3, 4, 5].map((id) => gate.run(job(id)));
  assert.equal(gate.inFlight, 2);
  assert.equal(gate.waiting, 3);
  await assert.rejects(gate.run(job(6)), (err) => err.code === 'GATE_FULL', 'the sixth is refused at once, no slot taken');
  assert.equal(gate.waiting, 3);
  assert.deepEqual(order, ['start 1', 'start 2']);
  release.shift()();
  await tick();
  assert.deepEqual(order.slice(2), ['end 1', 'start 3'], 'FIFO: the first waiting job takes the freed slot');
  while (release.length) { release.shift()(); await tick(); }
  assert.deepEqual(await Promise.all(runs), [1, 2, 3, 4, 5]);
  assert.equal(gate.inFlight, 0);
  assert.equal(gate.waiting, 0);
});

test('a job that throws releases its slot', async () => {
  const gate = createGate({ concurrency: 1, maxWaiting: 1 });
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.inFlight, 0);
  assert.equal(await gate.run(async () => 'next'), 'next');
});

let app;
before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-gate-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'priya.nair', name: 'Priya', role: 'assessor', email: 'priya@example.com',
    password_hash: hashPassword('assessor-pw-9'), active: true,
  });
  resetLoginThrottle();
});

const login = (username, password, ip = '203.0.113.10') =>
  app({ method: 'POST', path: '/auth/login', body: { username, password }, headers: {}, ip });

test('a burst of sign-in attempts beyond the line is refused with a 503 at once; the rest, and a genuine sign-in, are served', async () => {
  const room = VERIFY_CONCURRENCY + VERIFY_MAX_WAITING; // fills every slot and the whole line
  const extra = 7;
  // Made-up usernames, one address: the per-username throttle never engages,
  // and each attempt would cost a scrypt verify against the decoy hash.
  const flood = Array.from({ length: room + extra }, (_, i) => login(`nobody-${i}`, 'x'));
  // The handler looks the account up before it reaches the gate; wait for
  // the line to fill, then fire one more while it is full.
  assert.ok(await until(() => loginGateState().waiting === VERIFY_MAX_WAITING), 'the line fills');
  assert.equal(loginGateState().inFlight, VERIFY_CONCURRENCY, 'only two verifies run at once');
  const genuineWhileFull = login('priya.nair', 'assessor-pw-9');

  const results = await Promise.all(flood);
  const byStatus = results.reduce((m, r) => m.set(r.status, (m.get(r.status) || 0) + 1), new Map());
  assert.equal(byStatus.get(503), extra, `the ${extra} attempts that found the line full are told to retry`);
  assert.equal(byStatus.get(401), room, 'everything with a slot or a place in line is verified and refused as a wrong password');
  const busy = results.find((r) => r.status === 503);
  assert.equal(busy.headers['retry-after'], '2');
  assert.match(busy.body.error, /busy/i);
  assert.equal((await genuineWhileFull).status, 503, 'so is a genuine sign-in that arrives to a full line — refused at once, not parked');

  const after = loginGateState();
  assert.deepEqual(after, { inFlight: 0, waiting: 0 }, 'the gate drains');
  const genuine = await login('priya.nair', 'assessor-pw-9');
  assert.equal(genuine.status, 200, JSON.stringify(genuine.body));
  assert.ok(genuine.body.token);
});

test('a room signing in together fits in the line: nobody is refused', async () => {
  resetLoginThrottle();
  const seats = Array.from({ length: 40 }, () => login('priya.nair', 'assessor-pw-9', '198.51.100.7'));
  const statuses = (await Promise.all(seats)).map((r) => r.status);
  assert.deepEqual([...new Set(statuses)], [200]);
});
