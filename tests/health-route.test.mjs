import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { APP_VERSION } from '../src/core/constants.mjs';
import { registerRoutes } from '../src/api/router.mjs';

/**
 * Health endpoint.
 *
 * The deployment probes both /api/health and a bare /health, and both must
 * report the *same* version the package declares — an earlier copy kept a
 * hand-written "0.1.0" in the response, which silently drifted the day the
 * package version moved. These tests pin the single source of truth and the
 * fact that the probe never requires a session (a monitoring agent has none).
 */

let app;
const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-health-'));
  app = await createApp(createJsonStore(path.join(tmp, 'db.json')));
});

test('GET /health answers without a session and reports the package version', async () => {
  const res = await call('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, APP_VERSION);

  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(res.body.version, pkg.version, '/health version must track package.json, not a literal');

  assert.ok(Number.isFinite(res.body.uptime) && res.body.uptime >= 0, 'uptime must be a non-negative number');
  assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)), 'timestamp must be a parseable ISO date');
});

test('the probe ignores a presented (even invalid) token and is registered as public', async () => {
  for (const token of [undefined, 'garbage.session.token']) {
    const res = await call('GET', '/health', { token });
    assert.equal(res.status, 200, `health must not depend on the presented token (got ${res.status})`);
  }
  // Public in the route table, so no guard can ever make the probe fail for a
  // load balancer that has no session.
  const routes = registerRoutes();
  const health = routes.find((r) => r.method === 'GET' && r.pattern === '/health');
  assert.ok(health, 'GET /health must be registered');
  assert.equal(health.roles, 'public', 'GET /health must bypass authentication');

  // The HTTP server aliases /api/health onto the same handler and enriches the
  // body; it must keep doing both without inventing its own version string.
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /\/api\/health/, 'server.mjs must keep the /api/health alias');
  assert.ok(!/'version:\s*'\d+\.\d+\.\d+'/.test(src), 'server.mjs must not hardcode a version literal');
});

test('the app-level payload stays operational metadata only (no secrets, no config)', async () => {
  const res = await call('GET', '/health');
  const keys = Object.keys(res.body).sort();
  assert.deepEqual(keys, ['ok', 'timestamp', 'uptime', 'version']);
  const json = JSON.stringify(res.body);
  for (const secret of ['password', 'hash', 'token', 'AIRTABLE', 'API_KEY', 'authorization']) {
    assert.ok(!json.toLowerCase().includes(secret.toLowerCase()), `health must not mention ${secret}`);
  }
});
