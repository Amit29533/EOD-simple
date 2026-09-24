/**
 * Route guard matrix: every route the API registers, called as each kind of
 * caller (signed out, admin, assessor, candidate).
 *
 * The table is read from the live router (registerRoutes), so a route added
 * later is covered automatically, and the policy test fails if it is added
 * with a guard that does not match its prefix. Objects a role may not reach
 * inside its own area (another assessor's paper, another candidate's exam)
 * are covered by the pov-assessor, pov-candidate and journey suites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../src/api/router.mjs';
import { makeWorld } from './helpers/world.mjs';

const ROUTES = registerRoutes();
const PUBLIC = ['POST /auth/login', 'GET /meta/bootstrap', 'GET /health'];
const ANY_SIGNED_IN = ['POST /auth/logout', 'GET /auth/me'];
const sig = (r) => `${r.method} ${r.pattern}`;
const concrete = (pattern) => pattern.replace(/:[a-z_]+/g, 'rec_doesnotexist0000');

test('policy: every route\'s guard follows its prefix, and the open routes are exactly the expected few', () => {
  assert.ok(ROUTES.length >= 60, `the live table (${ROUTES.length} routes)`);
  const seen = new Set();
  for (const r of ROUTES) {
    assert.ok(!seen.has(sig(r)), `${sig(r)} is registered once`);
    seen.add(sig(r));
    if (r.pattern.startsWith('/admin/')) assert.deepEqual(r.roles, ['admin'], sig(r));
    else if (r.pattern.startsWith('/assessor/')) assert.deepEqual(r.roles, ['assessor'], sig(r));
    else if (r.pattern.startsWith('/candidate/')) assert.deepEqual(r.roles, ['candidate'], sig(r));
    else if (r.roles === 'public') assert.ok(PUBLIC.includes(sig(r)), `${sig(r)} is public: expected one of ${PUBLIC}`);
    else assert.ok(r.roles === null && ANY_SIGNED_IN.includes(sig(r)), `${sig(r)} has an unexpected guard ${JSON.stringify(r.roles)}`);
  }
  assert.deepEqual(ROUTES.filter((r) => r.roles === 'public').map(sig).sort(), [...PUBLIC].sort());
  assert.deepEqual(ROUTES.filter((r) => r.roles === null).map(sig).sort(), [...ANY_SIGNED_IN].sort());
});

test('matrix: signed-out callers get 401 and wrong roles get 403 on every guarded route', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 1 });
  const cand = await w.candidateUser('matrix.cand');
  const assessor = await w.assessorUser('matrix.assessor');
  const tokens = { admin: w.tok, assessor: assessor.token, candidate: cand.token };

  let checked = 0;
  for (const r of ROUTES) {
    if (r.roles === 'public' || sig(r) === 'POST /auth/logout') continue;
    const path = concrete(r.pattern);
    const anon = await w.call(r.method, path, { body: {} });
    assert.equal(anon.status, 401, `${sig(r)} signed out -> ${anon.status}`);
    const allowed = r.roles || Object.keys(tokens);
    for (const [role, token] of Object.entries(tokens)) {
      const res = await w.call(r.method, path, { token, body: {} });
      if (allowed.includes(role)) {
        assert.ok(![401, 403].includes(res.status), `${sig(r)} as ${role} is let through (got ${res.status})`);
        assert.ok(res.status < 500, `${sig(r)} as ${role} with junk input is a client error, not ${res.status}: ${JSON.stringify(res.body)}`);
      } else {
        assert.equal(res.status, 403, `${sig(r)} as ${role} -> ${res.status}`);
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 180, `checked ${checked} route x role pairs`);
  // Nothing above changed who is signed in.
  for (const token of Object.values(tokens)) assert.equal((await w.call('GET', '/auth/me', { token })).status, 200);
});

test('matrix: a forged or expired token is treated as signed out, never as a role', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  for (const token of ['forged-token', 'a'.repeat(64), `${w.tok}x`]) {
    for (const path of ['/admin/dashboard', '/assessor/assessments', '/candidate/assessments', '/auth/me']) {
      assert.equal((await w.call('GET', path, { token })).status, 401, `${path} with a bad token`);
    }
  }
  // Signing out ends that session only.
  const second = await w.login('admin', 'Admin-pass-123');
  assert.equal((await w.call('POST', '/auth/logout', { token: second })).status, 200);
  assert.equal((await w.call('GET', '/auth/me', { token: second })).status, 401);
  assert.equal((await w.call('GET', '/auth/me', { token: w.tok })).status, 200, 'the other admin session is untouched');
});

test('public routes answer signed out, and leak nothing a session would add', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  const health = await w.call('GET', '/health');
  assert.equal(health.status, 200);
  const meta = await w.call('GET', '/meta/bootstrap');
  assert.equal(meta.status, 200);
  assert.ok(Array.isArray(meta.body.pipelineStages) && meta.body.pipelineStages.length);
  const json = JSON.stringify(meta.body);
  assert.doesNotMatch(json, /password_hash|rec_[0-9a-f]{18}/, 'no records or secrets in the public bootstrap');
  const bad = await w.call('POST', '/auth/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.token, undefined);
});
