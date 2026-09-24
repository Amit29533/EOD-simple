import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import {
  MAX_ASSESSMENT_QUESTIONS, EXAM_MCQ_SECONDS, EXAM_OPEN_REVIEW_SECONDS, EXAM_OPEN_ANSWER_SECONDS,
} from '../src/core/constants.mjs';
import { SAMA_ROLE, SAMA_COMPETENCIES, SAMA_QUESTIONS } from '../src/content/sama-catalogue.mjs';
import { MODULES as SAMA_MODULES, QUESTIONS as SAMA_BANK } from '../src/content/sama-question-bank.mjs';
import { PUBLISHED_CATALOGUES, catalogueForRoleKey, installCatalogue } from '../src/api/catalogue-service.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';
import { promptKey } from '../src/core/prompt-key.mjs';

/**
 * The published Technology Risk Consultant - SAMA catalogue: the same
 * sync / install / allocate / sit / score / report treatment as the RSA and
 * AI/BI catalogues, addressed by role key, with the RSA catalogue untouched
 * as the default.
 */

async function buildStore({ role = SAMA_ROLE, competencies = SAMA_COMPETENCIES, questions = SAMA_QUESTIONS.slice(0, 25) } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-sama-catalogue-'));
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

async function client(app, username, password) {
  const res = await app({ method: 'POST', path: '/auth/login', body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const token = res.body.token;
  return (method, reqPath, body, query) =>
    app({ method, path: reqPath, body, query, headers: { authorization: `Bearer ${token}` } });
}
const adminClient = (app) => client(app, 'sync-admin', 'sync-admin-pass');

test('the SAMA track is registered in the published catalogue registry', () => {
  assert.ok(Object.hasOwn(PUBLISHED_CATALOGUES, 'technology-risk-sama'));
  assert.equal(catalogueForRoleKey('technology-risk-sama').role.name, 'Technology Risk Consultant - SAMA');
  // The RSA catalogue is still the unscoped default.
  assert.equal(catalogueForRoleKey().role.key, 'databricks-rsa');
  // Role keys never collide across published tracks.
  const keys = Object.values(PUBLISHED_CATALOGUES).map((c) => c.role.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('the published SAMA bank has the shape allocation expects', () => {
  // Derived one-for-one from the module bank: 60 objective + 40 open.
  const objective = SAMA_QUESTIONS.filter((q) => q.type === 'mcq_single');
  const open = SAMA_QUESTIONS.filter((q) => q.type === 'text');
  assert.equal(SAMA_QUESTIONS.length, 100);
  assert.equal(SAMA_BANK.length, 100);
  assert.equal(objective.length, 60);
  assert.equal(open.length, 40);
  assert.ok(objective.every((q) => q.options.length === 4), 'every MCQ carries its four workbook options');
  assert.ok(objective.every((q) => q.correct_option_ids.length === 1), 'every MCQ has exactly one key');
  assert.ok(objective.every((q) => q.options.some((o) => o.id === q.correct_option_ids[0])), 'every key points at a real option');
  assert.ok(objective.every((q) => q.points === 4) && open.every((q) => q.points === 6));
  assert.ok(open.every((q) => q.rubric.includes('Expected evidence:')), 'every open question scores against expected evidence');
  assert.ok(open.every((q) => q.rubric.includes('Follow-up probes:')), 'every open rubric carries the workbook probes');
  // The candidate-facing help text never leaks the key.
  assert.ok(SAMA_QUESTIONS.every((q) => !/correct answer/i.test(q.help_text || '')));
  assert.ok(SAMA_QUESTIONS.every((q) => !/correct answer/i.test(q.prompt)));
  // No spoken set in this workbook: nothing is pinned or set-tagged.
  assert.ok(SAMA_QUESTIONS.every((q) => q.question_set === '' && q.pin_first === false));
  // Prompts are unique under the platform's typography-insensitive identity.
  assert.equal(new Set(SAMA_QUESTIONS.map((q) => promptKey(q.prompt))).size, 100);
  // Ten competencies, weights sum to 100, every question maps to one of them.
  assert.equal(SAMA_COMPETENCIES.length, 10);
  assert.equal(SAMA_COMPETENCIES.reduce((n, c) => n + c.weight, 0), 100);
  assert.ok(SAMA_COMPETENCIES.every((c) => c.target_level >= 1 && c.target_level <= 5 && c.enrichment_hint));
  const keys = new Set(SAMA_COMPETENCIES.map((c) => c.key));
  assert.ok(SAMA_QUESTIONS.every((q) => keys.has(q.competency)));
  // Each module's 10 questions map to its own competency, in module order.
  assert.equal(new Set(SAMA_QUESTIONS.map((q) => q.competency)).size, 10);
  assert.deepEqual(SAMA_MODULES.map((m) => m.name), SAMA_COMPETENCIES.map((c) => c.name));
  // Published ids carry the workbook's TRC prefix.
  assert.ok(SAMA_BANK.every((q) => /^TRC-[A-Z]\d\d-\d{3}$/.test(q.id)), 'TRC-<MODULE>-<nnn> ids');
});

test('catalogue status reports what a SAMA bank is missing, addressed by role key', async () => {
  const { store, role } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  const status = await call('GET', '/admin/content/catalogue', undefined, { role_key: SAMA_ROLE.key });
  assert.equal(status.status, 200);
  assert.equal(status.body.available, true);
  assert.equal(status.body.role.id, role.id);
  assert.equal(status.body.catalogue_total, SAMA_QUESTIONS.length);
  assert.equal(status.body.bank_total, 25);
  assert.equal(status.body.missing, SAMA_QUESTIONS.length - 25);

  // The default (no role key) is the RSA catalogue — untouched by the new track.
  const rsaDefault = await call('GET', '/admin/content/catalogue');
  assert.equal(rsaDefault.status, 200);
  assert.equal(rsaDefault.body.available, false, 'no RSA role exists in this store');
});

test('sync tops a SAMA bank up to the published catalogue and is idempotent', async () => {
  const { store } = await buildStore();
  const app = await createApp(store);
  const call = await adminClient(app);

  const synced = await call('POST', '/admin/content/sync', { role_key: SAMA_ROLE.key });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.added, SAMA_QUESTIONS.length - 25);
  assert.equal(synced.body.bank_total, SAMA_QUESTIONS.length);

  const again = await call('POST', '/admin/content/sync', { role_key: SAMA_ROLE.key });
  assert.equal(again.status, 200);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.bank_total, SAMA_QUESTIONS.length);

  // Every stored open question carries the microphone requirement.
  const stored = await store.list('questions');
  assert.ok(stored.filter((q) => q.type === 'text').every((q) => q.audio_required === true));
  // The sync created nothing for the other tracks.
  assert.equal((await store.list('roles')).length, 1);
});

test('Roles & frameworks → Published tracks lists SAMA and installs it into a workspace', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-sama-install-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  await store.insert('users', {
    username: 'sync-admin', name: 'Sync Admin', role: 'admin',
    password_hash: hashPassword('sync-admin-pass'), active: true,
  });
  const app = await createApp(store);
  const call = await adminClient(app);

  const before = await call('GET', '/admin/content/tracks');
  assert.equal(before.status, 200);
  const listed = before.body.tracks.find((t) => t.role_key === SAMA_ROLE.key);
  assert.ok(listed, 'the SAMA track is listed as a published track');
  assert.equal(listed.role_name, 'Technology Risk Consultant - SAMA');
  assert.equal(listed.installed, false);
  assert.equal(listed.authoring_only, false);
  assert.equal(listed.competency_total, 10);
  assert.equal(listed.catalogue_total, 100);
  assert.equal(listed.missing, 100);

  const install = await call('POST', '/admin/content/tracks', { role_key: SAMA_ROLE.key });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  assert.equal(install.body.created, true);
  assert.equal(install.body.competencies_added, 10);
  assert.equal(install.body.bank_total, 100);

  const roles = await store.list('roles');
  assert.equal(roles.length, 1);
  assert.equal(roles[0].key, SAMA_ROLE.key);
  assert.equal(roles[0].technology, 'Technology Risk');
  assert.equal((await store.list('frameworks', { role_id: roles[0].id })).length, 1, 'a default scoring framework is created');
  assert.equal((await store.list('competencies', { role_id: roles[0].id })).length, 10);
  assert.equal((await store.list('questions', { role_id: roles[0].id })).length, 100);

  const after = await call('GET', '/admin/content/tracks');
  const now = after.body.tracks.find((t) => t.role_key === SAMA_ROLE.key);
  assert.equal(now.installed, true);
  assert.equal(now.active, true);
  assert.equal(now.missing, 0);

  // The role shows up on the Roles & frameworks list like any other track.
  const rolesList = await call('GET', '/admin/roles');
  assert.equal(rolesList.status, 200);
  const sama = rolesList.body.roles.find((r) => r.key === SAMA_ROLE.key);
  assert.ok(sama);
  assert.equal(sama.competency_count, 10);
  assert.equal(sama.question_count, 100);

  // Installing twice tops the existing track up (200), never a duplicate role.
  const twice = await call('POST', '/admin/content/tracks', { role_key: SAMA_ROLE.key });
  assert.equal(twice.status, 200, JSON.stringify(twice.body));
  assert.equal(twice.body.added, 0);
  assert.equal((await store.list('roles')).length, 1);

  // The service entry point agrees (what scripts/seed.mjs runs).
  const viaService = await installCatalogue(store, SAMA_ROLE.key);
  assert.equal(viaService.created, false);
  assert.equal(viaService.bank_total, 100);
});

test('a 50-question SAMA allocation covers every module competency', async () => {
  const { store, role } = await buildStore({ questions: SAMA_QUESTIONS });
  const app = await createApp(store);
  const call = await adminClient(app);

  const candidate = await store.insert('candidates', { name: 'SAMA Candidate', stage: 'assessment' });
  const allocated = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id, question_count: MAX_ASSESSMENT_QUESTIONS,
  });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  const snap = allocated.body.snapshot_json;
  assert.equal(snap.questions.length, MAX_ASSESSMENT_QUESTIONS);
  assert.equal(snap.bank_total, SAMA_QUESTIONS.length);

  // Every one of the ten module competencies is represented (weighted split).
  const byComp = new Map(snap.competencies.map((c) => [c.id, 0]));
  for (const q of snap.questions) byComp.set(q.competency_id, (byComp.get(q.competency_id) || 0) + 1);
  assert.ok([...byComp.values()].every((n) => n > 0), 'no module competency scores zero');

  // Open questions in the frozen paper demand a recording and carry their
  // expected-evidence rubric; nothing is pinned (this bank has no spoken set).
  const open = snap.questions.filter((q) => q.type === 'text');
  assert.ok(open.length > 0);
  assert.ok(open.every((q) => q.audio_required === true));
  assert.ok(open.every((q) => q.rubric.length > 0));
  assert.ok(snap.questions.every((q) => q.pin_first !== true));

  // No prompt is asked twice in one paper, and the paper is position-stamped
  // and interleaved: no two open questions back to back.
  const prompts = snap.questions.map((q) => q.prompt);
  assert.equal(new Set(prompts).size, prompts.length);
  const ordered = sortedQuestions(snap);
  assert.ok(ordered.every((q) => Number.isInteger(q.position)));
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.ok(!(ordered[i].type === 'text' && ordered[i + 1].type === 'text'), `no adjacent open questions at ${i}`);
  }
});

