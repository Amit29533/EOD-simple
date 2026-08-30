import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG, MAX_AUDIO_B64 } from '../src/core/constants.mjs';

/**
 * Full-fledged exam lifecycle over the real HTTP surface (in-process app):
 * the state machine (phases, countdown, resume, cursor integrity), spoken/
 * audio answer handling, autosave + locking, integrity trail, submission
 * validation, assessor scoring/finalize, exact report math, healing of
 * damaged legacy snapshots, and compartmentalization — end to end.
 */

const B64 = 'QUJDRA=='; // "ABCD"

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-exam-journey-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);

  const role = await store.insert('roles', { key: 'test-rsa', name: 'Test RSA', technology: 'Databricks', description: '', active: true });
  const comp1 = await store.insert('competencies', {
    role_id: role.id, key: 'arch', name: 'Architecture', category: 'technical', weight: 60,
    target_level: 4, enrichment_hint: 'Review blueprints.', order: 1, active: true,
  });
  const comp2 = await store.insert('competencies', {
    role_id: role.id, key: 'advise', name: 'Advisory', category: 'consultative', weight: 40,
    target_level: 3, enrichment_hint: 'Customer advisory practice.', order: 2, active: true,
  });

  const q = (overrides) => store.insert('questions', {
    role_id: role.id, competency_id: comp1.id, type: 'text', prompt: '?', help_text: '',
    options: [], correct_option_ids: [], points: 6, difficulty: 'intermediate', rubric: '',
    order: 0, active: true, ...overrides,
  });
  const pin = await q({
    competency_id: comp1.id, type: 'text', points: 6, order: 0,
    prompt: 'In simple terms, what problem does Databricks solve for an enterprise, and what is the role of an RSA in helping the client solve that problem?',
    rubric: 'R-pin', question_set: 'rsa-oral', pin_first: true, audio_required: true,
    help_text: 'Record a spoken answer (required). Typed notes are optional.',
  });
  const oral2 = await q({
    competency_id: comp2.id, type: 'text', points: 6, order: 1,
    prompt: 'A client says, “We already have a data warehouse and Spark environment. Why do we need Databricks?” How would you answer?',
    rubric: 'R-oral2', question_set: 'rsa-oral', audio_required: true,
  });
  const single = await q({
    competency_id: comp1.id, type: 'mcq_single', points: 4, order: 2, prompt: 'Pick B.',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
  });
  const multi = await q({
    competency_id: comp2.id, type: 'mcq_multi', points: 4, order: 3, prompt: 'Pick A and C.',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    correct_option_ids: ['a', 'c'],
  });
  const scale = await q({
    competency_id: comp1.id, type: 'scale', points: 4, order: 4, prompt: 'Rate yourself.',
  });
  const open = await q({
    competency_id: comp2.id, type: 'text', points: 6, order: 5,
    prompt: 'Design the migration plan.', rubric: 'R-open',
  });
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });

  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor1 = await mkUser({ username: 'assessor.one', name: 'Assessor One', role: 'assessor', email: '', password: 'a1-pass-x' });
  const assessor2 = await mkUser({ username: 'assessor.two', name: 'Assessor Two', role: 'assessor', email: '', password: 'a2-pass-x' });
  const cand1 = await store.insert('candidates', { name: 'Candidate One', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'candidate.one', name: 'Candidate One', role: 'candidate', email: '', candidate_id: cand1.id, password: 'c1-pass-x' });

  const call = (method, path, { token, body, query } = {}) =>
    app({ method, path, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (username, password) =>
    (await call('POST', '/auth/login', { body: { username, password } })).body.token;

  const world = {
    store, app, call, login, role, comp1, comp2,
    questions: { pin, oral2, single, multi, scale, open },
    ids: { pin: pin.id, oral2: oral2.id, single: single.id, multi: multi.id, scale: scale.id, open: open.id },
    cand1, assessor1, assessor2,
    tokens: {},
    async allocate(candidateId, assessorId) {
      const admin = this.tokens.admin ||= await login('admin', 'admin-pass-x');
      const res = await call('POST', '/admin/assessments', {
        token: admin,
        body: { candidate_id: candidateId, role_id: role.id, assessor_id: assessorId },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    },
  };
  return world;
}

async function candidateWalkBasics(w, aid) {
  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');
  const first = await w.call('GET', `/candidate/assessments/${aid}`, { token: tok });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  return { tok, first };
}

/* ============================== A. state machine + audio ============================== */

test('A1 · exam opens on the pinned spoken question in review phase, leaking nothing', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const { tok, first } = await candidateWalkBasics(w, alloc.id);

  assert.equal(first.body.assessment.status, 'in_progress', 'opening the exam starts it');
  assert.ok(first.body.assessment.started_at);
  assert.equal(first.body.exam.index, 0);
  assert.equal(first.body.exam.total, 6, 'all six bank questions are served');
  assert.equal(first.body.exam.phase, 'review', 'open questions open in the review window');
  assert.deepEqual(first.body.exam.budgets, { review_ms: 60_000, answer_ms: 120_000 });
  assert.ok(first.body.exam.remaining_ms > 0 && first.body.exam.remaining_ms <= 60_000);

  const q = first.body.current_question;
  assert.equal(q.id, w.ids.pin, 'the pinned spoken question is served first');
  assert.equal(q.pin_first, true);
  assert.equal(q.audio_required, true, 'the microphone requirement is projected');
  assert.equal(q.prompt.startsWith('In simple terms'), true);
  assert.equal(first.body.competency.id, w.comp1.id);
  assert.equal(first.body.answers[q.id], undefined, 'no answer yet');

  const leak = JSON.stringify(first.body);
  assert.ok(!leak.includes('rubric'), 'candidate surface never contains a rubric');
  assert.ok(!leak.includes('correct_option'), 'candidate surface never contains correct answers');
});

test('A2 · answer validation rejects malformed answers without advancing the cursor', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const { tok } = await candidateWalkBasics(w, alloc.id);
  const next = (answer) => w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer } });
  const idx = async () => (await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.exam.index;

  // wrong phase value on the phase endpoint
  const badPhase = await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'cheat' } });
  assert.equal(badPhase.status, 400);

  // move to the answer phase of q1, then probe invalid shapes (mcq/scale live further in)
  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });

  const oversized = { text: '', transcript: 'x', audio_b64: 'A'.repeat(MAX_AUDIO_B64 + 1), source: 'audio' };
  assert.equal((await next(oversized)).status, 422, 'oversized audio payload rejected');
  assert.equal((await next({ text: 42, transcript: '' })).status, 422, 'non-string text rejected');

  // walk to the mcq/scale questions with blanks and probe each malformed shape
  await next(null); // leave q1 (spoken) blank for now
  await next(null); // q2 (spoken) blank
  const singleProbe = await next('zz');
  assert.equal(singleProbe.status, 422, 'unknown mcq_single option rejected');
  await next('b'); // q3 correct
  const multiProbe = await next(['a', 'zz']);
  assert.equal(multiProbe.status, 422, 'unknown mcq_multi option rejected');
  await next(['b']); // q4 wrong-on-purpose (0 of 4)
  assert.equal((await next(9)).status, 422, 'scale value out of range rejected');
  assert.equal(await idx(), 4, 'failed validations never advance the cursor');
});

