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

/**
 * The exam's timing and one-way rules are enforced by the SERVER, not only by
 * the exam-hall page.
 *
 * The gate page promises "you cannot return to a question once it has passed",
 * "leaving a question locks it" and "time expiry submits the current item
 * (blank if unanswered)". The API used to keep none of those promises for a
 * client that skipped the browser:
 *
 *  - an in-time blank advance stored nothing, so the question stayed open;
 *  - the autosave route took a draft for ANY question on the paper — passed,
 *    future, or the live one long after its window closed;
 *  - the final submit merged the request body over every non-locked question.
 *
 * Together: walk the paper blank while reading every prompt, answer offline,
 * hand in a full answer sheet at the end — graded at 100%, outside every timer.
 * Each of those vectors is pinned closed here.
 */

const CORRECT = 'b';

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-timed-lock-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);

  const role = await store.insert('roles', { key: 'timed', name: 'Timed Track', technology: 'X', description: '', active: true });
  const comp = await store.insert('competencies', {
    role_id: role.id, key: 'core', name: 'Core', category: 'technical', weight: 100, target_level: 3, order: 1, active: true,
  });
  const q = (overrides) => store.insert('questions', {
    role_id: role.id, competency_id: comp.id, type: 'mcq_single', help_text: '', difficulty: 'intermediate',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: [CORRECT],
    points: 4, rubric: '', order: 0, active: true, ...overrides,
  });
  // Distinct prompts: the served paper de-duplicates by prompt.
  const mcqs = [];
  for (let i = 0; i < 3; i += 1) mcqs.push(await q({ prompt: `Objective question number ${i + 1}: pick B.`, order: i }));
  const open = await q({
    type: 'text', points: 6, order: 3, prompt: 'Describe the rollout plan for the platform.', rubric: 'R', options: [], correct_option_ids: [],
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

  const w = {
    store, call, id, paper, cand, asr, admin, open,
    exam: () => call('GET', `/candidate/assessments/${id}`, { token: cand }).then((r) => r.body),
    put: (answers) => call('PUT', `/candidate/assessments/${id}/answers`, { token: cand, body: { answers } }),
    next: (question_id, answer = null) => call('POST', `/candidate/assessments/${id}/next`, { token: cand, body: { question_id, answer } }),
    phase: () => call('POST', `/candidate/assessments/${id}/phase`, { token: cand, body: { phase: 'answer' } }),
    submit: (answers = {}) => call('POST', `/candidate/assessments/${id}/submit`, { token: cand, body: { answers } }),
    rows: () => store.list('responses', { assessment_id: id }),
    row: async (qid) => (await w.rows()).find((r) => r.question_id === qid),
    answerFor: (question) => (question.type === 'text' ? { text: 'notes', transcript: 'spoken answer', source: 'audio' } : CORRECT),
    /** Age the live question's clock so its window is long over. */
    async expireLive(ms = 10 * 60_000) {
      const a = await store.get('assessments', id);
      await store.update('assessments', id, {
        quiz_state: { ...a.quiz_state, question_started_at: new Date(Date.now() - ms).toISOString() },
      });
    },
    /** Walk the whole paper with blank advances, collecting every served question. */
    async blankWalk() {
      const seen = [];
      for (let i = 0; i < paper.length * 3 + 5; i += 1) {
        const d = await w.exam();
        if (d.exam.complete) break;
        seen.push(d.current_question);
        if (d.exam.phase === 'review') await w.phase();
        const r = await w.next(d.current_question.id, null);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      return seen;
    },
  };
  return w;
}

test('a question left behind blank is locked at once — it cannot be answered afterwards', async () => {
  const w = await makeWorld();
  const first = (await w.exam()).current_question;
  if (first.type === 'text') await w.phase();
  assert.equal((await w.next(first.id, null)).status, 200);

  const row = await w.row(first.id);
  assert.ok(row, 'a blank advance stores a row for the question');
  assert.equal(row.locked, true, 'and locks it');
  if (first.type === 'text') assert.equal(row.answer.source, 'skipped', 'an open blank the candidate clicked past is marked skipped');
  else assert.equal(row.answer, '');

  // Late answer through autosave: ignored, the blank stands.
  const late = await w.put({ [first.id]: w.answerFor(first) });
  assert.equal(late.status, 200);
  assert.deepEqual(late.body.accepted_question_ids, []);
  assert.deepEqual(late.body.ignored_question_ids, [first.id]);
  assert.equal((await w.row(first.id)).locked, true);
  assert.deepEqual((await w.row(first.id)).answer, row.answer, 'the late answer never replaced the blank');
});

test('walking the paper blank and handing in a full answer sheet at submit scores nothing', async () => {
  const w = await makeWorld();
  const seen = await w.blankWalk();
  assert.equal(seen.length, w.paper.length, 'the whole paper was read');
  assert.ok((await w.rows()).every((r) => r.locked), 'every question is locked behind the walk');

  const sheet = Object.fromEntries(seen.map((q) => [q.id, w.answerFor(q)]));
  const sub = await w.submit(sheet);
  assert.equal(sub.status, 200, 'the paper is complete, so it submits');

  const rows = await w.rows();
  for (const q of w.paper) {
    const r = rows.find((x) => x.question_id === q.id);
    if (q.type === 'text') {
      assert.equal(r.answer.text, '', 'the sheet\'s open answer was not taken');
      assert.equal(r.answer.source, 'skipped');
    } else {
      assert.equal(r.answer, '', 'the sheet\'s choice was not taken');
      assert.equal(r.auto_score, 0, 'and scores zero');
    }
  }
  const a = await w.store.get('assessments', w.id);
  assert.equal(a.status, 'submitted');
});

test('the submit body is validated but never graded; an unwalked paper stays incomplete', async () => {
  const w = await makeWorld();
  await w.exam(); // opens the exam hall
  const sheet = Object.fromEntries(w.paper.map((q) => [q.id, w.answerFor(q)]));
  const early = await w.submit(sheet);
  assert.equal(early.status, 422, 'answers in the body do not stand in for the walk');
  assert.equal(early.body.missing_question_ids.length, w.paper.length);
  assert.equal((await w.rows()).length, 0, 'nothing was written');

  const malformed = await w.submit({ [w.paper.find((q) => q.type !== 'text').id]: 'zz' });
  assert.equal(malformed.status, 422, 'a malformed sheet is still refused as malformed');
  assert.equal(malformed.body.missing_question_ids, undefined);
});

test('autosave takes a draft only for the question on screen, and only while its clock runs', async () => {
  const w = await makeWorld();
  // Before the exam hall is opened nothing is on screen: every draft is ignored.
  const before = await w.put(Object.fromEntries(w.paper.map((q) => [q.id, w.answerFor(q)])));
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.accepted_question_ids, []);
  assert.equal((await w.rows()).length, 0, 'no draft is stored before the exam starts');

  const d = await w.exam();
  const live = d.current_question;
  const future = w.paper.find((q) => q.id !== live.id);
  if (d.exam.phase === 'review') await w.phase();

  const mixed = await w.put({ [live.id]: w.answerFor(live), [future.id]: w.answerFor(future) });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body.accepted_question_ids, [live.id], 'the live question\'s draft is taken');
  assert.deepEqual(mixed.body.ignored_question_ids, [future.id], 'a draft for a question not yet served is not');
  assert.ok(await w.row(live.id));
  assert.equal(await w.row(future.id), undefined);

  // A malformed value is refused whichever question it names.
  const objective = w.paper.find((q) => q.type !== 'text');
  assert.equal((await w.put({ [objective.id]: 'zz' })).status, 422);

  // Once the live question's window is over, its drafts are ignored too.
  await w.expireLive();
  const stale = await w.put({ [live.id]: w.answerFor(live) });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body.ignored_question_ids, [live.id], 'no draft after the clock ran out');
});

