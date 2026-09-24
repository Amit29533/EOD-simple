import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';
import { makeWorld as makePovWorld } from './helpers/world.mjs';

/**
 * The assessor's manual score is the one number on the paper that a human
 * types in, and it feeds straight into the candidate's final percentage. The
 * endpoint used to run it through the forgiving `num()` helper, which turned
 * `true` into 1, `[2]` into 2 and `"0x2"` into 2 — all of them stored as marks
 * with a 200 — while an honest numeric string like "2.5" also had to keep
 * working, because that is what a form posts.
 */

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-assessor-scoring-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);

  const role = await store.insert('roles', { key: 'scored', name: 'Scored Track', technology: 'X', description: '', active: true });
  const comp = await store.insert('competencies', {
    role_id: role.id, key: 'core', name: 'Core', category: 'technical', weight: 100, target_level: 3, order: 1, active: true,
  });
  const base = {
    role_id: role.id, competency_id: comp.id, help_text: '', difficulty: 'intermediate', points: 4, rubric: '', active: true,
  };
  await store.insert('questions', {
    ...base, type: 'mcq_single', order: 0, prompt: 'Objective question: pick B.',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
  });
  const open = await store.insert('questions', {
    ...base, type: 'text', points: 6, order: 1, prompt: 'Describe the rollout plan.', rubric: 'R', options: [], correct_option_ids: [],
  });
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });

  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mkUser({ username: 'assessor', name: 'Assessor', role: 'assessor', email: '', password: 'a-pass-x' });
  const candidate = await store.insert('candidates', { name: 'Candidate', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'candidate', name: 'Candidate', role: 'candidate', email: '', candidate_id: candidate.id, password: 'c-pass-x' });

  const call = (method, p, { token, body } = {}) =>
    app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (username, password) => (await call('POST', '/auth/login', { body: { username, password } })).body.token;
  const admin = await login('admin', 'admin-pass-x');
  const cand = await login('candidate', 'c-pass-x');
  const asr = await login('assessor', 'a-pass-x');

  const alloc = await call('POST', '/admin/assessments', {
    token: admin, body: { candidate_id: candidate.id, role_id: role.id, assessor_id: assessor.id },
  });
  assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
  const id = alloc.body.id;
  const paper = sortedQuestions(alloc.body.snapshot_json);

  // Walk the paper honestly and hand it in, so it is ready for scoring.
  for (let i = 0; i < paper.length * 3 + 5; i += 1) {
    const d = (await call('GET', `/candidate/assessments/${id}`, { token: cand })).body;
    if (d.exam.complete) break;
    if (d.exam.phase === 'review') {
      await call('POST', `/candidate/assessments/${id}/phase`, { token: cand, body: { phase: 'answer' } });
      continue;
    }
    const answer = d.current_question.type === 'text'
      ? { text: 'notes', transcript: 'spoken answer', source: 'audio' }
      : 'b';
    const r = await call('POST', `/candidate/assessments/${id}/next`, { token: cand, body: { question_id: d.current_question.id, answer } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await call('POST', `/candidate/assessments/${id}/submit`, { token: cand, body: { answers: {} } })).status, 200);

  return {
    store, id, open, asr,
    score: (score) => call('PUT', `/assessor/assessments/${id}/scores`, { token: asr, body: { scores: [{ question_id: open.id, score }] } }),
    stored: async () => (await store.list('responses', { assessment_id: id })).find((r) => r.question_id === open.id)?.assessor_score,
  };
}

test('a manual score must be plainly numeric — booleans, arrays and hex strings are refused, not coerced', async () => {
  const w = await makeWorld();
  assert.equal((await w.score(4)).status, 200);
  assert.equal(await w.stored(), 4);
  for (const junk of [true, false, [2], [[1]], {}, '0x2', '1e400', 'Infinity', 'NaN', '2px', ' ', '-0', -1, 6.5, 7, Number.MAX_SAFE_INTEGER]) {
    const r = await w.score(junk);
    assert.equal(r.status, 422, `${JSON.stringify(junk)} must be refused, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(await w.stored(), 4, `${JSON.stringify(junk)} must not overwrite the stored score`);
  }
});

test('numeric strings from a form and half marks are accepted; blank clears', async () => {
  const w = await makeWorld();
  assert.equal((await w.score('2.5')).status, 200);
  assert.equal(await w.stored(), 2.5);
  assert.equal((await w.score(' 6 ')).status, 200, 'surrounding whitespace is trimmed');
  assert.equal(await w.stored(), 6);
  assert.equal((await w.score(0)).status, 200);
  assert.equal(await w.stored(), 0);
  assert.equal((await w.score(1.23456)).status, 200);
  assert.equal(await w.stored(), 1.23, 'stored to two decimals, like every other mark on the paper');
  assert.equal((await w.score(null)).status, 200);
  assert.equal(await w.stored(), null, 'an explicit blank clears the score');
  assert.equal((await w.score('')).status, 200);
  assert.equal(await w.stored(), null);
});

test('scores: the same unanswered question named twice in one sheet stores one row, last value wins', async (t) => {
  const w = await makePovWorld({ t, mcq: 1, open: 1 });
  const { token: ctok, assessmentId } = await w.candidateUser('twice.scored');
  // walk + submit while leaving the open question blank on the paper
  let v = (await w.call('GET', `/candidate/assessments/${assessmentId}`, { token: ctok })).body;
  while (!v.exam.complete) {
    if (v.current_question.type === 'text' && v.exam.phase === 'review') await w.call('POST', `/candidate/assessments/${assessmentId}/phase`, { token: ctok, body: { phase: 'answer' } });
    await w.call('POST', `/candidate/assessments/${assessmentId}/next`, { token: ctok, body: { question_id: v.current_question.id, answer: v.current_question.type === 'text' ? null : v.current_question.options[0].id } });
    v = (await w.call('GET', `/candidate/assessments/${assessmentId}`, { token: ctok })).body;
  }
  assert.equal((await w.call('POST', `/candidate/assessments/${assessmentId}/submit`, { token: ctok, body: { answers: {} } })).status, 200);
  const { user: asr, token: atok } = await w.assessorUser('twice.assessor');
  await w.assign(assessmentId, asr.id);
  const det = (await w.call('GET', `/assessor/assessments/${assessmentId}`, { token: atok })).body;
  const open = det.questions.find((q) => q.type === 'text');
  // A paper from before the exam hall locked every question has no row for
  // an unanswered one: drop the blank the walk left so the score must insert.
  for (const r of await w.store.list('responses', { assessment_id: assessmentId, question_id: open.id })) await w.store.remove('responses', r.id);
  const res = await w.call('PUT', `/assessor/assessments/${assessmentId}/scores`, { token: atok, body: { scores: [
    { question_id: open.id, score: 1, comment: 'first' }, { question_id: open.id, score: 2, comment: 'second' },
  ] } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = (await w.call('GET', `/assessor/assessments/${assessmentId}`, { token: atok })).body;
  const rows = after.responses.filter((r) => r.question_id === open.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assessor_score, 2);
  assert.equal(rows[0].assessor_comment, 'second');
});
