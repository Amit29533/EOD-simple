import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

let app, store, adminToken;
let roleA, roleB, compA, compB, candA, candB, userA;

const call = (method, route, { token, body, query } = {}) =>
  app({ method, path: route, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-admin-validation-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', email: '', active: true,
    password_hash: hashPassword('admin-pass-123'),
  });
  adminToken = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'admin-pass-123' } })).body.token;

  roleA = await store.insert('roles', { key: 'role-a', name: 'Role A', technology: 'A', description: '', active: true });
  roleB = await store.insert('roles', { key: 'role-b', name: 'Role B', technology: 'B', description: '', active: true });
  compA = await store.insert('competencies', { role_id: roleA.id, key: 'a', name: 'A', category: 'technical', weight: 100, target_level: 4, order: 1, active: true });
  compB = await store.insert('competencies', { role_id: roleB.id, key: 'b', name: 'B', category: 'technical', weight: 100, target_level: 4, order: 1, active: true });
  candA = await store.insert('candidates', { name: 'Candidate A', stage: 'intake', target_role_id: roleA.id });
  candB = await store.insert('candidates', { name: 'Candidate B', stage: 'intake', target_role_id: roleB.id });
  userA = await store.insert('users', {
    username: 'candidate.a', name: 'Candidate A', role: 'candidate', email: '', active: true,
    candidate_id: candA.id, password_hash: hashPassword('candidate-pass-123'),
  });
});

function validQuestion(overrides = {}) {
  return {
    role_id: roleA.id,
    competency_id: compA.id,
    type: 'mcq_single',
    prompt: 'Pick the correct answer.',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    correct_option_ids: ['a'],
    points: 4,
    difficulty: 'foundation',
    rubric: '',
    order: 1,
    active: true,
    ...overrides,
  };
}

test('admin question validation rejects competencies from another role', async () => {
  const create = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({ role_id: roleA.id, competency_id: compB.id }),
  });
  assert.equal(create.status, 400);
  assert.match(create.body.error, /competency.*selected role/i);

  const ok = await call('POST', '/admin/questions', { token: adminToken, body: validQuestion() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const patch = await call('PATCH', `/admin/questions/${ok.body.id}`, {
    token: adminToken,
    body: { competency_id: compB.id },
  });
  assert.equal(patch.status, 400);
  assert.match(patch.body.error, /competency.*selected role/i);

  const saved = await store.get('questions', ok.body.id);
  assert.equal(saved.competency_id, compA.id, 'failed PATCH leaves the existing competency unchanged');
});