test('a draft saved in time is the answer that gets locked, even when the lock itself comes late', async () => {
  const w = await makeWorld();
  const d = await w.exam();
  const live = d.current_question;
  if (d.exam.phase === 'review') await w.phase();
  assert.deepEqual((await w.put({ [live.id]: w.answerFor(live) })).body.accepted_question_ids, [live.id]);

  // The advance arrives long after the window closed, carrying a different answer.
  await w.expireLive();
  const other = live.type === 'text' ? { text: 'late rewrite', transcript: 'late', source: 'typed' } : 'a';
  const adv = await w.next(live.id, other);
  assert.equal(adv.status, 200);
  assert.equal(adv.body.index, 1);

  const row = await w.row(live.id);
  assert.equal(row.locked, true);
  if (live.type === 'text') assert.equal(row.answer.transcript, 'spoken answer', 'the in-time draft is what was locked');
  else assert.equal(row.answer, CORRECT, 'the in-time draft is what was locked');

  const a = await w.store.get('assessments', w.id);
  assert.equal(a.quiz_state.integrity.time_expired, 1, 'the overrun is still recorded');
  assert.match(a.quiz_state.events[0].detail, /answer saved in time/);
});

test('a typed-only draft locked by a blank or late advance leaves the same missing-recording trail', async () => {
  // The row carried `audio_missing` either way, so the assessor saw the
  // warning — but the integrity counter, the exam event trail and the audit
  // log used to fire only when the typed-only answer was POSTED with the
  // advance. A draft that reached the paper through autosave and was locked
  // by a blank advance (the client lost its recording, or the clock ran out)
  // left all three silent.
  const w = await makeWorld();
  // Walk to the open question.
  for (let i = 0; i < w.paper.length * 3 + 5; i += 1) {
    const d = await w.exam();
    if (d.current_question.id === w.open.id) break;
    if (d.exam.phase === 'review') { await w.phase(); continue; }
    await w.next(d.current_question.id, w.answerFor(d.current_question));
  }
  let d = await w.exam();
  assert.equal(d.current_question.id, w.open.id);
  if (d.exam.phase === 'review') await w.phase();
  const typedOnly = { text: 'typed notes, no recording', transcript: '', source: 'typed' };
  assert.deepEqual((await w.put({ [w.open.id]: typedOnly })).body.accepted_question_ids, [w.open.id]);
  assert.equal((await w.next(w.open.id, null)).status, 200, 'blank advance locks the draft');

  const row = await w.row(w.open.id);
  assert.equal(row.locked, true);
  assert.equal(row.answer.text, 'typed notes, no recording', 'the in-time draft is what was locked');
  assert.equal(row.answer.audio_missing, true);
  const a = await w.store.get('assessments', w.id);
  assert.equal(a.quiz_state.integrity.spoken_answer_missing, 1, 'the proctoring counter sees it');
  assert.ok(a.quiz_state.events.some((e) => e.event === 'spoken_answer_missing' && e.question_id === w.open.id), 'and the exam trail');
  assert.ok((await w.store.list('audit_log')).some((e) => e.action === 'exam_spoken_answer_missing'), 'and the audit log');

  // A blank that was never answered is not a missing recording — no false flag.
  d = await w.exam();
  if (!d.exam.complete) {
    if (d.exam.phase === 'review') await w.phase();
    await w.next(d.current_question.id, null);
  }
  const after = await w.store.get('assessments', w.id);
  assert.equal(after.quiz_state.integrity.spoken_answer_missing, 1, 'a skipped blank is not counted as a missing recording');
});

