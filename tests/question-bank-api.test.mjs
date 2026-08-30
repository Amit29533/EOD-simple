import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

/** The module-structured Question Bank v1.2 endpoints, over the real app. */

let app, store, adminToken, candidateToken;
const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-qb-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);

  const mk = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mk({ username: 'admin', password: 'pw-admin', name: 'Admin', role: 'admin', email: '' });
  const candidate = await store.insert('candidates', { name: 'Cand', stage: 'intake' });
  await mk({
    username: 'cand', password: 'pw-cand', name: 'Cand', role: 'candidate',
    email: '', candidate_id: candidate.id,
  });

  adminToken = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'pw-admin' } })).body.token;
  candidateToken = (await call('POST', '/auth/login', { body: { username: 'cand', password: 'pw-cand' } })).body.token;
});

test('bootstrap publishes the families, modules and paper structure', async () => {
  const res = await call('GET', '/meta/bootstrap');
  assert.equal(res.status, 200);
  assert.equal(res.body.modules.length, 21);
  assert.equal(res.body.moduleGroups.length, 5);
  assert.equal(res.body.families.length, 63);
  assert.equal(res.body.moduleTestStructure.total, 51);
  assert.equal(res.body.moduleTestStructure.technical_objective, 3);
  assert.equal(res.body.moduleTestStructure.non_technical_open, 1);
});

test('module listing reports every module with its counts', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.version, '1.2');
  assert.equal(res.body.modules.length, 21);
  assert.equal(res.body.bank_total, 348);
  assert.equal(res.body.blueprint.total, 51);

  const mandatory = res.body.modules.filter((m) => m.mandatory);
  assert.equal(mandatory.length, 1);
  assert.equal(mandatory[0].key, 'M00');

  for (const m of res.body.modules.filter((x) => !x.mandatory)) {
    assert.ok(m.objective >= 10, `${m.key} has ${m.objective} objective`);
  }
});

test('modules are grouped, and each carries its own families', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const groups = new Set(res.body.groups.map((g) => g.key));
  for (const m of res.body.modules) {
    assert.ok(groups.has(m.group), `${m.key} -> ${m.group}`);
    assert.ok(Array.isArray(m.families) && m.families.length >= 1, `${m.key} families`);
    for (const f of m.families) assert.ok(f.id.startsWith(`${m.key}:`), f.id);
  }
  assert.equal(res.body.modules.filter((m) => m.technical).length, 10);
  assert.equal(res.body.family_total, 63);
});

test('a family endpoint returns just that family\'s questions', async () => {
  const res = await call('GET', '/admin/question-bank/families/T05:cost-finops', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.family.module, 'T05');
  assert.equal(res.body.family.name, 'Cost & FinOps');
  assert.ok(res.body.questions.length >= 1);

  const missing = await call('GET', '/admin/question-bank/families/T05:nope', { token: adminToken });
  assert.equal(missing.status, 404);
});

test('the optional pool is reported separately from the primary bank', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  assert.equal(res.body.optional.total, 115);
  // Primary counts must not include optional questions.
  const total = res.body.modules.reduce((n, m) => n + m.objective + m.open, 0);
  assert.equal(total, 348);
});

test('the plan confirms every module can meet its quota', async () => {
  const res = await call('GET', '/admin/question-bank/plan', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  assert.equal(res.body.optional_total, 115);
  for (const row of res.body.modules) assert.ok(row.sufficient, row.module);
});

test('a previewed paper matches the required structure', async () => {
  const res = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.warnings, []);
  assert.equal(res.body.counts.total, 51);
  assert.equal(res.body.counts.mandatory, 1);
  assert.equal(res.body.counts.technical_objective, 30);
  assert.equal(res.body.counts.technical_open, 10);
  assert.equal(res.body.counts.non_technical_open, 10);
  assert.equal(res.body.questions.length, 51);
  assert.equal(res.body.questions[0].mandatory, true);
  assert.equal(res.body.counts.from_optional, 0);
});

