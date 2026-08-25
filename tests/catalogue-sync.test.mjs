import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { MAX_ASSESSMENT_QUESTIONS } from '../src/core/constants.mjs';
import { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS } from '../src/content/rsa-catalogue.mjs';

/**
 * The published-catalogue sync: a workspace whose RSA bank predates the
 * expanded catalogue (21 questions — the original compact seed) must be able
 * to top the bank up from inside the app so assessments can actually use the
 * full 50-question allocation cap.
 */

async function buildStore({ questions = RSA_QUESTIONS.slice(0, 21), competencies = RSA_COMPETENCIES } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-catalogue-sync-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const role = await store.insert('roles', { ...RSA_ROLE, active: true });
  const compIds = {};
  for (const c of competencies) {
    const rec = await store.insert('competencies', { ...c, role_id: role.id, active: true });
    compIds[c.key] = rec.id;
  }
  for (const q of questions) {
    await store.insert('questions', {
      role_id: role.id, competency_id: compIds[q.competency], type: q.type, prompt: q.prompt,
      help_text: q.help_text || '', options: q.options || [], correct_option_ids: q.correct_option_ids || [],
      points: q.points, difficulty: q.difficulty, rubric: q.rubric || '', order: q.order, active: true,
    });
  }
  await store.insert('users', {
    username: 'sync-admin', name: 'Sync Admin', role: 'admin',
    password_hash: hashPassword('sync-admin-pass'), active: true,
  });
  await store.insert('users', {
    username: 'sync-assessor', name: 'Sync Assessor', role: 'assessor',
    password_hash: hashPassword('sync-assessor-pass'), active: true,
  });
  return { store, role };
}

async function adminClient(app, username = 'sync-admin', password = 'sync-admin-pass') {
  const res = await app({ method: 'POST', path: '/auth/login', body: { username, password } });
  assert.equal(res.status, 200);
  const token = res.body.token;
  return (method, reqPath, body, query) =>
    app({ method, path: reqPath, body, query, headers: { authorization: `Bearer ${token}` } });
}

test('catalogue status reports what a small bank is missing', async () => {
  const { store, role } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  const status = await call('GET', '/admin/content/catalogue');
  assert.equal(status.status, 200);
  assert.equal(status.body.available, true);
  assert.equal(status.body.role.id, role.id);
  assert.equal(status.body.bank_total, 21);
  assert.equal(status.body.catalogue_total, RSA_QUESTIONS.length);
  assert.equal(status.body.missing, RSA_QUESTIONS.length - 21);
});

test('catalogue endpoints are admin-only', async () => {
  const { store } = await buildStore();
  const app = await createApp(store);
  const asAssessor = await adminClient(app, 'sync-assessor', 'sync-assessor-pass');

  assert.equal((await asAssessor('GET', '/admin/content/catalogue')).status, 403);
  assert.equal((await asAssessor('POST', '/admin/content/sync')).status, 403);
  assert.equal((await app({ method: 'GET', path: '/admin/content/catalogue' })).status, 401);
});

