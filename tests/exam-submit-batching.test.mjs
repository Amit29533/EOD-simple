import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { stableJson } from '../src/api/helpers.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';

/**
 * The end-of-exam submit finalises a paper in a bounded number of writes.
 *
 * Regression this pins: the submit looped over every question and wrote each
 * response row on its own (`store.update` / `store.insert` per question). The
 * file and blob adapters rewrite their *entire* table for every single-row
 * write, so a 110-question paper cost 110 whole-store rewrites — ~1 GB of JSON
 * through the file adapter (~8 seconds locally, measured) and, on a serverless
 * function talking to a network-backed store, far more than the invocation
 * timeout allows. That is the candidate's "Submitting your assessment…" panel
 * that never finishes: the POST never answers, the browser has no deadline of
 * its own, and nothing on screen ever changes again.
 *
 * The submit now writes only the rows that actually changed and persists them
 * as one batch per table. These tests walk a real paper over the API surface
 * and assert both halves: the write volume stays bounded, and the persisted
 * answers, blanks and auto-scores are still exactly right.
 */

/** Wraps a store and records every mutation, with its table and row count. */
function countingStore(inner) {
  const writes = [];
  const record = (op, table, rows) => writes.push({
    op, table, rows: Array.isArray(rows) ? rows.length : 1,
    ids: Array.isArray(rows) ? rows.map((r) => r.id ?? r.question_id ?? '') : [],
  });
  const wrap = (op, name) => (...args) => {
    record(op, args[0], args[1]);
    return inner[name](...args);
  };
  return {
    writes,
    store: {
      kind: inner.kind,
      list: (...a) => inner.list(...a),
      get: (...a) => inner.get(...a),
      insert: wrap('insert', 'insert'),
      insertMany: wrap('insertMany', 'insertMany'),
      update: wrap('update', 'update'),
      updateMany: wrap('updateMany', 'updateMany'),
      remove: wrap('remove', 'remove'),
      removeMany: wrap('removeMany', 'removeMany'),
    },
  };
}

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-submit-batch-'));
  const inner = createJsonStore(path.join(tmp, 'db.json'));
  const { store, writes } = countingStore(inner);
  const app = await createApp(store);

  const role = await store.insert('roles', { key: 'test-rsa', name: 'Test RSA', technology: 'Databricks', description: '', active: true });
  const comp = await store.insert('competencies', {
    role_id: role.id, key: 'arch', name: 'Architecture', category: 'technical', weight: 60,
    target_level: 4, enrichment_hint: '', order: 1, active: true,
  });
  const q = (overrides) => store.insert('questions', {
    role_id: role.id, competency_id: comp.id, type: 'text', prompt: '?', help_text: '',
    options: [], correct_option_ids: [], points: 6, difficulty: 'intermediate', rubric: '',
    order: 0, active: true, ...overrides,
  });
  const questions = {
    spoken: await q({
      type: 'text', points: 6, order: 0, prompt: 'Talk us through a lakehouse migration.',
      rubric: 'R-spoken', audio_required: true,
    }),
    open: await q({ type: 'text', points: 6, order: 1, prompt: 'Design the rollout plan.' }),
    single: await q({
      type: 'mcq_single', points: 4, order: 2, prompt: 'Pick B.',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
    }),
    multi: await q({
      type: 'mcq_multi', points: 4, order: 3, prompt: 'Pick A and C.',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      correct_option_ids: ['a', 'c'],
    }),
    scale: await q({ type: 'scale', points: 4, order: 4, prompt: 'Rate yourself.' }),
    single2: await q({
      type: 'mcq_single', points: 4, order: 5, prompt: 'Pick A.',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['a'],
    }),
  };
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });

  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mkUser({ username: 'assessor', name: 'Assessor', role: 'assessor', email: '', password: 'a-pass-x' });
  const candidate = await store.insert('candidates', { name: 'Candidate', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'candidate', name: 'Candidate', role: 'candidate', email: '', candidate_id: candidate.id, password: 'c-pass-x' });

  const call = (method, p, { token, body } = {}) =>
    app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (username, password) => (await call('POST', '/auth/login', { body: { username, password } })).body.token;
  const tokens = {
    admin: await login('admin', 'admin-pass-x'),
    assessor: await login('assessor', 'a-pass-x'),
    candidate: await login('candidate', 'c-pass-x'),
  };

  const world = {
    store, writes, call, tokens, questions, candidate,
    /** Every mutation recorded while `fn` runs. */
    async during(fn) {
      const from = writes.length;
      const out = await fn();
      return { out, writes: writes.slice(from) };
    },
    async allocate() {
      const res = await call('POST', '/admin/assessments', {
        token: tokens.admin,
        body: { candidate_id: candidate.id, role_id: role.id, assessor_id: assessor.id },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.id;
    },
    async paper(allocId) {
      const a = await store.get('assessments', allocId);
      return [...a.snapshot_json.questions].sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    },
    async exam(allocId) {
      return (await call('GET', `/candidate/assessments/${allocId}`, { token: tokens.candidate })).body;
    },
    /**
     * Correct answers keyed by question id, built from the *raw* paper. The
     * candidate projection strips `correct_option_ids` (the browser must never
     * see them), so this is the only place the answers are available.
     */
    answerMap(paper) {
      const map = {};
      for (const q of paper) {
        if (q.type === 'mcq_single') map[q.id] = q.correct_option_ids[0];
        else if (q.type === 'mcq_multi') map[q.id] = [...q.correct_option_ids];
        else if (q.type === 'scale') map[q.id] = 4;
        else map[q.id] = {
          text: 'A considered answer.', transcript: 'A considered spoken answer.', source: 'audio',
          audio_b64: 'QUJDRA==', audio_mime: 'audio/webm',
        };
      }
      return map;
    },
    /** Walk the whole paper the way the exam hall does: /phase, then /next. */
    async walk(allocId, { answers = null } = {}) {
      let d = await this.exam(allocId);
      const total = d.exam.total;
      for (let i = 0; i < total * 3 + 5 && !d.exam.complete; i += 1) {
        const q = d.current_question;
        if (!q) break;
        if (d.exam.phase === 'review') {
          await call('POST', `/candidate/assessments/${allocId}/phase`, { token: tokens.candidate, body: { phase: 'answer' } });
          d = await this.exam(allocId);
          continue;
        }
        const res = await call('POST', `/candidate/assessments/${allocId}/next`, {
          token: tokens.candidate, body: { answer: answers ? (answers[q.id] ?? null) : null, question_id: q.id },
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        if (res.body.complete) break;
        d = await this.exam(allocId);
      }
      return d;
    },
    async rows(allocId) {
      return store.list('responses', { assessment_id: allocId });
    },
  };
  return world;
}

/** Only the writes that touched one table. */
const forTable = (writes, table) => writes.filter((w) => w.table === table);
/** Headline assertion: no per-row writes in a loop. */
function assertBatched(writes, label) {
  const perRow = writes.filter((w) => ['insert', 'update', 'remove'].includes(w.op));
  assert.deepEqual(
    perRow, [],
    `${label}: every response write must be batched, saw ${perRow.map((w) => `${w.op} ${w.table}`).join(', ')}`,
  );
  for (const w of writes) {
    assert.ok(w.rows <= 500, `${label}: batch of ${w.rows} rows is still a whole-table rewrite per row group`);
  }
}

test('stableJson compares meaning, not key order', () => {
  assert.equal(stableJson({ text: 'a', transcript: 'b', source: 'typed' }), stableJson({ source: 'typed', transcript: 'b', text: 'a' }));
  assert.equal(stableJson({ a: [{ b: 1, c: 2 }] }), stableJson({ a: [{ c: 2, b: 1 }] }));
  assert.notEqual(stableJson({ text: 'a' }), stableJson({ text: 'b' }));
  assert.notEqual(stableJson(null), stableJson(''));
  assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
});

test('a finished paper submits in one batch and never rewrites an unchanged row', async () => {
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  await w.walk(allocId, { answers: w.answerMap(paper) });

  const { out, writes } = await w.during(() => w.call('POST', `/candidate/assessments/${allocId}/submit`, {
    token: w.tokens.candidate, body: { answers: {} },
  }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assertBatched(forTable(writes, 'responses'), 'completed-paper submit');

  // The answers were locked as the exam advanced; only the auto-scores the
  // lock did not compute need storing, and they all fit in one batch.
  const responseWrites = forTable(writes, 'responses');
  assert.ok(responseWrites.length <= 1, `at most one response batch write, saw ${JSON.stringify(responseWrites.map((r) => r.op))}`);
  const autoQuestions = paper.filter((q) => q.type !== 'text');
  if (autoQuestions.length) {
    assert.equal(responseWrites[0].op, 'updateMany', 'auto-scored rows update as one batch');
    assert.equal(responseWrites[0].rows, autoQuestions.length, 'exactly the auto-scored rows are touched');
  }

  const rows = await w.rows(allocId);
  assert.equal(rows.length, paper.length, 'every question has exactly one response row');
  assert.equal(new Set(rows.map((r) => r.question_id)).size, paper.length, 'no duplicate response rows');
  for (const q of paper) {
    const r = rows.find((x) => x.question_id === q.id);
    assert.ok(r?.locked, `${q.type} answer must be locked`);
    if (q.type === 'mcq_single' || q.type === 'mcq_multi' || q.type === 'scale') {
      assert.ok(r.auto_score > 0, `a correct ${q.type} answer must carry its auto-score (got ${r.auto_score})`);
    }
  }
  const a = await w.store.get('assessments', allocId);
  assert.equal(a.status, 'submitted');
  assert.ok(a.submitted_at, 'submitted_at must be stamped');
});

test('a whole-store rewrite is not paid for a legacy row whose keys were reordered', async () => {
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  await w.walk(allocId, { answers: w.answerMap(paper) });

  // Simulate a row written by an older field order: same answer, different key
  // order. A `JSON.stringify` comparison would call it changed and rewrite the
  // table for nothing.
  const spoken = paper.find((q) => q.type === 'text');
  const rows = await w.rows(allocId);
  const row = rows.find((r) => r.question_id === spoken.id);
  await w.store.update('responses', row.id, {
    answer: {
      source: row.answer.source, audio_mime: row.answer.audio_mime,
      audio_ref: row.answer.audio_ref, transcript: row.answer.transcript, text: row.answer.text,
    },
  });

  const { writes } = await w.during(() => w.call('POST', `/candidate/assessments/${allocId}/submit`, {
    token: w.tokens.candidate, body: { answers: {} },
  }));
  const responseWrites = forTable(writes, 'responses');
  for (const wr of responseWrites) {
    assert.ok(!wr.ids.includes(row.id), 'an equivalent answer must not be rewritten');
  }
  const after = (await w.rows(allocId)).find((r) => r.question_id === spoken.id);
  assert.deepEqual({ ...after.answer }, { ...row.answer });
});

test('answers autosaved (not locked) submit as one batch with their auto-scores', async () => {
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  // Autosave each answer while its question is on screen (the exam hall's
  // draft path), then advance with an empty lock: the in-time draft is what
  // gets locked. The final submit then only has the auto-scores to write.
  const answers = w.answerMap(paper);
  let d = await w.exam(allocId);
  for (let i = 0; i < paper.length * 3 + 5 && !d.exam.complete; i += 1) {
    const q = d.current_question;
    if (d.exam.phase === 'review') {
      await w.call('POST', `/candidate/assessments/${allocId}/phase`, { token: w.tokens.candidate, body: { phase: 'answer' } });
      d = await w.exam(allocId);
      continue;
    }
    const saved = await w.call('PUT', `/candidate/assessments/${allocId}/answers`, {
      token: w.tokens.candidate, body: { answers: { [q.id]: answers[q.id] } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.accepted_question_ids, [q.id], 'the live question\'s draft is taken');
    const res = await w.call('POST', `/candidate/assessments/${allocId}/next`, {
      token: w.tokens.candidate, body: { answer: null, question_id: q.id },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    if (res.body.complete) break;
    d = await w.exam(allocId);
  }

  const { out, writes } = await w.during(() => w.call('POST', `/candidate/assessments/${allocId}/submit`, {
    token: w.tokens.candidate, body: { answers: {} },
  }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assertBatched(forTable(writes, 'responses'), 'autosaved-paper submit');
  const responseWrites = forTable(writes, 'responses');
  assert.equal(responseWrites.length, 1, `one batch for the auto-scores, saw ${JSON.stringify(responseWrites.map((r) => r.op))}`);
  assert.equal(responseWrites[0].op, 'updateMany');
  assert.equal(responseWrites[0].rows, paper.filter((q) => q.type !== 'text').length);

  const rows = await w.rows(allocId);
  for (const q of paper) {
    const r = rows.find((x) => x.question_id === q.id);
    assert.ok(r, `a row must exist for ${q.prompt}`);
    assert.ok(r.locked, 'the drafted answer was locked by the advance');
    if (q.type !== 'text') assert.ok(r.auto_score > 0, `auto-score computed at submit for ${q.type}`);
    else assert.equal(r.answer.transcript, 'A considered spoken answer.', 'the drafted spoken answer is the one locked');
  }
});

test('a paper with no answers at all submits its blanks in one batch', async () => {
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  await w.walk(allocId);
  // Every question the candidate clicked past is locked as a blank the moment
  // it is left behind (so it can never be answered afterwards) — the submit
  // has only the zero auto-scores to write.
  const walked = await w.rows(allocId);
  assert.equal(walked.length, paper.length, 'a skipped question is locked as a blank at once');
  assert.ok(walked.every((r) => r.locked), 'and cannot be answered later');

  const { out, writes } = await w.during(() => w.call('POST', `/candidate/assessments/${allocId}/submit`, {
    token: w.tokens.candidate, body: { answers: {} },
  }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assertBatched(forTable(writes, 'responses'), 'blank-paper submit');
  const responseWrites = forTable(writes, 'responses');
  assert.equal(responseWrites.length, 1, 'the zero auto-scores land in a single batch');
  assert.equal(responseWrites[0].op, 'updateMany');
  assert.equal(responseWrites[0].rows, paper.filter((q) => q.type !== 'text').length);

  const rows = await w.rows(allocId);
  assert.equal(rows.length, paper.length, 'a blank row is stored for every question');
  for (const q of paper) {
    const r = rows.find((x) => x.question_id === q.id);
    if (q.type === 'text') {
      assert.equal(r.answer.source, 'skipped', 'a blank open answer the candidate clicked past is marked skipped');
      assert.equal(r.answer.text, '');
      assert.equal(r.audit_missing ?? null, null);
    } else if (q.type === 'mcq_multi') {
      assert.deepEqual(r.answer, []);
    } else {
      assert.equal(r.answer, '');
    }
    if (q.type !== 'text') assert.equal(r.auto_score, 0, 'an unanswered auto question scores zero');
  }
});

test('a paper whose cursor was pushed past the end still submits its missing blanks in one batch', async () => {
  // The legacy path: rows for questions the walk never touched (a healed or
  // tampered cursor) are written at submit, as timed-out blanks, in one batch.
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  await w.exam(allocId);
  const a = await w.store.get('assessments', allocId);
  await w.store.update('assessments', allocId, { quiz_state: { ...a.quiz_state, index: paper.length } });

  const { out, writes } = await w.during(() => w.call('POST', `/candidate/assessments/${allocId}/submit`, {
    token: w.tokens.candidate, body: { answers: {} },
  }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assertBatched(forTable(writes, 'responses'), 'pushed-cursor submit');
  const responseWrites = forTable(writes, 'responses');
  assert.equal(responseWrites.length, 1, 'every blank lands in a single batch');
  assert.equal(responseWrites[0].op, 'insertMany');
  assert.equal(responseWrites[0].rows, paper.length);
  const rows = await w.rows(allocId);
  assert.equal(rows.length, paper.length);
  for (const q of paper.filter((x) => x.type === 'text')) {
    assert.equal(rows.find((r) => r.question_id === q.id).answer.source, 'timed_out');
  }
});

test('an early submit still refuses a paper with unanswered questions (no partial write)', async () => {
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  // Answer the first question only, then try to submit mid-paper.
  const d = await w.exam(allocId);
  const first = d.current_question;
  const res = await w.call('POST', `/candidate/assessments/${allocId}/next`, {
    token: w.tokens.candidate, body: { answer: w.answerMap(paper)[first.id], question_id: first.id },
  });
  assert.equal(res.status, 200);

  const { out, writes } = await w.during(() => w.call('POST', `/candidate/assessments/${allocId}/submit`, {
    token: w.tokens.candidate, body: { answers: {} },
  }));
  assert.equal(out.status, 422, 'an incomplete paper is refused');
  assert.equal(out.body.missing_question_ids.length, paper.length - 1);
  assert.deepEqual(forTable(writes, 'responses'), [], 'a refused submit must not rewrite any response row');
  assert.equal((await w.store.get('assessments', allocId)).status, 'in_progress', 'the assessment stays open');
});

test('scoring and finalization batch too (the assessor path on the same paper)', async () => {
  // The assessor's score entry and Finalize had the same per-row loops: one
  // whole-table rewrite per question, on papers that are up to 110 questions
  // long.
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  await w.walk(allocId, { answers: w.answerMap(paper) });
  await w.call('POST', `/candidate/assessments/${allocId}/submit`, { token: w.tokens.candidate, body: { answers: {} } });

  const manual = paper.filter((q) => q.type === 'text');
  const scores = manual.map((q, i) => ({ question_id: q.id, score: i + 3, comment: `Comment ${i + 1}` }));

  const scoring = await w.during(() => w.call('PUT', `/assessor/assessments/${allocId}/scores`, {
    token: w.tokens.assessor, body: { scores },
  }));
  assert.equal(scoring.out.status, 200, JSON.stringify(scoring.out.body));
  assertBatched(forTable(scoring.writes, 'responses'), 'assessor score entry');
  const scoreWrites = forTable(scoring.writes, 'responses');
  assert.equal(scoreWrites.length, 1, 'every score lands in one batch');
  assert.equal(scoreWrites[0].op, 'updateMany');
  assert.equal(scoreWrites[0].rows, manual.length);

  const finalizing = await w.during(() => w.call('POST', `/assessor/assessments/${allocId}/finalize`, {
    token: w.tokens.assessor,
  }));
  assert.equal(finalizing.out.status, 200, JSON.stringify(finalizing.out.body));
  assertBatched(forTable(finalizing.writes, 'responses'), 'assessor finalize');
  const finalWrites = forTable(finalizing.writes, 'responses');
  assert.equal(finalWrites.length, 1, 'the whole paper is finalised in one batch');
  assert.equal(finalWrites[0].op, 'updateMany');
  assert.equal(finalWrites[0].rows, paper.length, 'every served question gets its final score in that batch');

  const rows = await w.rows(allocId);
  for (const q of paper) {
    const r = rows.find((x) => x.question_id === q.id);
    assert.ok(Number.isFinite(r.final_score), `final_score must be stored for ${q.prompt}`);
  }
  const a = await w.store.get('assessments', allocId);
  assert.equal(a.status, 'scored');
  assert.ok(a.report_json, 'the report is stored');
});

test('the delete cascades batch too: one removeMany per table, never a remove per row', async () => {
  // Deleting an assessment, a candidate, a competency or a role used to delete
  // its dependants one row at a time — a whole-store rewrite per response row
  // on the file/blob adapters, and n requests on Airtable.
  const w = await makeWorld();
  const allocId = await w.allocate();
  const paper = await w.paper(allocId);
  await w.walk(allocId, { answers: w.answerMap(paper) });
  assert.equal((await w.rows(allocId)).length, paper.length);

  const del = await w.during(() => w.call('DELETE', `/admin/assessments/${allocId}`, { token: w.tokens.admin }));
  assert.equal(del.out.status, 200, JSON.stringify(del.out.body));
  const perRow = del.writes.filter((x) => x.op === 'remove' && x.table === 'responses');
  assert.deepEqual(perRow, [], 'no per-row response deletes');
  const batched = del.writes.filter((x) => x.op === 'removeMany' && x.table === 'responses');
  assert.equal(batched.length, 1, 'one batch for the whole paper');
  assert.equal(batched[0].rows, paper.length);
  assert.equal((await w.rows(allocId)).length, 0);

  // The candidate cascade (users + sessions + assessments + responses).
  const again = await w.allocate();
  await w.walk(again, { answers: w.answerMap(await w.paper(again)) });
  const cdel = await w.during(() => w.call('DELETE', `/admin/candidates/${w.candidate.id}`, {
    token: w.tokens.admin, body: { password: 'admin-pass-x' },
  }));
  assert.equal(cdel.out.status, 200, JSON.stringify(cdel.out.body));
  assert.deepEqual(cdel.writes.filter((x) => x.op === 'remove' && ['responses', 'sessions', 'users'].includes(x.table)), [],
    'dependants of a candidate are removed in batches');
  assert.equal(cdel.writes.filter((x) => x.op === 'removeMany' && x.table === 'responses').length, 1);
  assert.equal((await w.store.list('responses', { assessment_id: again })).length, 0);
  assert.equal((await w.store.list('users', { candidate_id: w.candidate.id })).length, 0);
});
