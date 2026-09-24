/**
 * Answer-shape limits on the exam's write paths (API level, real app).
 *
 * Regressions these pin:
 *  - an open answer's typed halves had no length cap: a scripted client could
 *    store ~2 MB of "notes" per open question (the request-body ceiling), so
 *    one paper could park tens of megabytes in the response shard every exam
 *    step re-reads — on a store every other tenant shares. Drafts, locks and
 *    the submit sheet are now refused past MAX_ANSWER_TEXT / MAX_ANSWER_TRANSCRIPT.
 *  - a scale answer was validated by bare `Number(value)` coercion, so `true`
 *    (stored, scored 1), `[3]` (stored an array) and `"0x3"` (hex coercion)
 *    were accepted from a client. Strict mode takes a plain number or numeric
 *    string only.
 *  - the caps and the strict typing apply to CLIENT input only. A row already
 *    stored (written before these rules existed) must keep a paper submittable:
 *    the submit re-validates stored rows leniently and re-normalises them
 *    through splitAnswer, which truncates on persist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { MAX_ANSWER_TEXT, MAX_ANSWER_TRANSCRIPT } from '../src/core/constants.mjs';

/** Walk the paper to (and including) the first open question, in its answer phase. */
async function walkToOpen(w, token, assessmentId) {
  await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
  for (let guard = 0; guard < 80; guard += 1) {
    const cur = await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
    const q = cur.body.current_question;
    if (!q) throw new Error('paper finished before an open question appeared');
    if (q.type === 'text') {
      if (cur.body.exam.phase === 'review') {
        const p = await w.call('POST', `/candidate/assessments/${assessmentId}/phase`, { token, body: { phase: 'answer' } });
        assert.equal(p.status, 200);
      }
      return q;
    }
    const answer = q.type === 'scale' ? 4 : (q.options?.[0]?.id ?? 'a');
    const r = await w.call('POST', `/candidate/assessments/${assessmentId}/next`, { token, body: { question_id: q.id, answer } });
    assert.equal(r.status, 200);
    if (r.body.complete) throw new Error('paper finished before an open question appeared');
  }
  throw new Error('no open question found');
}

test('an oversized draft (text or transcript) is refused and stores nothing', async (t) => {
  const w = await makeWorld({ mcq: 1, open: 1, t });
  const { token, assessmentId } = await w.candidateUser('cap.draft');
  const q = await walkToOpen(w, token, assessmentId);

  const giantText = { text: 'x'.repeat(MAX_ANSWER_TEXT + 1), transcript: 'spoken' };
  const r1 = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: { [q.id]: giantText } } });
  assert.equal(r1.status, 422, JSON.stringify(r1.body));
  assert.match(r1.body.error, /Invalid answer/i);

  const giantTranscript = { text: 'notes', transcript: 'y'.repeat(MAX_ANSWER_TRANSCRIPT + 1) };
  const r2 = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: { [q.id]: giantTranscript } } });
  assert.equal(r2.status, 422);

  const giantBare = 'z'.repeat(MAX_ANSWER_TEXT + 1);
  const r3 = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: { [q.id]: giantBare } } });
  assert.equal(r3.status, 422);

  const rows = await w.store.list('responses', { assessment_id: assessmentId, question_id: q.id });
  assert.equal(rows.length, 0, 'a refused draft writes no row');
});

test('an oversized answer cannot be locked in through /next either', async (t) => {
  const w = await makeWorld({ mcq: 1, open: 1, t });
  const { token, assessmentId } = await w.candidateUser('cap.lock');
  const q = await walkToOpen(w, token, assessmentId);

  const r = await w.call('POST', `/candidate/assessments/${assessmentId}/next`, {
    token,
    body: { question_id: q.id, answer: { text: 'x'.repeat(MAX_ANSWER_TEXT + 1), transcript: 'spoken words' } },
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));

  // The question is still live and a normal answer still locks.
  const okLock = await w.call('POST', `/candidate/assessments/${assessmentId}/next`, {
    token,
    body: { question_id: q.id, answer: { text: 'A considered answer.', transcript: 'spoken words' } },
  });
  assert.equal(okLock.status, 200, JSON.stringify(okLock.body));
});