test('candidate PATCH enforces the same field lengths and stage rules as create', async () => {
  // PATCH used to truncate at 200 while create capped at 120 — the same
  // candidate could hold two different validation rules depending on the path.
  const longName = `${'X'.repeat(150)} Name`;
  let res = await call('PATCH', `/admin/candidates/${candA.id}`, {
    token: adminToken, body: { name: longName },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, longName.slice(0, 120), 'PATCH truncates to the create limit');

  // An empty/unknown stage must not be storable (it used to slip through as '').
  res = await call('PATCH', `/admin/candidates/${candA.id}`, {
    token: adminToken, body: { stage: '' },
  });
  assert.equal(res.status, 400);
  const after = await store.get('candidates', candA.id);
  assert.equal(after.stage, 'intake', 'the failed patch left the stored stage untouched');

  // Clearing the target role is still allowed (maps to null).
  res = await call('PATCH', `/admin/candidates/${candA.id}`, {
    token: adminToken, body: { target_role_id: '' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.target_role_id, null);
});

test('candidate user relinking remains one-to-one and cannot be cleared', async () => {
  const clear = await call('PATCH', `/admin/users/${userA.id}`, {
    token: adminToken,
    body: { candidate_id: '' },
  });
  assert.equal(clear.status, 400);
  assert.match(clear.body.error, /must be linked/i);

  const userB = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'candidate.b', name: 'Candidate B', role: 'candidate', email: '',
      password: 'candidate-pass-123', candidate_id: candB.id,
    },
  });
  assert.equal(userB.status, 201, JSON.stringify(userB.body));

  const duplicate = await call('PATCH', `/admin/users/${userB.body.id}`, {
    token: adminToken,
    body: { candidate_id: candA.id },
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already has a portal user/i);

  const saved = await store.get('users', userB.body.id);
  assert.equal(saved.candidate_id, candB.id, 'failed relink leaves candidate user attached to original candidate');
});

test('editing a spoken question preserves its oral metadata (mic requirement, pin, set)', async () => {
  // Regression: normalizeQuestion dropped question_set / pin_first /
  // audio_required, so one admin edit (e.g. fixing a typo or toggling active)
  // silently removed the microphone control from a spoken question — and the
  // next catalogue sync re-inserted the published copy next to the edited
  // row, making the exam repeat the question.
  const created = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({
      type: 'text',
      prompt: 'Explain the RSA role to a client executive.',
      options: [],
      correct_option_ids: [],
      question_set: 'rsa-oral',
      pin_first: true,
      audio_required: true,
      rubric: 'Expected evidence: plain-language framing; a recommendation with rationale.',
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.question_set, 'rsa-oral', 'create keeps the spoken set');
  assert.equal(created.body.pin_first, true, 'create keeps the pin');
  assert.equal(created.body.audio_required, true, 'create keeps the mic requirement');

  const patched = await call('PATCH', `/admin/questions/${created.body.id}`, {
    token: adminToken,
    body: { points: 8, rubric: 'Expected evidence: trusted-advisor framing.' },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.points, 8);
  assert.equal(patched.body.question_set, 'rsa-oral', 'edit keeps the spoken set');
  assert.equal(patched.body.pin_first, true, 'edit keeps the pin');
  assert.equal(patched.body.audio_required, true, 'edit keeps the mic requirement');

  // Deactivating also survives, and an explicit body value still wins.
  const deactivated = await call('PATCH', `/admin/questions/${created.body.id}`, {
    token: adminToken,
    body: { active: false },
  });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.active, false);
  assert.equal(deactivated.body.audio_required, true, 'deactivation does not strip the mic flag');

  const unpinned = await call('PATCH', `/admin/questions/${created.body.id}`, {
    token: adminToken,
    body: { pin_first: false },
  });
  assert.equal(unpinned.status, 200);
  assert.equal(unpinned.body.pin_first, false, 'an explicit pin change is honoured');
  assert.equal(unpinned.body.audio_required, true, 'unpinning leaves the mic requirement intact');

  // Standard questions stay standard: nothing flags itself by default.
  const plain = await call('POST', '/admin/questions', { token: adminToken, body: validQuestion() });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.audio_required, false);
  assert.equal(plain.body.pin_first, false);
  assert.equal(plain.body.question_set, '');
});

test('an open question cannot be stored or edited into a typed-only question', async () => {
  // The microphone requirement is a property of the open-question type, so the
  // admin write path applies it whether or not the form sent anything, and
  // refuses to let an edit (or an explicit false) switch the recorder off.
  const created = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({
      type: 'text',
      prompt: 'Design the incremental migration for a 40 TB legacy EDW.',
      options: [], correct_option_ids: [], rubric: 'Expected evidence: phasing, dual-run, reconciliation.',
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.audio_required, true, 'a standard open question requires the microphone');

  const off = await call('PATCH', `/admin/questions/${created.body.id}`, {
    token: adminToken, body: { audio_required: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.audio_required, true, 'an explicit opt-out cannot silence an open question');

  // Non-open questions keep the old per-question behaviour in both directions.
  const optedIn = await call('POST', '/admin/questions', {
    token: adminToken, body: validQuestion({ audio_required: true }),
  });
  assert.equal(optedIn.body.audio_required, true, 'a choice question may opt in');
  const optedOut = await call('PATCH', `/admin/questions/${optedIn.body.id}`, {
    token: adminToken, body: { audio_required: false },
  });
  assert.equal(optedOut.body.audio_required, false, 'and opt out again');
});
