import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';

test('ordinary candidate deletion cannot remove a report finalized after its initial read', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const c = await w.candidateUser('delete.finalization.race');
  const assessor = await w.assessorUser('delete.race.assessor'); await w.assign(c.assessmentId, assessor.user.id);
  await w.walkAndSubmit(c.token, c.assessmentId);
  const list = w.store.list.bind(w.store); let finalize = true;
  w.store.list = async (table, filter, ...args) => {
    const rows = await list(table, filter, ...args);
    if (table === 'assessments' && filter?.candidate_id === c.cand.id && finalize) {
      finalize = false; await w.scoreAndFinalize(assessor.token, c.assessmentId);
    }
    return rows;
  };
  const result = await w.call('DELETE', `/admin/candidates/${c.cand.id}`, { token: w.tok, body: { password: ADMIN_PASSWORD } });
  assert.equal(result.status, 409);
  assert.ok(await w.store.get('candidates', c.cand.id));
  const paper = await w.store.get('assessments', c.assessmentId);
  assert.equal(paper.status, 'scored'); assert.ok(paper.report_json);
});

test('ordinary deletion failure disables the identity and allocation before cleanup, then recovers on retry', async (t) => {
  const w = await makeWorld({ t }); const c = await w.candidateUser('delete.cleanup.failure');
  const remove = w.store.removeMany.bind(w.store); let fail = true;
  w.store.removeMany = async (table, ids) => {
    if (table === 'sessions' && fail) { fail = false; throw new Error('session cleanup unavailable'); }
    return remove(table, ids);
  };
  const url = `/admin/candidates/${c.cand.id}`, body = { password: ADMIN_PASSWORD };
  assert.equal((await w.call('DELETE', url, { token: w.tok, body })).status, 500);
  assert.equal((await w.store.get('candidates', c.cand.id)).deleting, true);
  assert.equal((await w.store.get('users', c.user.id)).active, false);
  assert.equal((await w.call('GET', '/auth/me', { token: c.token })).status, 401);
  assert.equal((await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: c.cand.id, role_id: w.role.id } })).status, 400);
  assert.equal((await w.call('DELETE', url, { token: w.tok, body })).status, 200);
  assert.equal(await w.store.get('candidates', c.cand.id), null);
});