test('A3 · the answer phase cannot be re-entered to reset the two-minute timer', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const { tok } = await candidateWalkBasics(w, alloc.id);

  const enter = await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  assert.equal(enter.status, 200, 'review -> answer works once');
  assert.equal(enter.body.remaining_ms, 120_000);

  // Burn 90s of the answer window, then try to restart it by calling /phase again.
  const a = await w.store.get('assessments', alloc.id);
  await w.store.update('assessments', alloc.id, {
    quiz_state: { ...a.quiz_state, question_started_at: new Date(Date.now() - 90_000).toISOString() },
  });
  const remaining = (await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.exam.remaining_ms;
  assert.ok(remaining > 0 && remaining <= 30_000, `countdown is live (${remaining}ms left)`);

  const again = await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  assert.equal(again.status, 409, 're-entering the answer phase must not restart the timer');

  const after = (await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.exam;
  assert.ok(after.remaining_ms <= 30_000, 'the countdown was not reset');
  assert.equal(after.phase, 'answer');
});

test('A4 · autosave drafts, blanks and locked answers behave exactly as specified', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const { tok } = await candidateWalkBasics(w, alloc.id);
  const put = (answers) => w.call('PUT', `/candidate/assessments/${alloc.id}/answers`, { token: tok, body: { answers } });
  const current = async () => (await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.current_answer;

  // draft a typed answer for the spoken question while still in review
  assert.equal((await put({ [w.ids.pin]: { text: 'draft notes', transcript: '' } })).status, 200);
  assert.equal((await current()).text, 'draft notes');

  // blanking the draft removes the stored row
  assert.equal((await put({ [w.ids.pin]: '' })).status, 200);
  assert.equal(await current(), null);

  // a transcript-only draft is a real answer (speech counts)
  assert.equal((await put({ [w.ids.pin]: { text: '', transcript: 'spoken draft' } })).status, 200);
  assert.equal((await current()).transcript, 'spoken draft');

  // oversized audio in autosave is rejected
  const oversized = { text: '', transcript: 'x', audio_b64: 'A'.repeat(MAX_AUDIO_B64 + 1) };
  assert.equal((await put({ [w.ids.pin]: oversized })).status, 422);

  // non-b64 audio is accepted but the audio field is dropped (transcript survives)
  assert.equal((await put({ [w.ids.pin]: { text: '', transcript: 'clean', audio_b64: 'not base64!!' } })).status, 200);
  const kept = await current();
  assert.equal(kept.transcript, 'clean');
  assert.equal(kept.audio_b64, undefined, 'invalid base64 audio is never persisted');

  // lock the answer via next, then verify autosave can no longer change it
  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  await w.call('POST', `/candidate/assessments/${alloc.id}/next`, {
    token: tok,
    body: { answer: { text: '', transcript: 'final spoken', audio_b64: B64, audio_mime: 'audio/webm', source: 'audio' } },
  });
  assert.equal((await put({ [w.ids.pin]: 'rewrite attempt' })).status, 200, 'autosave of a locked answer is a no-op, not an error');
  const locked = await current(); // now on q2 — read the stored q1 answer directly
  const rows = await w.store.list('responses', { assessment_id: alloc.id });
  const q1 = rows.find((r) => r.question_id === w.ids.pin);
  assert.equal(q1.locked, true);
  assert.equal(q1.answer.transcript, 'final spoken', 'locked answer untouched by later autosave');
  assert.equal(q1.answer.audio_b64, B64, 'compact audio payload persisted');
  assert.equal(q1.answer.source, 'audio');
  assert.equal(locked, null, 'q2 has no draft yet');
});

test('A5 · integrity events accumulate with question context and hit the audit log', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const { tok } = await candidateWalkBasics(w, alloc.id);
  const post = (body) => w.call('POST', `/candidate/assessments/${alloc.id}/integrity`, { token: tok, body });

  const r1 = await post({ event: 'tab_switch', detail: 'Browser tab switched / window hidden' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.integrity.tab_switch, 1);
  assert.equal(r1.body.events.length, 1);
  assert.equal(r1.body.events[0].question_id, w.ids.pin, 'event carries the active question context');
  assert.ok(r1.body.events[0].question_prompt.length > 0);

  const r2 = await post({ event: 'weird_new_event', detail: { note: 'object detail is stringified' } });
  assert.equal(r2.body.integrity.other, 1, 'unknown events file under other');
  assert.match(r2.body.events[1].detail, /object detail/);

  const exam = (await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.exam.integrity;
  assert.equal(exam.tab_switch, 1);
  assert.equal(exam.other, 1);

  const auditRows = await w.store.list('audit_log');
  assert.ok(auditRows.some((e) => e.action === 'integrity_tab_switch'), 'integrity events are audited');
});

/* ============================== B. submission + assessor + report ============================== */

test('B1 · full walk, submit, score and finalize produce the exact weighted report', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const { tok } = await candidateWalkBasics(w, alloc.id);
  const next = (answer) => w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer } });

  // assessor cannot open the paper before submission
  const a1 = w.tokens.a1 ||= await w.login('assessor.one', 'a1-pass-x');
  assert.equal((await w.call('GET', `/assessor/assessments/${alloc.id}`, { token: a1 })).status, 409);

  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  await next({ text: '', transcript: 'spoken one', audio_b64: B64, audio_mime: 'audio/webm', source: 'audio' });
  await next('Second spoken answer, typed.');
  await next('b');            // q3 mcq_single correct -> 4/4
  await next(['b']);          // q4 mcq_multi wrong-on-purpose -> 0/4
  await next(4);              // q5 scale 4 -> 3.2/4
  const done = await next('Standard open answer.');
  assert.equal(done.body.complete, true);
  assert.equal(done.body.index, 6);

  // submit with the locked answers (client sends its collected map; empty is fine here)
  const submit = await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: tok, body: { answers: {} } });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  assert.equal((await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: tok, body: { answers: {} } })).status, 409, 'double submit rejected');
  assert.equal((await w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer: null } })).status, 409, 'exam over after submit');
  assert.equal((await w.call('PUT', `/candidate/assessments/${alloc.id}/answers`, { token: tok, body: { answers: { x: 1 } } })).status, 409, 'autosave closed after submit');
  assert.equal((await w.call('POST', `/candidate/assessments/${alloc.id}/integrity`, { token: tok, body: { event: 'tab_switch' } })).status, 409, 'integrity closed after submit');

  // assessor view: full questions, audio answers, scoring progress
  const paper = await w.call('GET', `/assessor/assessments/${alloc.id}`, { token: a1 });
  assert.equal(paper.status, 200);
  assert.ok(paper.body.questions.some((x) => x.rubric === 'R-pin'), 'assessor sees rubrics');
  const respById = Object.fromEntries(paper.body.responses.map((r) => [r.question_id, r]));
  assert.equal(respById[w.ids.pin].answer.audio_b64, B64, 'assessor receives the recorded audio');
  assert.equal(respById[w.ids.pin].answer.transcript, 'spoken one');
  assert.equal(respById[w.ids.single].auto_score, 4, 'auto-scored mcq_single');
  assert.equal(respById[w.ids.multi].auto_score, 0, 'wrong multi pick scores 0');
  assert.equal(respById[w.ids.scale].auto_score, 3.2, 'scale 4/5 of 4 points');
  assert.deepEqual(paper.body.scoring_progress, { manual_total: 3, manual_scored: 0 });
  const candView = paper.body.candidate;
  assert.deepEqual(Object.keys(candView).sort(), ['current_title', 'id', 'name', 'target_role_id', 'years_experience'], 'assessor sees a limited candidate profile');

  // score validation
  const putScores = (scores) => w.call('PUT', `/assessor/assessments/${alloc.id}/scores`, { token: a1, body: { scores } });
  assert.equal((await putScores([{ question_id: w.ids.pin, score: 7 }])).status, 422, 'score above points rejected');
  assert.equal((await putScores([{ question_id: w.ids.pin, score: 'abc' }])).status, 422, 'non-numeric score rejected');
  assert.equal((await putScores([{ question_id: w.ids.single, score: 3 }])).status, 200, 'auto questions are ignored, not errors');
  const ignored = (await w.call('GET', `/assessor/assessments/${alloc.id}`, { token: a1 })).body.responses;
  assert.equal(ignored.find((r) => r.question_id === w.ids.single).assessor_score, undefined, 'no assessor score sticks to auto questions');

  // finalize before all manual questions are scored
  await putScores([
    { question_id: w.ids.pin, score: 5, comment: 'Strong framing.' },
    { question_id: w.ids.oral2, score: 1 },
  ]);
  const early = await w.call('POST', `/assessor/assessments/${alloc.id}/finalize`, { token: a1 });
  assert.equal(early.status, 422);
  assert.deepEqual(early.body.missing.map((m) => m.question_id), [w.ids.open], 'finalize names the unscored question');

  // finish scoring and finalize
  await putScores([{ question_id: w.ids.open, score: 2 }]);
  const fin = await w.call('POST', `/assessor/assessments/${alloc.id}/finalize`, { token: a1 });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const report = fin.body.report;

  // exact math: comp1 = (5+4+3.2)/14 = 87.1% · comp2 = (1+0+2)/16 = 18.8%
  // overall = (87.1*60 + 18.8*40)/100 = 59.8 -> Development Needed
  const byId = Object.fromEntries(report.competencies.map((c) => [c.competency_id, c]));
  assert.equal(byId[w.comp1.id].score_pct, 87.1);
  assert.equal(byId[w.comp1.id].observed_level, 5);
  assert.equal(byId[w.comp1.id].gap, -1);
  assert.equal(byId[w.comp1.id].status, 'strength');
  assert.equal(byId[w.comp2.id].score_pct, 18.8);
  assert.equal(byId[w.comp2.id].observed_level, 1);
  assert.equal(byId[w.comp2.id].gap, 2);
  assert.equal(byId[w.comp2.id].status, 'critical_gap');
  assert.equal(report.overall_pct, 59.8);
  assert.equal(report.band.label, 'Development Needed');
  assert.deepEqual(report.areas_to_improve.map((g) => g.competency_id), [w.comp2.id]);
  assert.deepEqual(report.strengths.map((s) => s.competency), ['Architecture']);

  // the assessor's own re-finalize is closed, the report is served to the candidate
  assert.equal((await w.call('POST', `/assessor/assessments/${alloc.id}/finalize`, { token: a1 })).status, 409);
  const candReport = await w.call('GET', `/candidate/reports/${alloc.id}`, { token: tok });
  assert.equal(candReport.status, 200);
  const cr = candReport.body.report;
  assert.equal(cr.overall_pct, 59.8);
  assert.equal(cr.questions_evaluated, 6);
  assert.equal(cr.points_earned, 15.2);
  assert.equal(cr.points_available, 30);
  assert.equal(cr.areas_to_improve.length, 1);
  const leak = JSON.stringify(candReport.body);
  assert.ok(!leak.includes('assessor_comment'), 'candidate report has no assessor comments');
  assert.ok(!leak.includes('breakdown'), 'candidate report has no per-question breakdown');
});

