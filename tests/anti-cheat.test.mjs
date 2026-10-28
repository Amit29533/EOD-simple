import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { shuffleOptions } from '../src/core/paper-order.mjs';
import { awayPatch } from '../src/api/quiz-session.mjs';
import { integrityRisk } from '../src/core/integrity-risk.mjs';

const choice = (id, labels, extra = {}) => ({
  id, type: 'mcq_single', correct_option_ids: ['a'],
  options: labels.map((label, i) => ({ id: String.fromCharCode(97 + i), label })), ...extra,
});
// A deterministic generator that always moves something, so "shuffled" is provable.
const reverseRng = () => 0;

/* ------------------------------ option shuffling ------------------------------ */

test('options: choice questions are reordered by id, keys untouched; the rest keep their order', () => {
  const rows = [
    choice('q1', ['Alpha', 'Bravo', 'Charlie', 'Delta']),
    choice('q2', ['Alpha', 'Bravo', 'Charlie'], { randomizable: false }),
    choice('q3', ['Spark', 'Delta', 'All of the above']),
    choice('q4', ['Only A', 'Both A and B', 'Neither']),
    { id: 'q5', type: 'text', options: [] },
    { id: 'q6', type: 'scale', options: [{ id: '1', label: 'Low' }, { id: '2', label: 'High' }] },
  ];
  const out = shuffleOptions(rows, reverseRng);
  assert.notDeepEqual(out[0].options.map((o) => o.id), ['a', 'b', 'c', 'd'], 'a choice question is reordered');
  assert.deepEqual([...out[0].options.map((o) => o.id)].sort(), ['a', 'b', 'c', 'd'], 'no option is lost or invented');
  assert.deepEqual(out[0].correct_option_ids, ['a'], 'the answer key is an id and does not move');
  assert.equal(out[0].options_shuffled, true);
  for (const i of [1, 2, 3, 4, 5]) assert.equal(out[i], rows[i], `${rows[i].id} keeps its authored order`);
  assert.deepEqual(rows[0].options.map((o) => o.id), ['a', 'b', 'c', 'd'], 'the bank row is not mutated');
  assert.equal(shuffleOptions([out[0]], reverseRng)[0], out[0], 'a frozen paper is never reshuffled');
});

test('options: every newly allocated paper freezes its own order and still scores by id', async (t) => {
  const w = await makeWorld({ t, mcq: 4, open: 0 });
  const orders = new Set();
  for (let i = 0; i < 6; i += 1) {
    const { assessmentId } = await w.candidateUser(`shuffle.${i}`);
    const a = await w.store.get('assessments', assessmentId);
    for (const q of a.snapshot_json.questions.filter((x) => x.type === 'mcq_single')) {
      assert.equal(q.options_shuffled, true);
      orders.add(q.options.map((o) => o.id).join(''));
    }
  }
  assert.ok(orders.size > 1, 'different candidates see different option orders');
  // The helper answers 'a' (the correct id) and scoring still awards it.
  const { token, assessmentId } = await w.candidateUser('shuffle.scored');
  await w.walkAndSubmit(token, assessmentId);
  const rows = await w.store.list('responses', { assessment_id: assessmentId });
  assert.ok(rows.length && rows.every((r) => r.auto_score > 0), 'correct ids score whatever the display order');
});

/* -------------------------------- time away -------------------------------- */

test('time away: absences are timed on the server clock, capped, and a repeat leave does not restart one', () => {
  const t0 = Date.parse('2026-10-28T10:00:00Z');
  let away = awayPatch(undefined, 'tab_switch', t0);
  assert.equal(away.count, 1);
  assert.equal(awayPatch(away, 'browser_close', t0 + 5000), null, 'already away: the clock keeps running from the first leave');
  away = awayPatch(away, 'tab_return', t0 + 90_000);
  assert.deepEqual(away, { total_ms: 90_000, longest_ms: 90_000, count: 1, since: null });
  away = awayPatch(awayPatch(away, 'exam_exit', t0 + 100_000), 'exam_reopen', t0 + 130_000);
  assert.deepEqual(away, { total_ms: 120_000, longest_ms: 90_000, count: 2, since: null });
  assert.equal(awayPatch(away, 'tab_return', t0 + 200_000), null, 'a return without a leave changes nothing');
  const moved = awayPatch(awayPatch(undefined, 'browser_close', t0), 'device_switch', t0 + 45_000);
  assert.deepEqual(moved, { total_ms: 45_000, longest_ms: 45_000, count: 1, since: null }, 'continuing on another device ends the absence');
  const long = awayPatch(awayPatch(undefined, 'tab_switch', t0), 'tab_return', t0 + 10 * 60 * 60 * 1000);
  assert.equal(long.total_ms, 2 * 60 * 60 * 1000, 'one absence never exceeds the two-hour window');
});

