import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { MAX_ASSESSMENT_QUESTIONS } from '../src/core/constants.mjs';
import { AIBI_ROLE, AIBI_COMPETENCIES, AIBI_QUESTIONS } from '../src/content/ai-bi-genie-catalogue.mjs';
import { SC_ROLE, SC_COMPETENCIES, SC_QUESTIONS } from '../src/content/senior-consultant-catalogue.mjs';
import { buildSnapshot } from '../src/api/assessment-service.mjs';

/**
 * The published Senior Databricks AI/BI & Genie Consultant catalogue (and the
 * Senior Consultant skeleton track): the same sync/allocate treatment as the
 * RSA catalogue, addressed by role key, with the RSA catalogue untouched as
 * the default.
 */

async function buildStore({ role = AIBI_ROLE, competencies = AIBI_COMPETENCIES, questions = AIBI_QUESTIONS.slice(0, 25) } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-ai-bi-catalogue-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const rec = await store.insert('roles', { ...role, active: true });
  const compIds = {};
  for (const c of competencies) {
    const r = await store.insert('competencies', { ...c, role_id: rec.id, active: true });
    compIds[c.key] = r.id;
  }
  for (const q of questions) {
    await store.insert('questions', {
      role_id: rec.id, competency_id: compIds[q.competency], type: q.type, prompt: q.prompt,
      help_text: q.help_text || '', options: q.options || [], correct_option_ids: q.correct_option_ids || [],
      points: q.points, difficulty: q.difficulty, rubric: q.rubric || '', order: q.order, active: true,
      audio_required: q.type === 'text',
    });
  }
  await store.insert('users', {
    username: 'sync-admin', name: 'Sync Admin', role: 'admin',
    password_hash: hashPassword('sync-admin-pass'), active: true,
  });
  return { store, role: rec };
}

async function adminClient(app, username = 'sync-admin', password = 'sync-admin-pass') {
  const res = await app({ method: 'POST', path: '/auth/login', body: { username, password } });
  assert.equal(res.status, 200);
  const token = res.body.token;
  return (method, reqPath, body, query) =>
    app({ method, path: reqPath, body, query, headers: { authorization: `Bearer ${token}` } });
}

test('the published AI/BI bank has the shape allocation expects', () => {
  // Derived one-for-one from the module bank: 60 objective + 40 open.
  const objective = AIBI_QUESTIONS.filter((q) => q.type === 'mcq_single');
  const open = AIBI_QUESTIONS.filter((q) => q.type === 'text');
  assert.equal(AIBI_QUESTIONS.length, 100);
  assert.equal(objective.length, 60);
  assert.equal(open.length, 40);
  assert.ok(objective.every((q) => q.options.length === 4), 'every MCQ carries its four workbook options');
  assert.ok(objective.every((q) => q.correct_option_ids.length === 1), 'every MCQ has exactly one key');
  assert.ok(open.every((q) => q.rubric.includes('Expected evidence:')), 'every open question scores against expected evidence');
  // No spoken set in this workbook: nothing is pinned or set-tagged.
  assert.ok(AIBI_QUESTIONS.every((q) => q.question_set === '' && q.pin_first === false));
  // Ten competencies, weights sum to 100, every question maps to one of them.
  assert.equal(AIBI_COMPETENCIES.length, 10);
  assert.equal(AIBI_COMPETENCIES.reduce((n, c) => n + c.weight, 0), 100);
  const keys = new Set(AIBI_COMPETENCIES.map((c) => c.key));
  assert.ok(AIBI_QUESTIONS.every((q) => keys.has(q.competency)));
  // Competency weights are the per-module apportionment: each module's 10
  // questions maps to its own competency.
  assert.equal(new Set(AIBI_QUESTIONS.map((q) => q.competency)).size, 10);
});

test('catalogue status reports what an AI/BI bank is missing, addressed by role key', async () => {
  const { store, role } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  const status = await call('GET', '/admin/content/catalogue', undefined, { role_key: AIBI_ROLE.key });
  assert.equal(status.status, 200);
  assert.equal(status.body.available, true);
  assert.equal(status.body.role.id, role.id);
  assert.equal(status.body.catalogue_total, AIBI_QUESTIONS.length);
  assert.equal(status.body.bank_total, 25);
  assert.equal(status.body.missing, AIBI_QUESTIONS.length - 25);

  // The default (no role key) is the RSA catalogue — untouched by the new tracks.
  const rsaDefault = await call('GET', '/admin/content/catalogue');
  assert.equal(rsaDefault.status, 200);
  assert.equal(rsaDefault.body.available, false, 'no RSA role exists in this store');
});

