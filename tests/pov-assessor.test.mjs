/**
 * Assessor point of view, through the real app (in-process, JSON store).
 *
 * The assessor's queue, the scoring lifecycle (nothing before submission,
 * nothing after finalization), score validation, and the edges of what an
 * assessor can reach: only their own papers, never candidate contact details,
 * and nothing once reassigned or deactivated. Each world is fresh
 * (tests/helpers/world.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';

/** A world with one submitted paper assigned to assessor A, and a second assessor B. */
async function submittedWorld(t) {
  const w = await makeWorld({ t });
  const cand = await w.candidateUser('scored.cand', { name: 'Scored Person' });
  await w.store.update('candidates', cand.cand.id, { email: 'private@example.com', phone: '+1 555 0100' });
  const A = await w.assessorUser('assessor.a');
  const B = await w.assessorUser('assessor.b');
  await w.walkAndSubmit(cand.token, cand.assessmentId);
  await w.assign(cand.assessmentId, A.user.id);
  const snapshot = (await w.store.get('assessments', cand.assessmentId)).snapshot_json;
  const openIds = snapshot.questions.filter((q) => q.type === 'text').map((q) => q.id);
  // Papers are shuffled per candidate: find each competency's open question
  // by competency, never by position.
  const compId = Object.fromEntries(snapshot.competencies.map((c) => [c.name, c.id]));
  const openOf = (name) => snapshot.questions.find((q) => q.type === 'text' && q.competency_id === compId[name]).id;
  return { w, cand, A, B, id: cand.assessmentId, openIds, openOf };
}

/* ------------------------------------------------------------ the queue */

test('queue: an assessor sees only the papers assigned to them, without candidate contact details', async (t) => {
  const { w, A, B, id } = await submittedWorld(t);
  const other = await w.candidateUser('other.cand');
  await w.assign(other.assessmentId, B.user.id);

  const qa = w.expectOk(await w.call('GET', '/assessor/assessments', { token: A.token }), 'queue A');
  assert.deepEqual(qa.assessments.map((a) => a.id), [id]);
  const row = qa.assessments[0];
  assert.equal(row.status, 'submitted');
  assert.equal(row.role_name, 'POV Track');
  assert.equal(row.question_count, 5);
  assert.equal(row.candidate.name, 'Scored Person');
  const json = JSON.stringify(qa);
  assert.doesNotMatch(json, /private@example\.com|555 0100/, 'no email or phone in the queue');

  const qb = w.expectOk(await w.call('GET', '/assessor/assessments', { token: B.token }), 'queue B');
  assert.deepEqual(qb.assessments.map((a) => a.id), [other.assessmentId], 'B sees only B\'s paper');
});

/* ------------------------------------------------------------ lifecycle */

test('lifecycle: nothing can be opened or scored before the candidate submits', async (t) => {
  const w = await makeWorld({ t });
  const cand = await w.candidateUser('early.cand');
  const A = await w.assessorUser('early.assessor');
  await w.assign(cand.assessmentId, A.user.id);
  const openQ = (await w.store.get('assessments', cand.assessmentId)).snapshot_json.questions.find((q) => q.type === 'text');

  assert.equal((await w.call('GET', `/assessor/assessments/${cand.assessmentId}`, { token: A.token })).status, 409);
  assert.equal((await w.call('PUT', `/assessor/assessments/${cand.assessmentId}/scores`, {
    token: A.token, body: { scores: [{ question_id: openQ.id, score: 3 }] },
  })).status, 409);
  assert.equal((await w.call('POST', `/assessor/assessments/${cand.assessmentId}/finalize`, { token: A.token })).status, 409);
  assert.equal((await w.call('GET', `/assessor/assessments/${cand.assessmentId}/recordings/${openQ.id}`, { token: A.token })).status, 409);
  // It shows in the queue, not yet actionable.
  const q = w.expectOk(await w.call('GET', '/assessor/assessments', { token: A.token }), 'queue');
  assert.equal(q.assessments[0].status, 'assigned');
});

