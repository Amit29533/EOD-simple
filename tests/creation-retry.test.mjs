import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, USER_PASSWORD } from './helpers/world.mjs';

test('account creation replay returns the original account and rejects changed request details', async (t) => {
  const w = await makeWorld({ t });
  const body = { username: 'retry.person', name: 'Retry Person', role: 'assessor', password: USER_PASSWORD, request_id: 'retry-request-123456' };
  const create = (data) => w.call('POST', '/admin/users', { token: w.tok, body: data });
  const first = await create(body);
  assert.equal(first.status, 201);
  const next = await create(body);
  assert.equal(next.status, 201);
  assert.equal(next.body.id, first.body.id);
  assert.equal((await create({ ...body, username: 'different.person' })).status, 409);
  assert.equal((await w.store.list('users', { role: 'assessor' })).length, 1);
});

test('manual allocation retries return the same paper and repair candidate stage', async (t) => {
  const w = await makeWorld({ t });
  const person = await w.candidateUser('retry.allocate', { allocate: false });
  const body = { candidate_id: person.cand.id, role_id: w.role.id, request_id: 'allocate-request-123456' };
  const allocate = () => w.call('POST', '/admin/assessments', { token: w.tok, body });
  const first = await allocate();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await w.store.update('candidates', person.cand.id, { stage: 'intake' });
  const retry = await allocate();
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  assert.equal((await w.store.list('assessments', { candidate_id: person.cand.id })).length, 1);
  assert.equal((await w.store.get('candidates', person.cand.id)).stage, 'assessment');
});

test('retry-safe finalization returns the saved report and repairs interrupted stage updates', async (t) => {
  const w = await makeWorld({ t });
  const person = await w.candidateUser('retry.finalize');
  const assessor = await w.assessorUser('retry.assessor');
  await w.assign(person.assessmentId, assessor.user.id);
  await w.walkAndSubmit(person.token, person.assessmentId);
  const first = await w.scoreAndFinalize(assessor.token, person.assessmentId);
  await w.store.update('candidates', person.cand.id, { stage: 'assessment' });
  const auditsBefore = (await w.store.list('audit_log')).filter((r) => r.action === 'assessment_scored').length;
  const retry = await w.call('POST', `/assessor/assessments/${person.assessmentId}/finalize`, { token: assessor.token, body: { retry_safe: true } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.report, first.report);
  assert.equal(retry.body.already, true);
  assert.equal((await w.store.get('candidates', person.cand.id)).stage, 'gap_mapping');
  assert.equal((await w.store.list('audit_log')).filter((r) => r.action === 'assessment_scored').length, auditsBefore);
});