test('two previews differ in content but never in structure', async () => {
  const a = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  const b = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  assert.deepEqual(a.body.counts, b.body.counts);
  const idsA = a.body.questions.map((q) => q.id).join(',');
  const idsB = b.body.questions.map((q) => q.id).join(',');
  assert.notEqual(idsA, idsB);
});

test('the mandatory question is first in every preview', async () => {
  for (let i = 0; i < 5; i += 1) {
    const res = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
    assert.equal(res.body.questions[0].mandatory, true);
    assert.equal(res.body.questions.filter((q) => q.mandatory).length, 1);
  }
});

test('question-bank endpoints are admin-only', async () => {
  for (const [method, p] of [
    ['GET', '/admin/question-bank/modules'],
    ['GET', '/admin/question-bank/plan'],
    ['POST', '/admin/question-bank/preview'],
    ['GET', '/admin/question-bank/families/T05:cost-finops'],
  ]) {
    assert.equal((await call(method, p)).status, 401, `${p} anonymous`);
    assert.equal((await call(method, p, { token: candidateToken })).status, 403, `${p} candidate`);
  }
});

// ---------------------------------------------------------------------------
// Regression tests: the API's own numbers must agree with each other.
//
// The module tree and the family drill-down are separate code paths over the
// same bank, and they used to disagree — M00 advertised a family holding one
// open question while the drill-down for that family returned nothing.
// ---------------------------------------------------------------------------

test('every family row agrees with its own drill-down', async () => {
  const list = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  for (const m of list.body.modules) {
    for (const f of m.families) {
      const res = await call('GET', `/admin/question-bank/families/${f.id}`, { token: adminToken });
      assert.equal(res.status, 200, f.id);
      const rows = res.body.questions;
      assert.equal(rows.length, f.objective + f.open, `${f.id} count`);
      assert.equal(rows.filter((q) => q.type === 'objective').length, f.objective, `${f.id} objective`);
      assert.equal(rows.filter((q) => q.type === 'open').length, f.open, `${f.id} open`);
    }
  }
});

test('a module total equals the sum of its families', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  for (const m of res.body.modules) {
    const objective = m.families.reduce((n, f) => n + f.objective, 0);
    const open = m.families.reduce((n, f) => n + f.open, 0);
    assert.equal(objective, m.objective, `${m.key} objective`);
    assert.equal(open, m.open, `${m.key} open`);
  }
});

test('the mandatory module reports the question it always serves', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const m00 = res.body.modules.find((m) => m.mandatory);
  assert.equal(m00.objective + m00.open, 1, 'the mandatory module is not empty');

  const family = m00.families[0];
  const drill = await call('GET', `/admin/question-bank/families/${family.id}`, { token: adminToken });
  assert.equal(drill.body.questions.length, 1);
  assert.equal(drill.body.questions[0].mandatory, true);
});

test('?include_optional accepts the flag spellings a URL actually carries', async () => {
  const base = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const withOptional = base.body.modules.reduce((n, m) => n + (m.optional || 0), 0);
  assert.equal(withOptional, 0, 'optional questions leaked into the default view');

  for (const flag of ['1', 'true', 'yes', 'on']) {
    const res = await call('GET', '/admin/question-bank/modules', {
      token: adminToken, query: { include_optional: flag },
    });
    const total = res.body.modules.reduce((n, m) => n + (m.optional || 0), 0);
    assert.equal(total, 115, `include_optional=${flag}`);
  }
  for (const flag of ['0', 'false', '']) {
    const res = await call('GET', '/admin/question-bank/modules', {
      token: adminToken, query: { include_optional: flag },
    });
    const total = res.body.modules.reduce((n, m) => n + (m.optional || 0), 0);
    assert.equal(total, 0, `include_optional=${flag}`);
  }
});

test('the paper-wide blueprint matches the published per-module quotas', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const { blueprint, technical_modules, non_technical_modules } = res.body;
  assert.equal(technical_modules, 10);
  assert.equal(non_technical_modules, 10);
  assert.equal(blueprint.technical_objective % technical_modules, 0);
  assert.equal(blueprint.technical_objective / technical_modules, 3);
  assert.equal(blueprint.technical_open / technical_modules, 1);
  assert.equal(blueprint.non_technical_open / non_technical_modules, 1);
});