test('B2 · compartmentalization: other assessors and candidates get existence-hiding 404s', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const a2 = w.tokens.a2 ||= await w.login('assessor.two', 'a2-pass-x');
  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');

  assert.equal((await w.call('GET', `/assessor/assessments/${alloc.id}`, { token: a2 })).status, 404, 'other assessor -> 404');
  assert.equal((await w.call('PUT', `/assessor/assessments/${alloc.id}/scores`, { token: a2, body: { scores: [{ question_id: 'x', score: 1 }] } })).status, 404);
  assert.equal((await w.call('GET', `/candidate/reports/${alloc.id}`, { token: a2 })).status, 403, 'assessor cannot use candidate routes');
  assert.equal((await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: a2 })).status, 403);
  assert.equal((await w.call('GET', `/assessor/assessments/${alloc.id}`, { token: tok })).status, 403, 'candidate cannot use assessor routes');
});

/* ============================== C. submission guards ============================== */

test('C1 · submitting early demands every answer; a completed exam may submit blanks', async () => {
  const w = await makeWorld();
  const cand2 = await w.store.insert('candidates', { name: 'Candidate Two', stage: 'assessment', target_role_id: w.role.id });
  await w.store.insert('users', {
    username: 'candidate.two', name: 'Candidate Two', role: 'candidate', email: '',
    candidate_id: cand2.id, password_hash: hashPassword('c2-pass-x'), active: true,
  });
  const alloc = await w.allocate(cand2.id, w.assessor1.id);
  const tok = await w.login('candidate.two', 'c2-pass-x');
  const next = (answer) => w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer } });

  // answer only the first question, then try to submit
  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  await next({ text: '', transcript: 'one answer' });
  const early = await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: tok, body: { answers: {} } });
  assert.equal(early.status, 422);
  assert.equal(early.body.missing_question_ids.length, 5, 'the remaining questions are listed');

  // an invalid shape is rejected even when the exam is done
  const a = await w.store.get('assessments', alloc.id);
  await w.store.update('assessments', alloc.id, {
    quiz_state: { ...a.quiz_state, index: 6 }, // exam cursor at the end
  });
  const badShape = await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, {
    token: tok, body: { answers: { [w.ids.single]: 'not-an-option' } },
  });
  assert.equal(badShape.status, 422, 'invalid answers are rejected at submit too');

  const submit = await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: tok, body: { answers: {} } });
  assert.equal(submit.status, 200, 'a completed exam submits with blanks');

  const rows = await w.store.list('responses', { assessment_id: alloc.id });
  const byId = Object.fromEntries(rows.map((r) => [r.question_id, r]));
  assert.equal(byId[w.ids.single].answer, '', 'blank mcq defaults to empty string');
  assert.equal(byId[w.ids.single].auto_score, 0, 'blank mcq auto-scores 0');
  assert.equal(byId[w.ids.pin].answer.transcript, 'one answer', 'the spoken answer survives the blank submit');
  assert.equal(byId[w.ids.pin].answer.source, 'typed', 'a transcript-only answer without audio is honestly labelled');
  assert.equal(byId[w.ids.oral2].answer.source, 'timed_out', 'blank open questions are marked timed_out');
  assert.equal(rows.length, 6, 'exactly one row per served question');
});

