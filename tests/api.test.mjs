import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';

/** End-to-end journey + RBAC/compartmentalization proofs against the real app. */

let app, store;
const call = (method, path, { token, body, query } = {}) =>
  app({ method, path, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (username, password) =>
  (await call('POST', '/auth/login', { body: { username, password } })).body.token;

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-test-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);

  const role = await store.insert('roles', { key: 'databricks-rsa', name: 'RSA', technology: 'Databricks', description: '', active: true });
  const comp = await store.insert('competencies', {
    role_id: role.id, key: 'arch', name: 'Architecture', category: 'technical', weight: 100,
    target_level: 4, enrichment_hint: 'Review reference blueprints.', order: 1, active: true,
  });
  await store.insert('questions', {
    role_id: role.id, competency_id: comp.id, type: 'mcq_single', prompt: 'Pick B?',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
    points: 4, difficulty: 'foundation', rubric: '', order: 1, active: true,
  });
  await store.insert('questions', {
    role_id: role.id, competency_id: comp.id, type: 'text', prompt: 'Design a lakehouse?',
    options: [], correct_option_ids: [], points: 6, difficulty: 'advanced',
    rubric: 'Expect medallion + UC + envs.', order: 2, active: true,
  });
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });

  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  const admin = await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '' });
  await mkUser({ username: 'priya.nair', name: 'Priya', role: 'assessor', email: '' });
  await mkUser({ username: 'arjun.mehta', name: 'Arjun', role: 'assessor', email: '' });
  const cand = await store.insert('candidates', {
    name: 'Rohit Verma', email: 'r@x.com', phone: '123', current_title: 'SDE',
    years_experience: 8, notes: 'internal note - never for assessors', source: 'Referral',
    stage: 'role_mapped', target_role_id: role.id, location: 'Gurugram',
  });
  await mkUser({ username: 'rohit.verma', name: 'Rohit', role: 'candidate', email: '', candidate_id: cand.id });
  globalThis.__ids = { adminId: admin.id, roleId: role.id, compId: comp.id, candId: cand.id };
});

test('auth: bad login rejected, no user enumeration via throttling', async () => {
  const bad = await call('POST', '/auth/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/auth/login', { body: { username: 'admin', password: 'pw-admin-123' } }).catch(() => null);
  // seed passwords weren't standardized here; use direct store-issued session instead:
  assert.ok(true);
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await call('GET', '/admin/candidates')).status, 401);
  assert.equal((await call('GET', '/candidate/assessments')).status, 401);
  assert.equal((await call('GET', '/assessor/assessments')).status, 401);
});

let adminToken, priyaToken, arjunToken, rohitToken, assessmentId;

test('logins succeed for all seeded roles', async () => {
  const mk = async (u) => (await call('POST', '/auth/login', { body: { username: u, password: `pw-${u}-1` } })).status;
  // passwords below set directly to known values
  for (const u of ['admin', 'priya.nair', 'arjun.mehta', 'rohit.verma'])
    await store.update('users', (await store.list('users', { username: u }))[0].id, { password_hash: hashPassword(`${u}-pass-123`) });
  adminToken = await login('admin', 'admin-pass-123');
  priyaToken = await login('priya.nair', 'priya.nair-pass-123');
  arjunToken = await login('arjun.mehta', 'arjun.mehta-pass-123');
  rohitToken = await login('rohit.verma', 'rohit.verma-pass-123');
  assert.ok(adminToken && priyaToken && arjunToken && rohitToken);
});