test('time away: the exam API records leaving and returning', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const { token, assessmentId } = await w.candidateUser('away.cand');
  assert.equal((await w.call('GET', `/candidate/assessments/${assessmentId}`, { token })).status, 200);
  const beacon = (event) => w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, { token, body: { event } });
  assert.equal((await beacon('tab_switch')).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await beacon('tab_return')).status, 200);
  const a = await w.store.get('assessments', assessmentId);
  assert.equal(a.quiz_state.away.count, 1);
  assert.ok(a.quiz_state.away.total_ms >= 20, `away time measured (${a.quiz_state.away.total_ms} ms)`);
  assert.equal(a.quiz_state.away.since, null);
});

/* ------------------------------- risk flag ------------------------------- */

test('risk: ordinary noise stays low; patterns, absences and devices escalate with reasons', () => {
  assert.equal(integrityRisk(undefined).level, 'low');
  assert.equal(integrityRisk({ integrity: { tab_switch: 1, window_blur: 2, fullscreen_exit: 1, copy_attempt: 1 } }).level, 'low', 'one of each innocent event is not a flag');
  const review = integrityRisk({ integrity: { tab_switch: 3 }, away: { total_ms: 90_000, longest_ms: 60_000, count: 3 } });
  assert.equal(review.level, 'review');
  assert.match(review.reasons.join(' | '), /3 tab switches/);
  assert.match(review.reasons.join(' | '), /1m 30s away/);
  const high = integrityRisk({ integrity: { multi_window: 1, devtools_key: 2, device_switch: 1 } });
  assert.equal(high.level, 'high');
  assert.match(high.reasons[0], /developer-tools|device|window/);
  const gone = integrityRisk({ integrity: { tab_switch: 1 }, away: { since: '2026-10-28T10:00:00Z', count: 1 } });
  assert.match(gone.reasons.join(' '), /had not returned/);
  assert.equal(integrityRisk({ integrity: { tab_switch: 'x', constructor: 9 } }).level, 'low', 'junk counters are ignored');
});

test('risk: admins and assessors see the flag; the candidate never does', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const { token, assessmentId } = await w.candidateUser('risk.cand');
  await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
  for (const event of ['tab_switch', 'tab_return', 'multi_window', 'devtools_key', 'devtools_key']) {
    await w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, { token, body: { event } });
  }
  const list = await w.call('GET', '/admin/assessments', { token: w.tok });
  assert.equal(list.body.assessments.find((a) => a.id === assessmentId).integrity_risk.level, 'high');
  const trail = await w.call('GET', `/admin/assessments/${assessmentId}/integrity`, { token: w.tok });
  assert.equal(trail.body.integrity_risk.level, 'high');
  assert.ok(trail.body.integrity_risk.reasons.length >= 2);
  const exam = await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
  assert.doesNotMatch(JSON.stringify(exam.body), /integrity_risk|"device"|"away"/, 'the candidate payload carries no risk, device or absence data');
  await w.walkAndSubmit(token, assessmentId);
  const { user: assessor, token: aTok } = await w.assessorUser('risk.assessor');
  await w.assign(assessmentId, assessor.id);
  const review = await w.call('GET', `/assessor/assessments/${assessmentId}`, { token: aTok });
  assert.equal(review.body.assessment.integrity_risk.level, 'high');
});

/* ----------------------------- one device at a time ----------------------------- */
// The exam app sends a random id it keeps per browser; these stand in for two browsers.
const LAPTOP = { 'x-ecod-device': 'laptop-0000-1111' };
const PHONE = { 'x-ecod-device': 'phone-2222-3333' };