test('C2 · a fully blank run scores 0, maps every gap and still finalizes', async () => {
  const w = await makeWorld();
  const cand = await w.store.insert('candidates', { name: 'Blank Candidate', stage: 'assessment', target_role_id: w.role.id });
  await w.store.insert('users', {
    username: 'blank.candidate', name: 'Blank Candidate', role: 'candidate', email: '',
    candidate_id: cand.id, password_hash: hashPassword('blank-pass-x'), active: true,
  });
  const alloc = await w.allocate(cand.id, w.assessor1.id);
  const btok = await w.login('blank.candidate', 'blank-pass-x');

  const a = await w.store.get('assessments', alloc.id);
  await w.store.update('assessments', alloc.id, { quiz_state: { ...a.quiz_state, index: 6 } });
  assert.equal((await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: btok, body: { answers: {} } })).status, 200);

  const a1 = w.tokens.a1 ||= await w.login('assessor.one', 'a1-pass-x');
  await w.call('PUT', `/assessor/assessments/${alloc.id}/scores`, {
    token: a1,
    body: { scores: [w.ids.pin, w.ids.oral2, w.ids.open].map((question_id) => ({ question_id, score: 0 })) },
  });
  const fin = await w.call('POST', `/assessor/assessments/${alloc.id}/finalize`, { token: a1 });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.report.overall_pct, 0);
  assert.equal(fin.body.report.band.label, 'Not Yet Ready');
  assert.equal(fin.body.report.areas_to_improve.length, 2, 'both competencies gap');
  assert.deepEqual(fin.body.report.areas_to_improve.map((g) => g.gap), [3, 2], 'gaps ordered worst-first');
  assert.equal(fin.body.report.strengths.length, 0);
});