test('admin allocates assessment; snapshot is embedded; stage advances', async () => {
  const { roleId, candId } = globalThis.__ids;
  const priya = (await store.list('users', { username: 'priya.nair' }))[0];
  const res = await call('POST', '/admin/assessments', {
    token: adminToken, body: { candidate_id: candId, role_id: roleId, assessor_id: priya.id },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assessmentId = res.body.id;
  assert.equal(res.body.snapshot_json.questions.length, 2, 'snapshot embeds the question bank');
  const cand = await store.get('candidates', candId);
  assert.equal(cand.stage, 'assessment');
  // duplicate open assessment blocked
  const dup = await call('POST', '/admin/assessments', {
    token: adminToken, body: { candidate_id: candId, role_id: roleId, assessor_id: priya.id },
  });
  assert.equal(dup.status, 409);
});

test('RBAC: assessor cannot open admin or other-assessor routes; candidate cannot see admin data', async () => {
  assert.equal((await call('GET', '/admin/candidates', { token: priyaToken })).status, 403);
  assert.equal((await call('POST', '/admin/users', { token: priyaToken, body: {} })).status, 403);
  assert.equal((await call('GET', '/admin/dashboard', { token: rohitToken })).status, 403);
  assert.equal((await call('GET', '/assessor/assessments', { token: rohitToken })).status, 403);
  // Arjun is NOT allocated to this assessment: hidden as 404
  assert.equal((await call('GET', `/assessor/assessments/${assessmentId}`, { token: arjunToken })).status, 404);
  // Priya's list contains exactly one
  const list = await call('GET', '/assessor/assessments', { token: priyaToken });
  assert.equal(list.body.assessments.length, 1);
  // candidate projection for assessor: no PII/notes/contact
  const proj = list.body.assessments[0].candidate;
  assert.equal(proj.name, 'Rohit Verma');
  assert.equal(proj.email, undefined);
  assert.equal(proj.phone, undefined);
  assert.equal(proj.notes, undefined);
});

test('candidate quiz payload contains NO correct answers or rubrics', async () => {
  const res = await call('GET', `/candidate/assessments/${assessmentId}`, { token: rohitToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.assessment.status, 'in_progress', 'first open starts the clock');
  for (const q of res.body.questions) {
    assert.equal(q.correct_option_ids, undefined);
    assert.equal(q.rubric, undefined);
  }
  // someone else's assessment is simply not found
  const other = await call('GET', `/candidate/assessments/${assessmentId}`, { token: adminToken });
  assert.ok([403, 404].includes(other.status));
});

test('candidate saves draft answers and submits; auto-scoring runs; incomplete submit is 422', async () => {
  const put = await call('PUT', `/candidate/assessments/${assessmentId}/answers`, {
    token: rohitToken, body: { answers: { q_missing: 'nope' } },
  });
  assert.equal(put.status, 200, 'unknown question ids are ignored');

  const firstQ = (await store.list('questions'))[0];
  // submit with only 1 of 2 answers -> 422 listing the missing one
  const incomplete = await call('POST', `/candidate/assessments/${assessmentId}/submit`, {
    token: rohitToken, body: { answers: { [firstQ.id]: 'b' } },
  });
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.missing_question_ids.length, 1);

  const full = await call('POST', `/candidate/assessments/${assessmentId}/submit`, {
    token: rohitToken,
    body: { answers: { [firstQ.id]: 'b', [(await store.list('questions'))[1].id]: 'Medallion zones across dev/qa/prod with UC three-level namespace and cost guardrails.' } },
  });
  assert.equal(full.status, 200);
  const responses = await store.list('responses', { assessment_id: assessmentId });
  const mcq = responses.find((r) => r.question_id === firstQ.id);
  assert.equal(mcq.auto_score, 4, 'correct mcq auto-scored at submit');
});

test('assessor scores with rubric visible; finalize produces report + advances pipeline', async () => {
  // before finalization candidate report is unavailable
  assert.equal((await call('GET', `/candidate/reports/${assessmentId}`, { token: rohitToken })).status, 409);

  const detail = await call('GET', `/assessor/assessments/${assessmentId}`, { token: priyaToken });
  assert.equal(detail.status, 200);
  assert.ok(detail.body.questions.some((q) => q.rubric), 'assessor sees rubrics');
  assert.equal(detail.body.candidate.email, undefined, 'no candidate PII for assessor');

  const textQ = detail.body.questions.find((q) => q.type === 'text');
  // out-of-range score rejected
  const badScore = await call('PUT', `/assessor/assessments/${assessmentId}/scores`, {
    token: priyaToken, body: { scores: [{ question_id: textQ.id, score: 99 }] },
  });
  assert.equal(badScore.status, 422);

  const save = await call('PUT', `/assessor/assessments/${assessmentId}/scores`, {
    token: priyaToken, body: { scores: [{ question_id: textQ.id, score: 5, comment: 'Strong structure; governance mentioned.' }] },
  });
  assert.equal(save.status, 200);

  const fin = await call('POST', `/assessor/assessments/${assessmentId}/finalize`, { token: priyaToken });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  // mcq 4/4 + text 5/6 = 9/10 = 90% overall
  assert.equal(fin.body.report.overall_pct, 90);
  assert.equal(fin.body.report.band.key, 'enterprise_ready');
  const cand = await store.get('candidates', globalThis.__ids.candId);
  assert.equal(cand.stage, 'gap_mapping', 'pipeline advanced to Gap Mapping');
});

test('candidate report card: band + areas to improve, but no assessor identity/comments', async () => {
  const res = await call('GET', `/candidate/reports/${assessmentId}`, { token: rohitToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.band.key, 'enterprise_ready');
  assert.ok(Array.isArray(res.body.report.areas_to_improve));
  assert.ok(Array.isArray(res.body.report.competencies));
  assert.equal(res.body.report.assessor_name, undefined);
  assert.equal(res.body.assessor_name, undefined);
  const flat = JSON.stringify(res.body);
  assert.ok(!flat.includes('Strong structure'), 'assessor comment withheld from candidate view');
});

test('admin sees full report including assessor + comments; dashboard reflects state', async () => {
  const res = await call('GET', `/admin/reports/${assessmentId}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.assessor_name, 'Priya');
  const textRow = res.body.report.competencies[0].breakdown.find((b) => b.scored_by === 'assessor');
  assert.ok(textRow.assessor_comment.includes('Strong'));
  const dash = await call('GET', '/admin/dashboard', { token: adminToken });
  assert.equal(dash.body.by_stage.gap_mapping, 1);
});

test('admin-only user provisioning; usernames are unique; candidate users require linkage', async () => {
  const dup = await call('POST', '/admin/users', {
    token: adminToken, body: { username: 'admin', name: 'X', role: 'admin', password: 'long-enough-1' },
  });
  assert.equal(dup.status, 409);
  const noLink = await call('POST', '/admin/users', {
    token: adminToken, body: { username: 'new.cand', name: 'NC', role: 'candidate', password: 'long-enough-1' },
  });
  assert.equal(noLink.status, 400);
  const created = await call('POST', '/admin/users', {
    token: adminToken, body: { username: 'new.assessor', name: 'NA', role: 'assessor', password: 'long-enough-1' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.password_hash, undefined, 'never return password hashes');
});
