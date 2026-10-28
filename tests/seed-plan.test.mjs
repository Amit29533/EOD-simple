import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPlan, DEMO_USERS } from '../scripts/seed-content.mjs';

test('seed plan: demo accounts only in the local JSON store or with an explicit opt-in', () => {
  assert.deepEqual(seedPlan({ kind: 'json-file' }), { mode: 'demo' });
  assert.deepEqual(seedPlan({ kind: 'airtable', env: { SEED_DEMO: '1' } }), { mode: 'demo' });
  assert.deepEqual(seedPlan({ kind: 'netlify-blobs', env: { SEED_DEMO: 'true' } }).mode, undefined, 'only the exact opt-in value counts');
});

test('seed plan: a real backend refuses the published demo passwords and needs SEED_ADMIN_PASSWORD', () => {
  for (const kind of ['airtable', 'netlify-blobs']) {
    const refused = seedPlan({ kind, env: {} });
    assert.match(refused.error, /SEED_ADMIN_PASSWORD/);
    assert.match(seedPlan({ kind, env: { SEED_ADMIN_PASSWORD: 'short' } }).error, /12-200/);
  }
  const plan = seedPlan({ kind: 'netlify-blobs', env: { SEED_ADMIN_PASSWORD: 'a-long-private-passphrase', SEED_ADMIN_USERNAME: ' Owner ', SEED_ADMIN_EMAIL: 'owner@example.test' } });
  assert.equal(plan.mode, 'admin');
  assert.equal(plan.admin.username, 'owner');
  assert.equal(plan.admin.role, 'admin');
  assert.equal(plan.admin.email, 'owner@example.test');
  assert.ok(!DEMO_USERS.some((u) => u.password === plan.admin.password), 'the administrator never gets a published password');
});
