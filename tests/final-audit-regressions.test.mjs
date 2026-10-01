import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, USER_PASSWORD } from './helpers/world.mjs';
import { advanceStage } from '../src/api/assessment-service.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

test('stage advancement reads inside the conditional mutation and never regresses or updates a deleting candidate', async (t) => {
  const w = await makeWorld({ t });
  const candidate = await w.store.insert('candidates', { name: 'Stage race', stage: 'intake' });
  await w.store.update('candidates', candidate.id, { stage: 'gap_mapping' });
  const get = w.store.get.bind(w.store);
  w.store.get = (table, id) => table === 'candidates' && id === candidate.id ? Promise.resolve(candidate) : get(table, id);
  await advanceStage(w.store, candidate.id, 'assessment');
  assert.equal((await get('candidates', candidate.id)).stage, 'gap_mapping');
  await w.store.update('candidates', candidate.id, { stage: 'intake', deleting: true });
  await advanceStage(w.store, candidate.id, 'gap_mapping');
  assert.equal((await get('candidates', candidate.id)).stage, 'intake');
  await advanceStage(w.store, candidate.id, 'invalid-stage');
  assert.equal((await get('candidates', candidate.id)).stage, 'intake');
});

test('a password change cannot overwrite a reset committed while it was verifying credentials', async (t) => {
  const w = await makeWorld({ t });
  const person = await w.assessorUser('reset.race');
  const resetHash = hashPassword('Admin-reset-password-2026');
  const update = w.store.update.bind(w.store);
  let reset = false;
  w.store.update = async (table, id, patch) => {
    if (table === 'sessions' && patch.session_generation && !reset) {
      reset = true;
      await update('users', person.user.id, { password_hash: resetHash, session_generation: 'admin-reset-generation' });
    }
    return update(table, id, patch);
  };
  const result = await w.call('POST', '/auth/password', { token: person.token,
    body: { current_password: USER_PASSWORD, new_password: 'Candidate-change-password-2026' } });
  assert.equal(result.status, 401);
  assert.equal(reset, true);
  const user = await w.store.get('users', person.user.id);
  assert.equal(user.password_hash, resetHash);
  assert.equal(user.session_generation, 'admin-reset-generation');
  assert.equal((await w.call('GET', '/auth/me', { token: person.token })).status, 401);
});

test('assessor progress counts valid scores on served open questions only', async (t) => {
  const w = await makeWorld({ t });
  const person = await w.candidateUser('progress.candidate');
  const staff = await w.assessorUser('progress.assessor');
  const paper = (await w.store.list('assessments', { candidate_id: person.cand.id }))[0];
  await w.store.update('assessments', paper.id, { status: 'submitted', assessor_id: staff.user.id });
  const open = paper.snapshot_json.questions.filter((q) => q.type === 'text');
  const objective = paper.snapshot_json.questions.find((q) => q.type !== 'text');
  await w.store.insert('responses', { assessment_id: paper.id, question_id: open[0].id, assessor_score: 3 });
  await w.store.insert('responses', { assessment_id: paper.id, question_id: open[1].id, assessor_score: 'invalid' });
  await w.store.insert('responses', { assessment_id: paper.id, question_id: objective.id, assessor_score: 3 });
  await w.store.insert('responses', { assessment_id: paper.id, question_id: 'removed-question', assessor_score: 3 });
  const detail = await w.call('GET', `/assessor/assessments/${paper.id}`, { token: staff.token });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.scoring_progress, { manual_total: 2, manual_scored: 1 });
  assert.equal((await w.call('POST', `/assessor/assessments/${paper.id}/finalize`, { token: staff.token })).status, 422);
});
