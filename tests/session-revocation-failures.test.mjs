import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';

test('password reset revokes tokens even when session row deletion fails', async (t) => {
  const w = await makeWorld({ t });
  const assessor = await w.assessorUser('revocation.assessor');
  const remove = w.store.remove.bind(w.store);
  w.store.remove = async (table, id) => {
    if (table === 'sessions') throw new Error('simulated cleanup failure');
    return remove(table, id);
  };
  const reset = await w.app({ method: 'PATCH', path: `/admin/users/${assessor.user.id}`,
    headers: { authorization: `Bearer ${w.tok}` }, body: { password: 'new-password-2026' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const old = await w.app({ method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${assessor.token}` } });
  assert.equal(old.status, 401);
});

test('invalid session expiry is rejected and logout storage failure is reported', async (t) => {
  const w = await makeWorld({ t });
  const user = await w.assessorUser('expiry.assessor');
  const session = (await w.store.list('sessions', { user_id: user.user.id }))[0];
  await w.store.update('sessions', session.id, { expires_at: 'not-a-date' });
  assert.equal((await w.app({ method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${user.token}` } })).status, 401);
  const other = await w.assessorUser('logout.assessor');
  w.store.remove = async () => { throw new Error('simulated failure'); };
  const logout = await w.app({ method: 'POST', path: '/auth/logout', headers: { authorization: `Bearer ${other.token}` } });
  assert.equal(logout.status, 500);
});

test('each role can change its own password, preserving this session and rejecting other sessions', async (t) => {
  for (const role of ['candidate', 'assessor', 'admin']) {
    const w = await makeWorld({ t });
    const person = role === 'candidate' ? await w.candidateUser('password.candidate')
      : role === 'assessor' ? await w.assessorUser('password.assessor')
      : { token: w.tok, user: (await w.store.list('users', { username: 'admin' }))[0] };
    const oldPassword = role === 'admin' ? 'Admin-pass-123' : 'User-pass-123';
    const otherToken = await w.login(person.user.username, oldPassword);
    const change = (body) => w.call('POST', '/auth/password', { token: person.token, body });
    assert.equal((await change({ current_password: 'wrong', new_password: 'new-password-2026' })).status, 403);
    assert.equal((await change({ current_password: oldPassword, new_password: 'short' })).status, 400);
    assert.equal((await change({ current_password: oldPassword, new_password: 'new-password-2026' })).status, 200);
    assert.equal((await w.call('GET', '/auth/me', { token: person.token })).status, 200);
    assert.equal((await w.call('GET', '/auth/me', { token: otherToken })).status, 401);
    assert.equal((await w.call('POST', '/auth/login', { body: { username: person.user.username, password: oldPassword } })).status, 401);
    assert.ok(await w.login(person.user.username, 'new-password-2026'));
  }
});

test('finalization refuses invalid persisted manual scores instead of generating an inflated report', async (t) => {
  const w = await makeWorld({ t });
  const assessor = await w.assessorUser('invalidscores.assessor');
  const candidate = await w.candidateUser('invalidscores.candidate');
  await w.walkAndSubmit(candidate.token, candidate.assessmentId);
  await w.assign(candidate.assessmentId, assessor.user.id);
  const rows = await w.store.list('responses', { assessment_id: candidate.assessmentId });
  const questions = (await w.store.get('assessments', candidate.assessmentId)).snapshot_json.questions.filter((q) => q.type === 'text');
  for (const q of questions) await w.store.update('responses', rows.find((r) => r.question_id === q.id).id, { assessor_score: 3 });
  const row = rows.find((r) => r.question_id === questions[0].id);
  for (const bad of [-1, 999, true, [2], '0x2', '']) {
    await w.store.update('responses', row.id, { assessor_score: bad });
    const res = await w.call('POST', `/assessor/assessments/${candidate.assessmentId}/finalize`, { token: assessor.token });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal((await w.store.get('assessments', candidate.assessmentId)).status, 'submitted');
  }
});