/* ============================== D. damaged snapshot healing ============================== */

test('D1 · a frozen paper with a stripped, mislabeled duplicate serves clean over HTTP', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);

  // damage the frozen snapshot like a pre-fix legacy store: a second, flag-less
  // copy of the pinned spoken question carrying the retired label, plus every
  // spoken row stripped of its contract flags.
  const a = await w.store.get('assessments', alloc.id);
  const qs = a.snapshot_json.questions;
  const twin = {
    ...qs.find((x) => x.id === w.ids.pin),
    id: 'rec_legacy_twin',
    prompt: `COMMON QUESTION — ${qs.find((x) => x.id === w.ids.pin).prompt}`,
  };
  delete twin.question_set; delete twin.pin_first; delete twin.audio_required;
  qs.splice(1, 0, twin);
  for (const x of qs) if (x.question_set === 'rsa-oral') { delete x.audio_required; delete x.question_set; }
  await w.store.update('assessments', alloc.id, { snapshot_json: a.snapshot_json });

  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');
  const d = await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok });
  assert.equal(d.body.exam.total, 6, 'the duplicate collapses (7 frozen rows -> 6 served)');
  const q1 = d.body.current_question;
  assert.equal(q1.id, w.ids.pin, 'the pinned row is served first');
  assert.equal(q1.pin_first, true);
  assert.equal(q1.audio_required, true, 'the microphone requirement is restored');
  assert.equal(q1.prompt.startsWith('COMMON QUESTION'), false, 'the retired label is dropped');
  assert.equal(q1.prompt.startsWith('In simple terms'), true);
});