test('SAMA end to end: allocate → candidate sits the timed exam → assessor scores → report', async () => {
  const { store, role } = await buildStore({ questions: SAMA_QUESTIONS });
  const app = await createApp(store);
  const admin = await adminClient(app);

  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  const assessor = await mkUser({ username: 'sama.assessor', name: 'SAMA Assessor', role: 'assessor', password: 'assessor-pass-x' });
  const candidate = await store.insert('candidates', { name: 'SAMA Candidate', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'sama.candidate', name: 'SAMA Candidate', role: 'candidate', candidate_id: candidate.id, password: 'candidate-pass-x' });

  // Admin allocates a 12-question paper to the candidate and assessor.
  const allocated = await admin('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id, assessor_id: assessor.id, question_count: 12,
  });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  const aid = allocated.body.id;
  const snap = allocated.body.snapshot_json;
  assert.equal(snap.questions.length, 12);
  assert.equal(snap.role.key, SAMA_ROLE.key);

  // Candidate sees it on My Journey and opens it.
  const cand = await client(app, 'sama.candidate', 'candidate-pass-x');
  const mine = await cand('GET', '/candidate/assessments');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const list = Array.isArray(mine.body) ? mine.body : mine.body.assessments;
  assert.ok(list.some((a) => a.id === aid), 'allocated assessment appears for the candidate');
  assert.ok(list.every((a) => !('assessor_id' in a) && !('assessor' in a)), 'assessor identity is withheld from the candidate');

  const served = sortedQuestions((await store.get('assessments', aid)).snapshot_json);
  const first = await cand('GET', `/candidate/assessments/${aid}`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.current_question.id, served[0].id, 'the candidate meets the paper in its stamped order');
  assert.equal(first.body.exam.total, 12);
  assert.equal(first.body.assessment.status, 'in_progress', 'opening the exam starts it');
  const leak = JSON.stringify(first.body);
  assert.ok(!leak.includes('correct_option'), 'the key never leaks to the candidate');
  assert.ok(!leak.includes('rubric'), 'the rubric never leaks to the candidate');

  // Walk the paper; assert the timers for each question type on the way.
  const expected = {};
  for (const q of served) {
    const view = await cand('GET', `/candidate/assessments/${aid}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.current_question.id, q.id);
    const exam = view.body.exam;
    if (q.type === 'text') {
      assert.equal(exam.phase, 'review', 'an open question opens in its review window');
      assert.deepEqual(exam.budgets, { review_ms: EXAM_OPEN_REVIEW_SECONDS * 1000, answer_ms: EXAM_OPEN_ANSWER_SECONDS * 1000 });
      assert.ok(exam.remaining_ms > 0 && exam.remaining_ms <= EXAM_OPEN_REVIEW_SECONDS * 1000);
      assert.equal(view.body.current_question.audio_required, true, 'open questions demand a spoken answer');
      const enter = await cand('POST', `/candidate/assessments/${aid}/phase`, { phase: 'answer' });
      assert.equal(enter.status, 200, JSON.stringify(enter.body));
      assert.equal(enter.body.remaining_ms, EXAM_OPEN_ANSWER_SECONDS * 1000);
      const answering = (await cand('GET', `/candidate/assessments/${aid}`)).body.exam;
      assert.equal(answering.phase, 'answer');
      assert.ok(answering.remaining_ms > 0 && answering.remaining_ms <= EXAM_OPEN_ANSWER_SECONDS * 1000);
      // The answer window cannot be re-entered to reset the clock.
      assert.equal((await cand('POST', `/candidate/assessments/${aid}/phase`, { phase: 'answer' })).status, 409);
      const answer = { text: 'Notes.', transcript: 'A spoken risk-based answer.', audio_b64: 'QUJDRA==', audio_mime: 'audio/webm', source: 'audio' };
      const next = await cand('POST', `/candidate/assessments/${aid}/next`, { answer });
      assert.equal(next.status, 200, JSON.stringify(next.body));
      expected[q.id] = 'open';
    } else {
      assert.equal(q.type, 'mcq_single');
      assert.equal(exam.phase, 'answer', 'an MCQ has no review window');
      assert.deepEqual(exam.budgets, { review_ms: 0, answer_ms: EXAM_MCQ_SECONDS * 1000 });
      assert.ok(exam.remaining_ms > 0 && exam.remaining_ms <= EXAM_MCQ_SECONDS * 1000);
      assert.equal(view.body.current_question.options.length, 4);
      // Answer correctly, so the auto-score is deterministic: 4/4 each.
      const next = await cand('POST', `/candidate/assessments/${aid}/next`, { answer: q.correct_option_ids[0] });
      assert.equal(next.status, 200, JSON.stringify(next.body));
      expected[q.id] = 'mcq';
    }
  }
  const done = await cand('GET', `/candidate/assessments/${aid}`);
  assert.equal(done.body.exam.complete, true);

  const submit = await cand('POST', `/candidate/assessments/${aid}/submit`, { answers: {} });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));

  // Assessor sees the paper, MCQs already auto-scored full marks.
  const asr = await client(app, 'sama.assessor', 'assessor-pass-x');
  const paper = await asr('GET', `/assessor/assessments/${aid}`);
  assert.equal(paper.status, 200, JSON.stringify(paper.body));
  const responses = paper.body.responses;
  assert.equal(responses.length, 12);
  for (const r of responses) {
    if (expected[r.question_id] === 'mcq') assert.equal(r.auto_score, 4, 'correct MCQ auto-scored 4/4');
    else assert.equal(r.audio_missing, undefined, 'a spoken open answer is not flagged');
  }
  const openIds = served.filter((q) => q.type === 'text').map((q) => q.id);
  assert.ok(openIds.length > 0);
  const scored = await asr('PUT', `/assessor/assessments/${aid}/scores`, {
    scores: openIds.map((question_id) => ({ question_id, score: 6, comment: 'Strong SAMA reasoning.' })),
  });
  assert.equal(scored.status, 200, JSON.stringify(scored.body));

  const fin = await asr('POST', `/assessor/assessments/${aid}/finalize`);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const report = fin.body.report;
  assert.equal(report.overall_pct, 100);
  assert.ok(report.competencies.length > 0);
  assert.ok(report.competencies.every((c) => c.score_pct === 100));
  assert.deepEqual(report.areas_to_improve, []);

  // Candidate's own report and pipeline stage move on.
  const cr = await cand('GET', `/candidate/reports/${aid}`);
  assert.equal(cr.status, 200);
  assert.equal(cr.body.report.overall_pct, 100);
  assert.equal(cr.body.report.questions_evaluated, 12);
  assert.ok(!JSON.stringify(cr.body).includes('assessor_comment'), 'candidate report has no assessor comments');
  assert.equal((await store.get('candidates', candidate.id)).stage, 'gap_mapping');
});