test('text at the cap is accepted, and an honest-length answer stores verbatim', async (t) => {
  const w = await makeWorld({ mcq: 1, open: 1, t });
  const { token, assessmentId } = await w.candidateUser('cap.edge');
  const q = await walkToOpen(w, token, assessmentId);

  const atCap = { text: 'x'.repeat(MAX_ANSWER_TEXT), transcript: 'y'.repeat(MAX_ANSWER_TRANSCRIPT) };
  const r = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: { [q.id]: atCap } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [row] = await w.store.list('responses', { assessment_id: assessmentId, question_id: q.id });
  assert.equal(row.answer.text.length, MAX_ANSWER_TEXT);
  assert.equal(row.answer.transcript.length, MAX_ANSWER_TRANSCRIPT);
});

test('a scale answer must be a plain number or numeric string, not a coercible oddity', async (t) => {
  const w = await makeWorld({ mcq: 0, open: 0, t });
  const scaleQ = w.expectOk(await w.call('POST', '/admin/questions', {
    token: w.tok,
    body: {
      role_id: w.role.id, competency_id: w.c1.id, type: 'scale',
      prompt: 'Rate your proficiency with distributed systems from one to five.', points: 5,
    },
  }), 'scale question');
  const { token, assessmentId } = await w.candidateUser('scale.strict');
  await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });

  // Every one of these used to pass `Number(value)` coercion and be stored.
  for (const junk of [true, [3], '0x3', '3abc', 3.5, {}, 0, 6, '']) {
    if (junk === '') continue; // '' is the documented "clear" value
    const r = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: { [scaleQ.id]: junk } } });
    assert.equal(r.status, 422, `scale draft ${JSON.stringify(junk)} -> ${r.status}`);
  }
  const rows = await w.store.list('responses', { assessment_id: assessmentId, question_id: scaleQ.id });
  assert.equal(rows.length, 0, 'no junk reached storage');

  // Honest forms still work: a number, and the numeric string a form posts.
  for (const good of [3, '4']) {
    const r = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: { [scaleQ.id]: good } } });
    assert.equal(r.status, 200, `scale draft ${JSON.stringify(good)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('a legacy stored row past the caps keeps the paper submittable and is trimmed on persist', async (t) => {
  const w = await makeWorld({ mcq: 1, open: 1, t });
  const { token, assessmentId } = await w.candidateUser('cap.legacy');
  const q = await walkToOpen(w, token, assessmentId);
  // Lock a normal answer, then age the stored row into a pre-cap legacy giant.
  const lock = await w.call('POST', `/candidate/assessments/${assessmentId}/next`, {
    token, body: { question_id: q.id, answer: { text: 'short', transcript: 'spoken' } },
  });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  const [row] = await w.store.list('responses', { assessment_id: assessmentId, question_id: q.id });
  await w.store.update('responses', row.id, {
    answer: { ...row.answer, text: 'L'.repeat(MAX_ANSWER_TEXT + 5000), transcript: 'T'.repeat(MAX_ANSWER_TRANSCRIPT + 5000) },
  });

  // Finish the paper and submit: the stored giant must not 422 the submit…
  for (let guard = 0; guard < 80; guard += 1) {
    const cur = await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
    if (cur.body.exam.complete) break;
    const cq = cur.body.current_question;
    const answer = cq.type === 'text' ? { text: 'answered', transcript: 'spoken' } : (cq.type === 'scale' ? 4 : (cq.options?.[0]?.id ?? 'a'));
    const r = await w.call('POST', `/candidate/assessments/${assessmentId}/next`, { token, body: { question_id: cq.id, answer } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const sub = await w.call('POST', `/candidate/assessments/${assessmentId}/submit`, { token, body: { answers: {} } });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));

  // …and the submit's re-normalisation trims it to the stored caps.
  const [after] = await w.store.list('responses', { assessment_id: assessmentId, question_id: q.id });
  assert.equal(after.answer.text.length, MAX_ANSWER_TEXT, 'legacy text trimmed on persist');
  assert.equal(after.answer.transcript.length, MAX_ANSWER_TRANSCRIPT, 'legacy transcript trimmed on persist');
});
