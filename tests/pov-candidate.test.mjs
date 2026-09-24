/**
 * Candidate point of view, through the real app (in-process, JSON store).
 *
 * What a candidate can do, what they can see, and what they cannot reach,
 * from sign-in to the released report. Each world is fresh (tests/helpers/world.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { MAX_INTEGRITY_EVENTS } from '../src/api/quiz-session.mjs';

/* ------------------------------------------------------------ integrity beacons */

test('a nameless integrity beacon is refused before any write and never reaches the audit log', async (t) => {
  const w = await makeWorld({ t });
  const { token, assessmentId } = await w.candidateUser('beacon.cand');
  assert.ok(assessmentId, 'onboarding allocated a paper');
  assert.equal((await w.call('GET', `/candidate/assessments/${assessmentId}`, { token })).status, 200);

  const before = await w.store.get('assessments', assessmentId);
  const auditBefore = (await w.store.list('audit_log')).length;
  let assessmentWrites = 0;
  const update = w.store.update.bind(w.store);
  w.store.update = async (table, ...rest) => {
    if (table === 'assessments') assessmentWrites += 1;
    return update(table, ...rest);
  };

  for (const body of [{}, { event: '' }, { event: '   ' }, { event: null }, { event: 42 }, { event: { name: 'x' } }, { detail: 'no name' }]) {
    const r = await w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, { token, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
    assert.match(r.body.error, /event name is required/i);
  }
  assert.equal(assessmentWrites, 0, 'a refused beacon writes nothing');
  assert.equal((await w.store.list('audit_log')).length, auditBefore, 'a refused beacon audits nothing');
  assert.deepEqual((await w.store.get('assessments', assessmentId)).quiz_state, before.quiz_state);

  // A named event still lands in both trails, trimmed.
  const named = await w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, {
    token, body: { event: '  tab_switch ', detail: 'Browser tab switched' },
  });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.integrity.tab_switch, 1);
  const rows = await w.store.list('audit_log');
  assert.equal(rows.filter((e) => e.action === 'integrity_tab_switch').length, 1);
  assert.equal(rows.filter((e) => e.action === 'integrity_integrity').length, 0, 'no anonymous mirror rows');
});

test('a flood of nameless beacons cannot push admin actions out of the audit log', async (t) => {
  const w = await makeWorld({ t });
  const { token, assessmentId } = await w.candidateUser('flood.cand');
  const adminRows = (await w.store.list('audit_log')).filter((e) => !String(e.action).startsWith('integrity_')).length;
  for (let i = 0; i < MAX_INTEGRITY_EVENTS + 50; i += 1) {
    await w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, { token, body: i % 2 ? {} : { event: '' } });
  }
  const rows = await w.store.list('audit_log');
  assert.equal(rows.filter((e) => String(e.action).startsWith('integrity_')).length, 0);
  assert.equal(rows.filter((e) => !String(e.action).startsWith('integrity_')).length, adminRows, 'admin history intact');
});

test('autosave: an array is not "an object keyed by question id" — 400, like every other array body', async (t) => {
  const w = await makeWorld({ t });
  const { token, assessmentId } = await w.candidateUser('array.draft');
  await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
  const res = await w.call('PUT', `/candidate/assessments/${assessmentId}/answers`, { token, body: { answers: [] } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /object keyed by question id/);
});
