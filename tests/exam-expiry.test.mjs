import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { examDeadline, examHasExpired, EXAM_SESSION_MS } from '../src/api/exam-expiry.mjs';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa } from './helpers/spa.mjs';

test('absolute two-hour boundary applies only to a started exam', () => {
  const a = { status: 'in_progress', started_at: '2026-10-01T10:00:00.000Z' };
  const deadline = Date.parse('2026-10-01T12:00:00.000Z');
  assert.equal(examDeadline(a), deadline);
  assert.equal(examHasExpired(a, deadline - 1), false);
  assert.equal(examHasExpired(a, deadline), true);
  assert.equal(examHasExpired({ ...a, status: 'assigned' }, deadline + 1), false);
  assert.equal(examHasExpired({ ...a, status: 'scored' }, deadline + 1), false);
});

test('rules/list do not start the clock; hall entry sets it once and reopening cannot extend it', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('expiry.candidate');
  const path = `/candidate/assessments/${c.assessmentId}`;
  const list = await w.call('GET', '/candidate/assessments', { token: c.token });
  assert.equal(list.body.assessments[0].expires_at, null);
  const opened = await w.call('GET', path, { token: c.token });
  assert.equal(opened.status, 200);
  const { started_at, expires_at } = opened.body.assessment;
  assert.equal(Date.parse(expires_at) - Date.parse(started_at), EXAM_SESSION_MS);
  const reopened = await w.call('GET', path, { token: c.token });
  assert.equal(reopened.body.assessment.started_at, started_at);
  assert.equal(reopened.body.assessment.expires_at, expires_at);
});

test('reopening after two hours closes the exam, preserves saved answers, hides questions and logs expiry once', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('late.candidate');
  const path = `/candidate/assessments/${c.assessmentId}`;
  const opened = await w.call('GET', path, { token: c.token });
  const q = opened.body.current_question;
  await w.call('PUT', `${path}/answers`, { token: c.token, body: { answers: { [q.id]: 'a' } } });
  const before = await w.store.list('responses', { assessment_id: c.assessmentId });
  assert.ok(before.length);
  await w.store.update('assessments', c.assessmentId, { started_at: new Date(Date.now() - EXAM_SESSION_MS - 1000).toISOString() });
  const reopened = await w.call('GET', path, { token: c.token });
  assert.equal(reopened.body.assessment.status, 'submitted');
  assert.equal(reopened.body.assessment.exam_expired, true);
  assert.equal(reopened.body.current_question, null);
  assert.deepEqual(reopened.body.questions, []);
  assert.equal(reopened.body.exam.session_remaining_ms, 0);
  for (const [method, suffix, body] of [
    ['PUT', '/answers', { answers: { [q.id]: 'b' } }],
    ['POST', '/next', { question_id: q.id, answer: 'b' }],
    ['POST', '/phase', { phase: 'answer', question_id: q.id }],
    ['POST', '/submit', { answers: { [q.id]: 'b' } }],
  ]) assert.equal((await w.call(method, path + suffix, { token: c.token, body })).status, 409);
  assert.deepEqual(await w.store.list('responses', { assessment_id: c.assessmentId }), before);
  await w.call('GET', path, { token: c.token });
  assert.equal((await w.store.list('audit_log', { action: 'assessment_expired', entity_id: c.assessmentId })).length, 1);
});

test('a direct answer request cannot bypass expiry even when the browser never reported closure', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('bypass.candidate');
  await w.store.update('assessments', c.assessmentId, {
    status: 'in_progress', started_at: new Date(Date.now() - EXAM_SESSION_MS).toISOString(),
  });
  assert.equal((await w.call('PUT', `/candidate/assessments/${c.assessmentId}/answers`, { token: c.token, body: { answers: {} } })).status, 409);
  assert.equal((await w.store.get('assessments', c.assessmentId)).status, 'submitted');
});

test('assessor list materializes expiry when the candidate never returns', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('offline.candidate');
  const a = await w.assessorUser('expiry.assessor');
  await w.assign(c.assessmentId, a.user.id);
  await w.store.update('assessments', c.assessmentId, { status: 'in_progress', started_at: new Date(Date.now() - EXAM_SESSION_MS).toISOString() });
  const list = await w.call('GET', '/assessor/assessments', { token: a.token });
  assert.equal(list.body.assessments[0].status, 'submitted');
});

test('candidate UI displays the expiry message on return without offering exam entry', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('expired.ui.candidate');
  await w.store.update('assessments', c.assessmentId, { status: 'in_progress', started_at: new Date(Date.now() - EXAM_SESSION_MS).toISOString() });
  const spa = await bootSpa({ hash: `#/assessments/${c.assessmentId}/quiz`, backend: { app: w.app, token: c.token } });
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    await quizView(spa.view, { id: c.assessmentId });
    assert.match(spa.text(), /Exam time limit reached/);
    assert.match(spa.text(), /cannot continue this exam/);
    assert.equal(spa.view.querySelector('#exam-enter'), null);
    assert.equal(spa.view.querySelector('#exam-next'), null);
  } finally { spa.teardown(); }
});
