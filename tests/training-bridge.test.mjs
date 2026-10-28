import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';

/**
 * The Training Dashboard forwards the administrator's own token to the
 * learning platform. These pin the ECOD side of that bridge; the full
 * round trip is pinned by Anthroprime-LMS tests/training-eod.test.mjs.
 */
function withLms(t, url, fetcher) {
  const oldUrl = process.env.LMS_WEB_URL;
  const oldFetch = globalThis.fetch;
  if (url === undefined) delete process.env.LMS_WEB_URL; else process.env.LMS_WEB_URL = url;
  const calls = [];
  globalThis.fetch = async (target, options) => { calls.push({ target: String(target), options }); return fetcher(target, options); };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.LMS_WEB_URL; else process.env.LMS_WEB_URL = oldUrl;
  });
  return calls;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('training bridge: forwards only to LMS_WEB_URL with the admin token in a header and redirects refused', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  const calls = withLms(t, 'https://learn.example', async () => json(200, { candidates: [], courses: [] }));
  const r = await w.call('GET', '/admin/training', { token: w.tok });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { candidates: [], courses: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 'https://learn.example/api/integration/training');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${w.tok}`);
  assert.doesNotMatch(calls[0].target, new RegExp(w.tok), 'the token never travels in a URL');
});

test('training bridge: candidates and assessors are refused before anything is forwarded', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  const candidate = await w.candidateUser('bridge.candidate', { allocate: false });
  const calls = withLms(t, 'https://learn.example', async () => json(200, {}));
  for (const [method, route, body] of [['GET', '/admin/training'], ['POST', '/admin/training/invitations', { email: 'x@example.test' }], ['POST', '/admin/training/assign', { kind: 'course', id: 'c1', candidate_id: 'k1' }]]) {
    assert.equal((await w.call(method, route, { token: candidate.token, body })).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('training bridge: not configured, LMS down, unreadable or rejecting responses are explained without signing ECOD out', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  withLms(t, undefined, async () => json(200, {}));
  const missing = await w.call('GET', '/admin/training', { token: w.tok });
  assert.equal(missing.status, 409, 'not configured is a deployment state, not an outage');
  assert.match(missing.body.error, /LMS_WEB_URL/);

  process.env.LMS_WEB_URL = 'http://learn.example'; // plain http off loopback is never used
  assert.equal((await w.call('GET', '/admin/training', { token: w.tok })).status, 409);

  let reply = async () => { throw new Error('offline'); };
  process.env.LMS_WEB_URL = 'https://learn.example';
  globalThis.fetch = async (...args) => reply(...args);
  assert.equal((await w.call('GET', '/admin/training', { token: w.tok })).status, 503);
  reply = async () => new Response('<html>gateway</html>', { status: 502 });
  assert.equal((await w.call('GET', '/admin/training', { token: w.tok })).status, 503);
  reply = async () => json(401, { error: 'Sign in with your EOD account to continue.' });
  const rejected = await w.call('GET', '/admin/training', { token: w.tok });
  assert.equal(rejected.status, 502, 'an LMS 401 must not look like an expired ECOD session');
  reply = async () => json(409, { error: 'Training assignment needs exactly one active ECOD candidate account.' });
  const conflict = await w.call('POST', '/admin/training/assign', { token: w.tok, body: { kind: 'course', id: 'course-1', candidate_id: 'cand-1' } });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /exactly one active/);
  assert.equal((await w.call('GET', '/auth/me', { token: w.tok })).status, 200, 'the ECOD session survives every failure above');
});

test('training bridge: input is validated before forwarding and successful changes are audited', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  const calls = withLms(t, 'https://learn.example', async (target, options) => {
    if (String(target).endsWith('/invitations')) return json(200, { invitation: { id: 'inv-1', email: JSON.parse(options.body).email } });
    return json(200, { ok: true });
  });
  assert.equal((await w.call('POST', '/admin/training/invitations', { token: w.tok, body: { email: 'not-an-email' } })).status, 400);
  assert.equal((await w.call('PUT', '/admin/training/invitations/inv-1', { token: w.tok, body: { status: 'deleted' } })).status, 400);
  assert.equal((await w.call('POST', '/admin/training/assign', { token: w.tok, body: { kind: 'course', id: '../x', candidate_id: 'k' } })).status, 400);
  assert.equal(calls.length, 0, 'invalid input is never forwarded');
  assert.equal((await w.call('POST', '/admin/training/invitations', { token: w.tok, body: { email: ' Person@Example.test ' } })).status, 200);
  assert.equal(JSON.parse(calls[0].options.body).email, 'Person@Example.test');
  // The real LMS server refuses writes without its origin and request marker.
  assert.equal(calls[0].options.headers.origin, 'https://learn.example');
  assert.equal(calls[0].options.headers['x-lms-request'], '1');
  assert.equal((await w.call('PUT', '/admin/training/invitations/inv-1', { token: w.tok, body: { status: 'revoked' } })).status, 200);
  assert.equal(calls[1].target, 'https://learn.example/api/integration/training/invitations/inv-1');
  const actions = (await w.store.list('audit_log')).map((a) => a.action);
  assert.ok(actions.includes('training_invited'));
  assert.ok(actions.includes('training_revoked'));
});