test('a question that expires with no answer at all is locked as a timed-out blank', async () => {
  const w = await makeWorld();
  const d = await w.exam();
  const live = d.current_question;
  if (d.exam.phase === 'review') await w.phase();
  await w.expireLive();
  const adv = await w.next(live.id, w.answerFor(live));
  assert.equal(adv.status, 200);
  const row = await w.row(live.id);
  assert.equal(row.locked, true);
  if (live.type === 'text') assert.equal(row.answer.source, 'timed_out');
  else assert.equal(row.answer, '', 'the late answer was not accepted');
});

test('the honest walk is unaffected: in-time answers lock, submit grades them, the report is exact', async () => {
  const w = await makeWorld();
  for (let i = 0; i < w.paper.length * 3 + 5; i += 1) {
    const d = await w.exam();
    if (d.exam.complete) break;
    if (d.exam.phase === 'review') { await w.phase(); continue; }
    const r = await w.next(d.current_question.id, w.answerFor(d.current_question));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await w.submit()).status, 200);
  const rows = await w.rows();
  assert.equal(rows.length, w.paper.length);
  for (const q of w.paper.filter((x) => x.type !== 'text')) {
    assert.equal(rows.find((r) => r.question_id === q.id).auto_score, 4);
  }
  const scored = await w.call('PUT', `/assessor/assessments/${w.id}/scores`, {
    token: w.asr, body: { scores: [{ question_id: w.open.id, score: 6 }] },
  });
  assert.equal(scored.status, 200);
  const fin = await w.call('POST', `/assessor/assessments/${w.id}/finalize`, { token: w.asr });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.report.overall_pct, 100);
});
