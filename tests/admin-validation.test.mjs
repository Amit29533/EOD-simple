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