test('lifecycle: the submitted paper shows rubric and answer key to its assessor only', async (t) => {
  const { w, A, B, id } = await submittedWorld(t);
  const d = w.expectOk(await w.call('GET', `/assessor/assessments/${id}`, { token: A.token }), 'detail');
  assert.equal(d.assessment.status, 'submitted');
  assert.equal(d.questions.length, 5);
  for (const q of d.questions) {
    if (q.type === 'text') assert.ok(q.rubric, 'open questions carry the rubric');
    else assert.deepEqual(q.correct_option_ids, ['a'], 'objective questions carry the key');
  }
  assert.deepEqual(d.scoring_progress, { manual_total: 2, manual_scored: 0 });
  assert.doesNotMatch(JSON.stringify(d.candidate), /private@example\.com|555 0100/);
  // Objective answers arrive already auto-scored.
  const auto = d.responses.filter((r) => d.questions.find((q) => q.id === r.question_id)?.type !== 'text');
  assert.equal(auto.length, 3);
  for (const r of auto) assert.equal(r.auto_score, 4);
  // B gets an existence-hiding 404 everywhere on A's paper.
  for (const [method, path, body] of [
    ['GET', `/assessor/assessments/${id}`],
    ['PUT', `/assessor/assessments/${id}/scores`, { scores: [{ question_id: d.questions[0].id, score: 1 }] }],
    ['POST', `/assessor/assessments/${id}/finalize`],
    ['GET', `/assessor/assessments/${id}/recordings/${d.questions[0].id}`],
  ]) {
    assert.equal((await w.call(method, path, { token: B.token, body })).status, 404, `${method} ${path} as B`);
  }
});

/* ------------------------------------------------------------ scoring rules */

test('scoring: out-of-range and non-numeric scores are refused; half marks, numeric strings and blanks are accepted', async (t) => {
  const { w, A, id, openIds } = await submittedWorld(t);
  const put = (entry) => w.call('PUT', `/assessor/assessments/${id}/scores`, { token: A.token, body: { scores: [entry] } });
  const [q1] = openIds;
  for (const score of [6, -1, 'five', true, [3], '0x3', {}]) {
    assert.equal((await put({ question_id: q1, score })).status, 422, `score ${JSON.stringify(score)} is refused`);
  }
  assert.equal((await put({ question_id: q1, score: 2.5 })).status, 200);
  assert.equal((await put({ question_id: q1, score: '4' })).status, 200);
  let row = (await w.store.list('responses', { assessment_id: id })).find((r) => r.question_id === q1);
  assert.equal(row.assessor_score, 4);
  assert.equal((await put({ question_id: q1, score: '' })).status, 200, 'a blank clears');
  row = (await w.store.list('responses', { assessment_id: id })).find((r) => r.question_id === q1);
  assert.equal(row.assessor_score, null);
  assert.equal((await put({ question_id: q1, comment: { html: '<b>x</b>' } })).status, 400, 'comments are plain text');
  assert.equal((await w.call('PUT', `/assessor/assessments/${id}/scores`, { token: A.token, body: { scores: [] } })).status, 400);
  // A score for an objective question is ignored, never stored over the auto score.
  const mcq = (await w.store.get('assessments', id)).snapshot_json.questions.find((q) => q.type !== 'text');
  assert.equal((await put({ question_id: mcq.id, score: 0 })).status, 200);
  const mrow = (await w.store.list('responses', { assessment_id: id })).find((r) => r.question_id === mcq.id);
  assert.notEqual(mrow.assessor_score, 0);
  assert.equal(mrow.auto_score, 4);
});

