import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';
import { withLock } from '../src/api/mutex.mjs';

async function preview(w, kind, id) {
  const result = await w.call('GET', `/admin/${kind}/${id}/purge-preview`, { token: w.tok });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const request = (p) => ({ password: ADMIN_PASSWORD, confirmation: 'DELETE', preview_token: p.preview_token });

test('permanent candidate purge previews and removes finalized reports, evidence, login and sessions, leaving other people intact', async (t) => {
  const w = await makeWorld({ t });
  const a = await w.assessorUser('purge.assessor');
  const c = await w.candidateUser('purge.candidate');
  const other = await w.candidateUser('keep.candidate');
  await w.walkAndSubmit(c.token, c.assessmentId);
  await w.assign(c.assessmentId, a.user.id);
  await w.scoreAndFinalize(a.token, c.assessmentId);
  await w.store.insert('recordings', { assessment_id: c.assessmentId, question_id: 'q', audio: { b64: 'AAAA', mime: 'audio/webm' } });
  const p = await preview(w, 'users', c.user.id);
  assert.equal(p.counts.reports, 1);
  assert.equal(p.counts.assessments, 1);
  assert.equal(p.counts.recordings, 1);
  assert.equal(p.counts.accounts, 1);
  assert.ok(p.counts.responses > 0);
  assert.ok(p.counts.audit_events > 0);
  assert.ok(!JSON.stringify(p).includes('password_hash'));
  const result = await w.call('DELETE', `/admin/users/${c.user.id}/purge`, { token: w.tok, body: request(p) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  for (const [table, id] of [['candidates', c.cand.id], ['users', c.user.id], ['assessments', c.assessmentId]]) assert.equal(await w.store.get(table, id), null);
  for (const table of ['responses', 'recordings']) assert.equal((await w.store.list(table, { assessment_id: c.assessmentId })).length, 0);
  assert.equal((await w.store.list('sessions', { user_id: c.user.id })).length, 0);
  assert.ok(await w.store.get('candidates', other.cand.id));
  assert.ok(await w.store.get('assessments', other.assessmentId));
  const events = await w.store.list('audit_log');
  assert.ok(events.some((e) => e.action === 'person_permanently_deleted'));
  assert.ok(!events.some((e) => e.actor_id === c.user.id || (e.entity === 'assessments' && e.entity_id === c.assessmentId)));
  assert.equal((await w.call('GET', '/candidate/assessments', { token: c.token })).status, 401);
});

test('purge requires admin authorization, current password, exact confirmation and an unchanged preview', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('gated.candidate');
  const p = await preview(w, 'candidates', c.cand.id);
  const path = `/admin/candidates/${c.cand.id}/purge`;
  assert.equal((await w.call('DELETE', path, { token: c.token, body: request(p) })).status, 403);
  assert.equal((await w.call('GET', `/admin/candidates/${c.cand.id}/purge-preview`, { token: c.token })).status, 403);
  assert.equal((await w.call('DELETE', path, { token: w.tok, body: {} })).status, 403);
  assert.equal((await w.call('DELETE', path, { token: w.tok, body: { ...request(p), password: 'wrong' } })).status, 403);
  assert.equal((await w.call('DELETE', path, { token: w.tok, body: { ...request(p), confirmation: 'delete' } })).status, 409);
  await w.store.insert('responses', { assessment_id: c.assessmentId, question_id: 'new', answer: 'New answer after preview' });
  assert.equal((await w.call('DELETE', path, { token: w.tok, body: request(p) })).status, 409);
  assert.ok(await w.store.get('users', c.user.id));
  assert.ok(await w.store.get('candidates', c.cand.id));
});

test('self and primary admin deletion are blocked at both preview and mutation', async (t) => {
  const w = await makeWorld({ t });
  const admin = (await w.store.list('users', { username: 'admin' }))[0];
  const p = await preview(w, 'users', admin.id);
  assert.match(p.blocked_reason, /own account/);
  assert.equal((await w.call('DELETE', `/admin/users/${admin.id}/purge`, { token: w.tok, body: request(p) })).status, 409);
  assert.ok(await w.store.get('users', admin.id));
});

test('staff deletion clears assignments and sessions without deleting candidates or their finalized reports', async (t) => {
  const w = await makeWorld({ t });
  const a = await w.assessorUser('deleted.assessor');
  const c = await w.candidateUser('retained.candidate');
  await w.assign(c.assessmentId, a.user.id);
  await w.store.update('candidates', c.cand.id, { assessor_id: a.user.id });
  await w.walkAndSubmit(c.token, c.assessmentId);
  await w.scoreAndFinalize(a.token, c.assessmentId);
  const p = await preview(w, 'users', a.user.id);
  assert.equal(p.retained_assessments, 1);
  assert.equal(p.cleared_candidate_assignments, 1);
  assert.equal(p.counts.assessments, 0);
  assert.equal((await w.call('DELETE', `/admin/users/${a.user.id}/purge`, { token: w.tok, body: request(p) })).status, 200);
  assert.equal(await w.store.get('users', a.user.id), null);
  const assessment = await w.store.get('assessments', c.assessmentId);
  assert.ok(assessment.report_json);
  assert.equal(assessment.assessor_id, null);
  assert.equal((await w.store.get('candidates', c.cand.id)).assessor_id, null);
});

test('storage failure blocks candidate access and allocations, and a new preview allows retry', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('retry.candidate');
  const p = await preview(w, 'candidates', c.cand.id);
  const remove = w.store.remove.bind(w.store);
  let failed = false;
  w.store.remove = async (table, id) => {
    if (table === 'assessments' && !failed) { failed = true; throw new Error('storage unavailable'); }
    return remove(table, id);
  };
  const path = `/admin/candidates/${c.cand.id}/purge`;
  assert.equal((await w.call('DELETE', path, { token: w.tok, body: request(p) })).status, 500);
  assert.equal((await w.store.get('users', c.user.id)).active, false);
  assert.equal((await w.store.get('candidates', c.cand.id)).deleting, true);
  assert.equal((await w.call('PATCH', `/admin/users/${c.user.id}`, { token: w.tok, body: { active: true } })).status, 409);
  assert.equal((await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: c.cand.id, role_id: w.role.id } })).status, 400);
  const fresh = await preview(w, 'candidates', c.cand.id);
  assert.equal((await w.call('DELETE', path, { token: w.tok, body: request(fresh) })).status, 200);
});

test('a login verified before deletion cannot issue a new session for a removed account', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('login.race');
  const list = w.store.list.bind(w.store);
  let found;
  const lookedUp = new Promise((resolve) => { found = resolve; });
  w.store.list = async (table, query, options) => {
    const rows = await list(table, query, options);
    if (table === 'users' && query?.username === 'login.race') found();
    return rows;
  };
  let login;
  await withLock(`identity:${c.user.id}`, async () => {
    login = w.call('POST', '/auth/login', { body: { username: 'login.race', password: 'User-pass-123' } });
    await lookedUp;
    await w.store.remove('users', c.user.id);
  });
  assert.equal((await login).status, 401);
  assert.equal((await w.store.list('sessions', { user_id: c.user.id })).length, 1, 'only the original session remains; no orphan session is issued');
});
