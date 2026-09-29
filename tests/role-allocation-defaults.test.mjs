import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

let app, store, token, roles;
const call = (method, route, { body, query } = {}) => app({
  method, path: route, body, query,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const csv = (rows) => rows.map((row) => row.join(',')).join('\n');

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-role-defaults-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', email: '', active: true,
    password_hash: hashPassword('admin-pass-123'),
  });
  token = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'admin-pass-123' } })).body.token;
  for (const role_key of ['databricks-rsa', 'databricks-ai-bi-genie', 'technology-risk-sama']) {
    const installed = await call('POST', '/admin/content/tracks', { body: { role_key } });
    assert.equal(installed.status, 201, JSON.stringify(installed.body));
  }
  roles = (await call('GET', '/admin/roles')).body.roles;
});

function assertSamaPaper(paper) {
  assert.equal(paper.questions.length, 30);
  assert.equal(paper.questions.filter((q) => q.type === 'text').length, 5);
  assert.equal(paper.questions.filter((q) => q.type === 'mcq_single').length, 25);
  const byCompetency = new Map();
  for (const q of paper.questions) byCompetency.set(q.competency_id, (byCompetency.get(q.competency_id) || 0) + 1);
  assert.equal(byCompetency.size, 10);
  assert.ok([...byCompetency.values()].every((count) => count === 3), 'each SAMA module receives three questions');
  const keyById = new Map(paper.competencies.map((comp) => [comp.id, comp.key]));
  const openByKey = new Map();
  for (const q of paper.questions.filter((row) => row.type === 'text')) {
    const key = keyById.get(q.competency_id);
    openByKey.set(key, (openByKey.get(key) || 0) + 1);
  }
  assert.deepEqual([...openByKey.entries()].sort(), [
    ['findings-remediation', 1],
    ['infrastructure-secops', 1],
    ['resilience-recovery', 1],
    ['risk-control-assessment', 1],
    ['sama-csf-regulatory', 1],
  ]);
}

test('published and legacy roles expose the correct effective automatic defaults', async () => {
  const byKey = Object.fromEntries(roles.map((role) => [role.key, role]));
  assert.equal(byKey['databricks-rsa'].default_question_count, 50);
  assert.equal(byKey['databricks-ai-bi-genie'].default_question_count, 50);
  assert.equal(byKey['technology-risk-sama'].default_question_count, 30);

  // A pre-feature SAMA row has no stored field. The stable role-key fallback
  // must still make the production migration effective before an admin saves.
  await store.update('roles', byKey['technology-risk-sama'].id, { default_question_count: undefined });
  const detail = await call('GET', `/admin/roles/${byKey['technology-risk-sama'].id}`);
  assert.equal(detail.body.role.default_question_count, 30);
});

test('Roles & frameworks creates, edits and validates a per-role default', async () => {
  const made = await call('POST', '/admin/roles', { body: {
    key: 'custom-track', name: 'Custom Track', technology: 'General', default_question_count: 12,
  } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.default_question_count, 12);

  const patched = await call('PATCH', `/admin/roles/${made.body.id}`, { body: { default_question_count: 18 } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.default_question_count, 18);

  for (const invalid of [0, 51, 2.5, 'many']) {
    const refused = await call('PATCH', `/admin/roles/${made.body.id}`, { body: { default_question_count: invalid } });
    assert.equal(refused.status, 400, `accepted invalid default ${invalid}`);
  }
});

test('single-user SAMA auto allocation uses 30 questions with its exact 25/5 blueprint', async () => {
  const sama = roles.find((role) => role.key === 'technology-risk-sama');
  const candidate = await store.insert('candidates', {
    name: 'SAMA Single', stage: 'intake', target_role_id: sama.id,
  });
  const made = await call('POST', '/admin/users', { body: {
    username: 'sama.single', name: 'SAMA Single', role: 'candidate',
    password: 'candidate-pass-123', candidate_id: candidate.id,
  } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.auto_allocation.question_count, 30);
  const assessment = await store.get('assessments', made.body.auto_allocation.assessment_id);
  assert.equal(assessment.question_limit, 30);
  assertSamaPaper(assessment.snapshot_json);
});

test('CSV auto allocation resolves each row against its own role default', async () => {
  const file = csv([
    ['Name', 'Email', 'Target role', 'Username', 'Password'],
    ['RSA CSV', 'rsa.csv@example.com', 'Resident Solutions Architect (RSA)', 'rsa.csv', 'Candidate-pass-123'],
    ['AI CSV', 'ai.csv@example.com', 'Senior Databricks AI/BI & Genie Consultant', 'ai.csv', 'Candidate-pass-123'],
    ['SAMA CSV', 'sama.csv@example.com', 'Technology Risk Consultant - SAMA', 'sama.csv', 'Candidate-pass-123'],
  ]);
  const dry = await call('POST', '/admin/candidates/import', { body: {
    csv: file, filename: 'mixed.csv', dry_run: true, create_users: true, auto_allocate: true,
  } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.would_auto_allocate, 3);

  const committed = await call('POST', '/admin/candidates/import', { body: {
    csv: file, filename: 'mixed.csv', dry_run: false, create_users: true, auto_allocate: true,
  } });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const counts = Object.fromEntries(committed.body.auto_allocations.map((row) => [row.username, row.question_count]));
  assert.deepEqual(counts, { 'rsa.csv': 50, 'ai.csv': 50, 'sama.csv': 30 });
  const samaRow = committed.body.auto_allocations.find((row) => row.username === 'sama.csv');
  assertSamaPaper((await store.get('assessments', samaRow.assessment_id)).snapshot_json);
});

test('SAMA automatic allocation refuses a bank that cannot fill its blueprint', async () => {
  const sama = roles.find((role) => role.key === 'technology-risk-sama');
  const comps = await store.list('competencies', { role_id: sama.id });
  const first = comps.find((comp) => comp.key === 'sama-csf-regulatory');
  const open = (await store.list('questions', { role_id: sama.id }))
    .filter((q) => q.competency_id === first.id && q.type === 'text');
  for (const q of open) await store.update('questions', q.id, { active: false });
  const candidate = await store.insert('candidates', {
    name: 'SAMA Short', stage: 'intake', target_role_id: sama.id,
  });
  const made = await call('POST', '/admin/users', { body: {
    username: 'sama.short', name: 'SAMA Short', role: 'candidate',
    password: 'candidate-pass-123', candidate_id: candidate.id,
  } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.auto_allocation.allocated, false);
  assert.match(made.body.auto_allocation.reason, /cannot fill.*blueprint/i);
  assert.equal((await store.list('assessments', { candidate_id: candidate.id })).length, 0);
});