/* ============================== E. resume + cursor integrity ============================== */

test('E1 · countdown clamps at zero and a tampered cursor cannot crash the exam', async () => {
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');

  // open the exam once so the quiz state exists, then expire the review window
  await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok });
  let a = await w.store.get('assessments', alloc.id);
  await w.store.update('assessments', alloc.id, {
    quiz_state: { ...a.quiz_state, question_started_at: new Date(Date.now() - 10 * 60_000).toISOString() },
  });
  const expired = await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok });
  assert.equal(expired.body.exam.remaining_ms, 0, 'expired window clamps to zero');

  // answer-phase countdown works too
  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  a = await w.store.get('assessments', alloc.id);
  await w.store.update('assessments', alloc.id, {
    quiz_state: { ...a.quiz_state, question_started_at: new Date(Date.now() - 5 * 60_000).toISOString() },
  });
  assert.equal((await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.exam.remaining_ms, 0);

  // resume mid-exam after a "refresh"
  await w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer: { text: 'one', transcript: '' } } });
  const resumed = await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok });
  assert.equal(resumed.body.exam.index, 1);
  assert.equal(resumed.body.current_question.id, w.ids.oral2);
  assert.equal(resumed.body.exam.phase, 'review', 'open questions resume in review');

  // tamper the cursor far past the end: no crash, coherent completion
  a = await w.store.get('assessments', alloc.id);
  await w.store.update('assessments', alloc.id, { quiz_state: { ...a.quiz_state, index: 99 } });
  const beyond = await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok });
  assert.equal(beyond.body.exam.complete, true);
  assert.equal(beyond.body.exam.total, 6);
  assert.equal(beyond.body.current_question, null);
  const tailNext = await w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer: null } });
  assert.equal(tailNext.body.complete, true);
  // and because the cursor is at the end, submit-with-blanks is allowed
  assert.equal((await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: tok, body: { answers: {} } })).status, 200);
});

