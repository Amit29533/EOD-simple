import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { autoAllocateAssessment } from '../src/api/assessment-service.mjs';

const configure = (w, role, id) => w.call('PATCH', `/admin/roles/${role.id}`, {
  token: w.tok, body: { default_assessor_id: id },
});
async function booking(w, role = w.role, extra = {}) {
  const link = await w.call('POST', '/admin/test-bookings/links', { token: w.tok, body: { role_id: role.id } });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const body = { token: link.body.path.split('/').at(-1), role_id: role.id,
    name: 'Booked Candidate', email: `${link.body.invitation.id}@example.com`, phone: '+919876543210',
    date: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), time: '10:00',
    password: 'Candidate-password-2026', confirm_password: 'Candidate-password-2026',
    request_id: 'default-assessor-booking-request', ...extra };
  const result = await w.call('POST', '/public/test-bookings', { body });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = await w.store.get('test_bookings', link.body.invitation.id);
  return { row, body, assessment: await w.store.get('assessments', row.assessment_id) };
}

test('track settings validate assessor eligibility, clear safely, and restrict writes to admins', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('default');
  assert.equal((await configure(w, w.role, a.user.id)).status, 200);
  const detail = (await w.call('GET', `/admin/roles/${w.role.id}`, { token: w.tok })).body.role;
  assert.equal(detail.default_assessor_name, a.user.name);
  assert.equal(detail.default_assessor_active, true);
  const list = (await w.call('GET', '/admin/roles', { token: w.tok })).body.roles;
  assert.equal(list[0].default_assessor_id, a.user.id);
  for (const id of ['missing', (await w.store.list('users', { role: 'admin' }))[0].id, {}, 123, true]) {
    assert.equal((await configure(w, w.role, id)).status, 400);
    assert.equal((await w.store.get('roles', w.role.id)).default_assessor_id, a.user.id);
  }
  assert.equal((await w.call('PATCH', `/admin/roles/${w.role.id}`, { token: a.token, body: { default_assessor_id: a.user.id } })).status, 403);
  await w.store.update('users', a.user.id, { active: false });
  const inactive = (await w.call('GET', `/admin/roles/${w.role.id}`, { token: w.tok })).body.role;
  assert.equal(inactive.default_assessor_active, false);
  assert.equal((await configure(w, w.role, a.user.id)).status, 200, 'preserves unchanged stale setting during unrelated edits');
  assert.equal((await configure(w, w.role, null)).status, 200);
  assert.equal((await configure(w, w.role, a.user.id)).status, 400, 'cannot newly select an inactive assessor');
  assert.equal((await configure(w, w.role, '')).status, 200);
  assert.equal((await w.store.get('roles', w.role.id)).default_assessor_id, null);
});

test('track creation accepts an eligible default and rejects invalid defaults', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('creator');
  const body = { key: 'new-track', name: 'New track', technology: 'Testing', default_assessor_id: 'missing' };
  assert.equal((await w.call('POST', '/admin/roles', { token: w.tok, body })).status, 400);
  const created = await w.call('POST', '/admin/roles', { token: w.tok, body: { ...body, default_assessor_id: a.user.id } });
  assert.equal(created.status, 201); assert.equal(created.body.default_assessor_id, a.user.id);
});

test('RSA and SAMA bookings inherit their own defaults, ignore forged input, and reach the correct assessor queue', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('rsa'), b = await w.assessorUser('sama');
  const papers = [];
  for (const [key, user] of [['databricks-rsa', a], ['technology-risk-sama', b]]) {
    const installed = await w.call('POST', '/admin/content/tracks', { token: w.tok, body: { role_key: key } });
    assert.equal(installed.status, 201);
    const role = installed.body.role;
    assert.equal((await configure(w, role, user.user.id)).status, 200);
    const booked = await booking(w, role, { assessor_id: 'forged-admin-input' });
    assert.equal(booked.assessment.assessor_id, user.user.id);
    assert.equal((await w.store.get('candidates', booked.row.candidate_id)).assessor_id, user.user.id);
    assert.equal(booked.assessment.snapshot_json.questions.length, key === 'databricks-rsa' ? 50 : 30);
    papers.push(booked.assessment.id);
  }
  for (const [i, user] of [a, b].entries()) {
    const queue = await w.call('GET', '/assessor/assessments', { token: user.token });
    assert.equal(queue.status, 200); assert.deepEqual(queue.body.assessments.map((p) => p.id), [papers[i]]);
  }
});