test('sync tops an AI/BI bank up to the published catalogue and is idempotent', async () => {
  const { store } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  const synced = await call('POST', '/admin/content/sync', { role_key: AIBI_ROLE.key });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.added, AIBI_QUESTIONS.length - 25);
  assert.equal(synced.body.bank_total, AIBI_QUESTIONS.length);

  const again = await call('POST', '/admin/content/sync', { role_key: AIBI_ROLE.key });
  assert.equal(again.status, 200);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.bank_total, AIBI_QUESTIONS.length);

  // The sync created nothing for the other tracks.
  assert.equal((await store.list('roles')).length, 1);
});

test('a 50-question AI/BI allocation covers every module competency', async () => {
  const { store, role } = await buildStore({ questions: AIBI_QUESTIONS });
  const app = await createApp(store);
  const call = await adminClient(app);

  const candidate = await store.insert('candidates', { name: 'AI/BI Candidate', stage: 'assessment' });
  const allocated = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id, question_count: MAX_ASSESSMENT_QUESTIONS,
  });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  const snap = allocated.body.snapshot_json;
  assert.equal(snap.questions.length, MAX_ASSESSMENT_QUESTIONS);
  assert.equal(snap.bank_total, AIBI_QUESTIONS.length);

  // Every one of the ten module competencies is represented (weighted split).
  const byComp = new Map(snap.competencies.map((c) => [c.id, 0]));
  for (const q of snap.questions) byComp.set(q.competency_id, (byComp.get(q.competency_id) || 0) + 1);
  assert.ok([...byComp.values()].every((n) => n > 0), 'no module competency scores zero');

  // The open questions in the frozen paper demand a recording and carry their
  // expected-evidence rubric; nothing is pinned (this bank has no spoken set).
  const open = snap.questions.filter((q) => q.type === 'text');
  assert.ok(open.length > 0);
  assert.ok(open.every((q) => q.audio_required === true));
  assert.ok(open.every((q) => q.rubric.length > 0));
  assert.ok(snap.questions.every((q) => q.pin_first !== true));

  // No prompt is asked twice in one paper.
  const prompts = snap.questions.map((q) => q.prompt);
  assert.equal(new Set(prompts).size, prompts.length);
});

test('the Senior Consultant track seeds a role and competencies, with an empty bank', async () => {
  const { store, role } = await buildStore({
    role: SC_ROLE, competencies: SC_COMPETENCIES, questions: SC_QUESTIONS,
  });
  const app = await createApp(store);
  const call = await adminClient(app);

  // Allocation is refused cleanly until the team authors the bank.
  const candidate = await store.insert('candidates', { name: 'SC Candidate', stage: 'assessment' });
  const blocked = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id,
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /no active questions/i);

  // The question-plan carries no catalogue top-up (the track has no published
  // questions yet), but the framework and competencies are in place.
  const plan = await call('GET', `/admin/roles/${role.id}/question-plan`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.catalogue, null);

  // A sync for the track is a no-op that still (re)creates any missing
  // competencies — the way the CLI seed heals a half-provisioned workspace.
  const synced = await call('POST', '/admin/content/sync', { role_key: SC_ROLE.key });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.bank_total, 0);
});

test('the senior consultant snapshot builder works once questions exist', async () => {
  // The track starts empty, but the moment the team authors questions the
  // same snapshot/scoring machinery runs — no per-role logic anywhere.
  const { store, role } = await buildStore({
    role: SC_ROLE, competencies: SC_COMPETENCIES, questions: SC_QUESTIONS,
  });
  const comp = SC_COMPETENCIES[0];
  await store.insert('questions', {
    role_id: role.id, competency_id: (await store.list('competencies', { role_id: role.id }))[0].id,
    type: 'mcq_single', prompt: 'Which access model best fits a shared Genie space?',
    help_text: '', options: [
      { id: 'a', label: 'Personal tokens per analyst' },
      { id: 'b', label: 'Group-based Unity Catalog grants with least privilege' },
      { id: 'c', label: 'A shared admin account' },
      { id: 'd', label: 'Storage keys in the workbook' },
    ],
    correct_option_ids: ['b'], points: 4, difficulty: 'intermediate', rubric: '',
    order: 1, active: true,
  });
  const snap = await buildSnapshot(store, role.id, { questionLimit: 1 });
  assert.equal(snap.questions.length, 1);
  assert.equal(snap.questions[0].type, 'mcq_single');
  assert.ok(comp.name.length > 0);
});