test('one device: a second browser is refused until it deliberately takes the exam over', async (t) => {
  const w = await makeWorld({ t, mcq: 3, open: 0 });
  const { token: first, assessmentId } = await w.candidateUser('device.cand');
  const second = await w.login('device.cand');
  const path = `/candidate/assessments/${assessmentId}`;
  assert.equal((await w.call('GET', path, { token: first, headers: LAPTOP })).status, 200);

  const refused = await w.call('GET', path, { token: second, headers: PHONE });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'EXAM_OTHER_DEVICE');
  const q = (await w.call('GET', path, { token: first, headers: LAPTOP })).body.current_question;
  const blocked = await w.call('POST', `${path}/next`, { token: second, headers: PHONE, body: { question_id: q.id, answer: 'a' } });
  assert.equal(blocked.status, 409, 'the second browser cannot answer either');
  assert.equal((await w.call('POST', `${path}/integrity`, { token: second, headers: PHONE, body: { event: 'tab_switch' } })).status, 409);

  const moved = await w.call('GET', path, { token: second, headers: PHONE, query: { takeover: '1' } });
  assert.equal(moved.status, 200, 'taking over is allowed');
  assert.equal(moved.body.exam.index, 0, 'the paper continues where it was, the clock is not reset');
  const old = await w.call('POST', `${path}/next`, { token: first, headers: LAPTOP, body: { question_id: q.id, answer: 'a' } });
  assert.equal(old.status, 409, 'the first browser is now the refused one');
  assert.equal(old.body.code, 'EXAM_OTHER_DEVICE');
  assert.equal((await w.call('POST', `${path}/next`, { token: second, headers: PHONE, body: { question_id: q.id, answer: 'a' } })).status, 200);

  const a = await w.store.get('assessments', assessmentId);
  assert.equal(a.quiz_state.integrity.device_switch, 1);
  assert.ok(a.quiz_state.events.some((e) => e.event === 'device_switch'));
});

test('one device: signing out and in again on the same browser is not a second device', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const { token, assessmentId } = await w.candidateUser('relogin.cand');
  const path = `/candidate/assessments/${assessmentId}`;
  assert.equal((await w.call('GET', path, { token, headers: LAPTOP })).status, 200);
  await w.call('POST', '/auth/logout', { token });
  const again = await w.login('relogin.cand');
  assert.equal((await w.call('GET', path, { token: again, headers: LAPTOP })).status, 200);
  const a = await w.store.get('assessments', assessmentId);
  assert.equal(a.quiz_state.integrity.device_switch || 0, 0, 'no device switch is recorded');
});

test('one device: the bound browser changing network address is logged, not blocked', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const { token, assessmentId } = await w.candidateUser('ip.cand');
  const get = (ip) => w.app({ method: 'GET', path: `/candidate/assessments/${assessmentId}`, headers: { authorization: `Bearer ${token}`, ...LAPTOP }, ip });
  assert.equal((await get('198.51.100.1')).status, 200);
  assert.equal((await get('198.51.100.1')).status, 200);
  assert.equal((await get('198.51.100.2')).status, 200);
  const a = await w.store.get('assessments', assessmentId);
  assert.equal(a.quiz_state.integrity.ip_change, 1);
  assert.equal(a.quiz_state.device.ip, '198.51.100.2');
});

test('one device: an exam already in progress before this rule binds to its next request, nobody is locked out', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const { token, assessmentId } = await w.candidateUser('legacy.cand');
  // Opened by the previous release: no browser id, so no binding at all.
  assert.equal((await w.call('GET', `/candidate/assessments/${assessmentId}`, { token })).status, 200);
  assert.equal((await w.store.get('assessments', assessmentId)).quiz_state.device, undefined, 'a client without a browser id is not bound');
  const r = await w.call('GET', `/candidate/assessments/${assessmentId}`, { token, headers: LAPTOP });
  assert.equal(r.status, 200, 'the first request after the deploy is accepted');
  const after = await w.store.get('assessments', assessmentId);
  assert.equal(after.quiz_state.device?.session, LAPTOP['x-ecod-device'], 'and binds the paper from then on');
  assert.equal(after.quiz_state.integrity.device_switch || 0, 0, 'adopting an unbound paper is not a device switch');
  assert.equal((await w.call('GET', `/candidate/assessments/${assessmentId}`, { token, headers: PHONE })).status, 409, 'another browser is refused afterwards');
});

test('one device: a draft sent before the exam hall opens neither binds the paper nor counts as an answer', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const { token, assessmentId } = await w.candidateUser('early.cand');
  const before = await w.store.get('assessments', assessmentId);
  const qid = before.snapshot_json.questions[0].id;
  const r = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, headers: LAPTOP, body: { answers: { [qid]: 'a' } } });
  assert.ok(r.status < 500);
  const after = await w.store.get('assessments', assessmentId);
  assert.equal(after.quiz_state?.device, undefined, 'the paper is not bound by a draft');
  assert.equal((await w.store.list('responses', { assessment_id: assessmentId })).length, 0, 'nothing was saved');
});