test('E2 · one open assessment per candidate per role; allocation guards hold', async () => {
  const w = await makeWorld();
  await w.allocate(w.cand1.id, w.assessor1.id);
  const admin = w.tokens.admin ||= await w.login('admin', 'admin-pass-x');
  const dup = await w.call('POST', '/admin/assessments', {
    token: admin, body: { candidate_id: w.cand1.id, role_id: w.role.id, assessor_id: w.assessor1.id },
  });
  assert.equal(dup.status, 409, 'duplicate allocation rejected');

  // cap guards, exercised on a candidate with no open assessment
  const cand2 = await w.store.insert('candidates', { name: 'Cap Probe', stage: 'assessment', target_role_id: w.role.id });
  const over = await w.call('POST', '/admin/assessments', {
    token: admin, body: { candidate_id: cand2.id, role_id: w.role.id, question_count: 99 },
  });
  assert.equal(over.status, 400, 'the hard allocation cap holds');
  assert.match(over.body.error, /cannot exceed 50/);
  const overBank = await w.call('POST', '/admin/assessments', {
    token: admin, body: { candidate_id: cand2.id, role_id: w.role.id, question_count: 7 },
  });
  assert.equal(overBank.status, 400, 'a cap beyond the bank is rejected');
  assert.match(overBank.body.error, /only has 6 active question/);
});

/* ============================== F. open-question microphone contract ============================== */

test('F1 · EVERY open question is projected with the microphone, standard prompts included', async () => {
  // The reported bug: only the published spoken set carried `audio_required`,
  // so open questions 7-10 of a 10-question paper rendered a bare textarea with
  // no record control. The requirement is a property of the question type now.
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');

  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const d = await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok });
    if (d.body.exam.complete) break;
    seen.push(d.body.current_question);
    await w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer: null } });
  }
  assert.equal(seen.length, 6, 'the whole paper is walked');
  const open = seen.filter((q) => q.type === 'text');
  assert.equal(open.length, 3, 'two spoken prompts plus the standard open question');
  assert.ok(open.every((q) => q.audio_required === true), 'every open question demands a recording');
  assert.equal(open.find((q) => q.id === w.ids.open).audio_required, true, 'the unflagged standard prompt gets the mic');
  assert.deepEqual(
    seen.filter((q) => q.type !== 'text').map((q) => q.audio_required),
    [false, false, false],
    'choice and scale questions keep their typed/click answer',
  );
});

test('F2 · an audio-only open answer is stored and locked, never treated as blank', async () => {
  // Blankness used to be judged on text/transcript alone, so a candidate who
  // answered out loud without typing a word had their recording silently
  // dropped by /next (and by autosave).
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');

  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  const locked = await w.call('POST', `/candidate/assessments/${alloc.id}/next`, {
    token: tok,
    body: { answer: { text: '', transcript: '', audio_b64: B64, audio_mime: 'audio/webm', source: 'audio' } },
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));

  const rows = await w.store.list('responses', { assessment_id: alloc.id });
  const r = rows.find((x) => x.question_id === w.ids.pin);
  assert.ok(r, 'the recording was persisted');
  assert.equal(r.locked, true, 'and locked like any other exam answer');
  assert.equal(r.answer.audio_b64, B64);
  assert.equal(r.answer.audio_missing, undefined, 'a spoken answer satisfies the contract');

  // the draft/autosave path keeps audio-only answers too
  assert.equal((await w.call('PUT', `/candidate/assessments/${alloc.id}/answers`, {
    token: tok, body: { answers: { [w.ids.open]: { text: '', transcript: '', audio_b64: B64 } } },
  })).status, 200);
  const drafted = (await w.store.list('responses', { assessment_id: alloc.id })).find((x) => x.question_id === w.ids.open);
  assert.ok(drafted, 'an audio-only draft is not discarded as blank');
  assert.equal(drafted.answer.audio_b64, B64, 'and it is not stripped down to an empty answer');

  // the recording must also survive the final submit, which re-walks every answer
  for (let i = 0; i < 5; i += 1) await w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token: tok, body: { answer: null } });
  const submit = await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token: tok, body: { answers: {} } });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  const final = (await w.store.list('responses', { assessment_id: alloc.id })).find((x) => x.question_id === w.ids.pin);
  assert.equal(final.answer.audio_b64, B64, 'submit keeps the recording instead of rewriting it as timed_out');
  assert.equal(final.answer.source, 'audio');
});