test('sync tops a 21-question bank up to the published catalogue', async () => {
  const { store, role } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  // The question-plan preview exposes the same catalogue context the UI uses.
  const plan = await call('GET', `/admin/roles/${role.id}/question-plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.bank_total, 21);
  assert.equal(plan.body.catalogue.total, RSA_QUESTIONS.length);
  assert.equal(plan.body.catalogue.missing, RSA_QUESTIONS.length - 21);

  const synced = await call('POST', '/admin/content/sync');
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.added, RSA_QUESTIONS.length - 21);
  assert.equal(synced.body.bank_total, RSA_QUESTIONS.length);

  // After the top-up the plan honours the full 50-question cap.
  const capped = await call('GET', `/admin/roles/${role.id}/question-plan`, undefined, { limit: 50 });
  assert.equal(capped.status, 200);
  assert.equal(capped.body.total, MAX_ASSESSMENT_QUESTIONS);
  assert.equal(capped.body.bank_total, RSA_QUESTIONS.length);
  assert.equal(capped.body.catalogue.missing, 0);

  // Sync is idempotent: nothing is added a second time.
  const again = await call('POST', '/admin/content/sync');
  assert.equal(again.status, 200);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.bank_total, RSA_QUESTIONS.length);

  // The action is audited.
  const events = await store.list('audit_log');
  assert.ok(events.some((e) => e.action === 'catalogue_synced'), 'catalogue_synced audit entry exists');
});

test('a 50-question allocation succeeds after syncing a 21-question bank', async () => {
  const { store, role } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  // Before the sync the 50-question cap is unreachable: the bank is smaller.
  const stuck = await store.insert('candidates', { name: 'Stuck At 21', active: true });
  const blocked = await call('POST', '/admin/assessments', {
    candidate_id: stuck.id, role_id: role.id, question_count: MAX_ASSESSMENT_QUESTIONS,
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /only has 21 active question/);

  await call('POST', '/admin/content/sync');

  const candidate = await store.insert('candidates', { name: 'Full Cap Candidate', active: true });
  const allocated = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id, question_count: MAX_ASSESSMENT_QUESTIONS,
  });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  assert.equal(allocated.body.snapshot_json.questions.length, MAX_ASSESSMENT_QUESTIONS);
  assert.equal(allocated.body.snapshot_json.question_limit, MAX_ASSESSMENT_QUESTIONS);
});

test('sync never duplicates, reactivates or touches existing records', async () => {
  const { store, role } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  // An admin-deactivated published question must stay inactive and single.
  const questions = await store.list('questions', { role_id: role.id });
  const victim = questions[0];
  await store.update('questions', victim.id, { active: false });

  // An existing assessment snapshot must stay frozen through the sync.
  const candidate = await store.insert('candidates', { name: 'Frozen Snapshot', active: true });
  const allocated = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id, question_count: 5,
  });
  assert.equal(allocated.status, 201);
  const frozen = JSON.stringify(allocated.body.snapshot_json);

  await call('POST', '/admin/content/sync');

  const after = await store.list('questions', { role_id: role.id });
  assert.equal(after.length, RSA_QUESTIONS.length, 'bank grows to the catalogue size exactly');
  const samePrompt = after.filter((q) => q.prompt === victim.prompt);
  assert.equal(samePrompt.length, 1, 'no duplicate of the deactivated question');
  assert.equal(samePrompt[0].active, false, 'deactivated question stays deactivated');

  const stored = await store.get('assessments', allocated.body.id);
  assert.equal(JSON.stringify(stored.snapshot_json), frozen, 'existing snapshot untouched');
});

test('sync creates competencies the published questions need', async () => {
  // A bank that is missing an entire competency (e.g. an older catalogue cut).
  const firstFive = RSA_COMPETENCIES.slice(0, 5);
  const { store } = await buildStore({
    competencies: firstFive,
    questions: RSA_QUESTIONS.filter((q) => firstFive.some((c) => c.key === q.competency)),
  });
  const app = await createApp(store);
  const call = await adminClient(app);

  const synced = await call('POST', '/admin/content/sync');
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.competencies_added, 2);
  assert.equal(synced.body.bank_total, RSA_QUESTIONS.length);
});

test('sync reports clearly when no track matches the catalogue', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-catalogue-none-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  await store.insert('roles', { key: 'some-other-track', name: 'Other', active: true });
  await store.insert('users', {
    username: 'plain-admin', name: 'Plain Admin', role: 'admin',
    password_hash: hashPassword('plain-admin-pass'), active: true,
  });
  const app = await createApp(store);
  const call = await adminClient(app, 'plain-admin', 'plain-admin-pass');

  const status = await call('GET', '/admin/content/catalogue');
  assert.equal(status.status, 200);
  assert.equal(status.body.available, false);

  const synced = await call('POST', '/admin/content/sync');
  assert.equal(synced.status, 400);
  assert.match(synced.body.error, /No active track matches the published catalogue/i);
});

test('question-plan omits catalogue context for unrelated roles', async () => {
  const { store } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);
  const other = await store.insert('roles', { key: 'snowflake-rsa', name: 'Other track', active: true });

  const plan = await call('GET', `/admin/roles/${other.id}/question-plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.catalogue, null);
});