test('changing a default affects future bookings; replay and provisioning repair preserve an existing reassignment', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('first'), b = await w.assessorUser('second');
  await configure(w, w.role, a.user.id);
  const first = await booking(w);
  await configure(w, w.role, b.user.id);
  assert.equal((await w.call('POST', '/public/test-bookings', { body: first.body })).status, 200);
  assert.equal((await w.store.get('assessments', first.assessment.id)).assessor_id, a.user.id);
  const second = await booking(w); assert.equal(second.assessment.assessor_id, b.user.id);
  const reassigned = await w.call('PATCH', `/admin/assessments/${first.assessment.id}`, {
    token: w.tok, body: { assessor_id: b.user.id },
  });
  assert.equal(reassigned.status, 200);
  await configure(w, w.role, a.user.id);
  // Simulate interruption after paper creation but before clearing the provisioning plan.
  await w.store.update('test_bookings', first.row.id, { assessment_id: null, provisioning_json: {
    password_hash: (await w.store.get('users', first.row.user_id)).password_hash,
    snapshot: first.assessment.snapshot_json,
  } });
  await w.call('GET', '/admin/test-bookings', { token: w.tok });
  assert.equal((await w.store.get('assessments', first.assessment.id)).assessor_id, b.user.id);
  assert.equal((await w.store.list('assessments')).length, 2);
});

test('missing, deactivated and deleted track defaults leave new bookings safely unassigned', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('unavailable');
  assert.equal((await booking(w)).assessment.assessor_id, null);
  await configure(w, w.role, a.user.id);
  await w.store.update('users', a.user.id, { active: false });
  assert.equal((await booking(w)).assessment.assessor_id, null);
  await w.store.remove('users', a.user.id);
  assert.equal((await booking(w)).assessment.assessor_id, null);
});

test('single-user automatic allocation honors explicit and candidate choices before the track default', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('track'), b = await w.assessorUser('chosen');
  await configure(w, w.role, a.user.id);
  const c = await w.candidateUser('automatic');
  assert.equal((await w.store.get('assessments', c.assessmentId)).assessor_id, a.user.id);
  const candidate = await w.store.insert('candidates', { name: 'Preferred', target_role_id: w.role.id, assessor_id: b.user.id });
  const allocated = await autoAllocateAssessment(w.store, candidate, { assessorId: 'invalid' });
  assert.equal(allocated.assessment.assessor_id, b.user.id);
  const other = await w.store.insert('candidates', { name: 'Override', target_role_id: w.role.id, assessor_id: a.user.id });
  assert.equal((await autoAllocateAssessment(w.store, other, { assessorId: b.user.id })).assessment.assessor_id, b.user.id);
  await w.store.update('users', b.user.id, { active: false });
  const stale = await w.store.insert('candidates', { name: 'Stale choice', target_role_id: w.role.id, assessor_id: b.user.id });
  assert.equal((await autoAllocateAssessment(w.store, stale)).assessment.assessor_id, a.user.id);
});

test('CSV dry run and commit use track defaults, while dialog and row choices override them', async (t) => {
  const w = await makeWorld({ t }); const a = await w.assessorUser('track'), b = await w.assessorUser('dialog');
  await configure(w, w.role, a.user.id);
  for (const [suffix, override] of [['track', null], ['dialog', b.user.id]]) {
    const body = { create_users: true, filename: 'defaults.csv',
      csv: `Name,Email,Target role\nCSV ${suffix},${suffix}@example.com,POV Track`, ...(override ? { assessor_id: override } : {}) };
    const dry = await w.call('POST', '/admin/candidates/import', { token: w.tok, body: { ...body, dry_run: true } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.preview[0].assessor, override ? b.user.name : a.user.name);
    const saved = await w.call('POST', '/admin/candidates/import', { token: w.tok, body });
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.imported, 1);
    const candidate = (await w.store.list('candidates', { email: `${suffix}@example.com` }))[0];
    assert.equal(candidate.assessor_id, override || a.user.id);
    assert.equal((await w.store.list('assessments', { candidate_id: candidate.id }))[0].assessor_id, override || a.user.id);
  }
  const row = await w.call('POST', '/admin/candidates/import', { token: w.tok, body: {
    create_users: true, assessor_id: b.user.id, filename: 'row.csv',
    csv: 'Name,Email,Target role,Assessor\nRow Choice,row@example.com,POV Track,track',
  } });
  assert.equal(row.status, 200); assert.equal(row.body.imported, 1);
  const candidate = (await w.store.list('candidates', { email: 'row@example.com' }))[0];
  assert.equal(candidate.assessor_id, a.user.id);
  assert.equal((await w.store.list('assessments', { candidate_id: candidate.id }))[0].assessor_id, a.user.id);
});