test('F3 · a typed-only open answer is kept but flagged, and lands in the integrity trail', async () => {
  // Deliberate policy: the exam UI hard-gates the record button, but the API
  // never destroys a candidate's work inside a timed exam. A submission that
  // skipped the mandatory microphone is stored, flagged and audited so the
  // assessor sees the gap instead of guessing from a silent textarea answer.
  const w = await makeWorld();
  const alloc = await w.allocate(w.cand1.id, w.assessor1.id);
  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');

  await w.call('POST', `/candidate/assessments/${alloc.id}/phase`, { token: tok, body: { phase: 'answer' } });
  await w.call('POST', `/candidate/assessments/${alloc.id}/next`, {
    token: tok, body: { answer: { text: 'Typed notes only, no recording.', transcript: '', source: 'typed' } },
  });

  const rows = await w.store.list('responses', { assessment_id: alloc.id });
  const r = rows.find((x) => x.question_id === w.ids.pin);
  assert.equal(r.answer.text, 'Typed notes only, no recording.', 'nothing was thrown away');
  assert.equal(r.answer.audio_missing, true, 'but the missing recording is recorded');

  const exam = (await w.call('GET', `/candidate/assessments/${alloc.id}`, { token: tok })).body.exam;
  assert.equal(exam.integrity.spoken_answer_missing, 1, 'the proctoring counter sees it');
  const a = await w.store.get('assessments', alloc.id);
  const event = a.quiz_state.events.find((e) => e.event === 'spoken_answer_missing');
  assert.ok(event, 'the exam trail carries the event');
  assert.equal(event.question_id, w.ids.pin);

  const auditRows = await w.store.list('audit_log');
  assert.ok(auditRows.some((e) => e.action === 'exam_spoken_answer_missing'), 'and so does the audit log');

  // an answer with a transcript but no stored clip satisfies the contract:
  // browsers disagree about which of the two they can produce.
  await w.call('POST', `/candidate/assessments/${alloc.id}/next`, {
    token: tok, body: { answer: { text: '', transcript: 'spoken, but the clip was dropped', source: 'audio' } },
  });
  const second = (await w.store.list('responses', { assessment_id: alloc.id })).find((x) => x.question_id === w.ids.oral2);
  assert.equal(second.answer.audio_missing, undefined, 'a transcript alone counts as spoken');
});

test('F4 · a legacy bank of silent open questions allocates a paper that requires the microphone', async () => {
  // The workspace the bug was reported from: rows seeded before the flag
  // existed, so the stored bank says `audio_required: false`. Allocation heals
  // the contract into the snapshot instead of freezing the gap in place.
  const w = await makeWorld();
  const admin = w.tokens.admin ||= await w.login('admin', 'admin-pass-x');
  await w.store.update('questions', w.ids.open, { audio_required: false, question_set: '' });

  const res = await w.call('POST', '/admin/assessments', {
    token: admin,
    body: { candidate_id: w.cand1.id, role_id: w.role.id, assessor_id: w.assessor1.id },
  });
  assert.equal(res.status, 201);
  const snap = res.body.snapshot_json || (await w.store.get('assessments', res.body.id)).snapshot_json;
  assert.equal(snap.questions.find((q) => q.id === w.ids.open).audio_required, true, 'snapshot carries the contract');

  const tok = w.tokens.cand ||= await w.login('candidate.one', 'c1-pass-x');
  const walk = [];
  for (let i = 0; i < 6; i += 1) {
    const d = await w.call('GET', `/candidate/assessments/${res.body.id}`, { token: tok });
    if (d.body.exam.complete) break;
    walk.push(d.body.current_question);
    await w.call('POST', `/candidate/assessments/${res.body.id}/next`, { token: tok, body: { answer: null } });
  }
  const openFromLegacyBank = walk.find((q) => q.id === w.ids.open);
  assert.equal(openFromLegacyBank.audio_required, true, 'and the candidate is served the record control');
});