test('finalize: refused until every open answer is scored, then produces the weighted report and locks the paper', async (t) => {
  const { w, cand, A, id, openIds, openOf } = await submittedWorld(t);
  const early = await w.call('POST', `/assessor/assessments/${id}/finalize`, { token: A.token });
  assert.equal(early.status, 422);
  assert.deepEqual(early.body.missing.map((m) => m.question_id).sort(), [...openIds].sort(), 'the refusal names the unscored questions');
  assert.ok(early.body.missing.every((m) => /Open scenario/.test(m.prompt)), 'with their prompts');

  await w.call('PUT', `/assessor/assessments/${id}/scores`, { token: A.token, body: { scores: [{ question_id: openOf('Architecture'), score: 5 }] } });
  assert.equal((await w.call('POST', `/assessor/assessments/${id}/finalize`, { token: A.token })).status, 422, 'one of two is not enough');

  await w.call('PUT', `/assessor/assessments/${id}/scores`, { token: A.token, body: { scores: [{ question_id: openOf('Advisory'), score: 0, comment: 'Did not address it.' }] } });
  const fin = await w.call('POST', `/assessor/assessments/${id}/finalize`, { token: A.token });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.status, 'scored');

  // Architecture (weight 60): 2 MCQs right (8/8) + open 1 at 5/5 -> 13/13 = 100%.
  // Advisory (weight 40): 1 MCQ right (4/4) + open 2 at 0/5 -> 4/9 = 44.4%.
  const byName = Object.fromEntries(fin.body.report.competencies.map((c) => [c.name, c]));
  assert.equal(byName.Architecture.score_pct, 100);
  assert.equal(Math.round(byName.Advisory.score_pct * 10) / 10, 44.4);
  const expected = (100 * 60 + (400 / 9) * 40) / 100;
  assert.equal(fin.body.report.overall_pct, Math.round(expected * 10) / 10);

  const a = await w.store.get('assessments', id);
  assert.equal(a.status, 'scored');
  assert.equal(a.overall_pct, fin.body.report.overall_pct);
  assert.equal((await w.store.get('candidates', cand.cand.id)).stage, 'gap_mapping', 'the pipeline advances');

  // Locked: no rescoring, no second finalize, no reassignment.
  assert.equal((await w.call('PUT', `/assessor/assessments/${id}/scores`, { token: A.token, body: { scores: [{ question_id: openOf('Advisory'), score: 5 }] } })).status, 409);
  assert.equal((await w.call('POST', `/assessor/assessments/${id}/finalize`, { token: A.token })).status, 409);
  assert.equal((await w.call('PATCH', `/admin/assessments/${id}`, { token: w.tok, body: { assessor_id: null } })).status, 409);
  // The finalized report stays readable to its assessor.
  const d = w.expectOk(await w.call('GET', `/assessor/assessments/${id}`, { token: A.token }), 'report');
  assert.equal(d.report.overall_pct, fin.body.report.overall_pct);
  assert.ok((await w.store.list('audit_log')).some((e) => e.action === 'assessment_scored' && e.entity_id === id));
});

/* ------------------------------------------------------------ access edges */

test('reassignment mid-review moves the paper, and every score so far, to the new assessor', async (t) => {
  const { w, A, B, id, openIds } = await submittedWorld(t);
  await w.call('PUT', `/assessor/assessments/${id}/scores`, { token: A.token, body: { scores: [{ question_id: openIds[0], score: 3 }] } });
  await w.assign(id, B.user.id);

  assert.equal((await w.call('GET', `/assessor/assessments/${id}`, { token: A.token })).status, 404, 'A has lost the paper');
  assert.deepEqual(w.expectOk(await w.call('GET', '/assessor/assessments', { token: A.token }), 'queue A').assessments, []);
  const d = w.expectOk(await w.call('GET', `/assessor/assessments/${id}`, { token: B.token }), 'detail B');
  assert.equal(d.responses.find((r) => r.question_id === openIds[0]).assessor_score, 3, 'A\'s score carries over');
  assert.deepEqual(d.scoring_progress, { manual_total: 2, manual_scored: 1 });
  await w.call('PUT', `/assessor/assessments/${id}/scores`, { token: B.token, body: { scores: [{ question_id: openIds[1], score: 4 }] } });
  assert.equal((await w.call('POST', `/assessor/assessments/${id}/finalize`, { token: B.token })).status, 200);
  assert.ok((await w.store.list('audit_log')).some((e) => e.action === 'assessment_reassigned' && e.entity_id === id));
});

test('a deactivated assessor is signed out at once and cannot sign back in', async (t) => {
  const { w, A, id } = await submittedWorld(t);
  assert.equal((await w.call('GET', `/assessor/assessments/${id}`, { token: A.token })).status, 200);
  w.expectOk(await w.call('PATCH', `/admin/users/${A.user.id}`, { token: w.tok, body: { active: false } }), 'deactivate');
  assert.equal((await w.call('GET', '/assessor/assessments', { token: A.token })).status, 401, 'the live session is gone');
  const again = await w.call('POST', '/auth/login', { body: { username: 'assessor.a', password: 'User-pass-123' } });
  assert.equal(again.status, 401);
});

test('an assessor cannot reach any admin or candidate route', async (t) => {
  const { w, A, id } = await submittedWorld(t);
  for (const [method, path] of [
    ['GET', '/admin/assessments'], ['GET', `/admin/reports/${id}`], ['PATCH', `/admin/assessments/${id}`],
    ['GET', '/admin/users'], ['GET', '/admin/audit'],
    ['GET', '/candidate/assessments'], ['GET', `/candidate/assessments/${id}`], ['POST', `/candidate/assessments/${id}/submit`],
  ]) {
    assert.equal((await w.call(method, path, { token: A.token, body: {} })).status, 403, `${method} ${path}`);
  }
});
