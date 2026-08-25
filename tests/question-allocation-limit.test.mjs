import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

/** The product cap must work with a bank large enough to use all 50 seats. */
test('assessment allocation supports 50 questions and rejects 51', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-question-cap-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);
  const role = await store.insert('roles', { name: 'Large bank role', active: true });
  const competency = await store.insert('competencies', {
    role_id: role.id, name: 'Core capability', weight: 100, active: true, order: 1,
  });
  for (let i = 1; i <= 60; i += 1) {
    await store.insert('questions', {
      role_id: role.id, competency_id: competency.id, type: 'text', points: 1,
      prompt: `Question ${i}`, rubric: 'Look for a sound answer.', active: true, order: i,
    });
  }

  const admin = await store.insert('users', {
    username: 'cap-admin', name: 'Cap Admin', role: 'admin',
    password_hash: hashPassword('cap-admin-pass'), active: true,
  });
  const login = await app({
    method: 'POST', path: '/auth/login', body: { username: admin.username, password: 'cap-admin-pass' },
  });
  assert.equal(login.status, 200);
  const token = login.body.token;
  const call = (method, requestPath, body, query) => app({
    method, path: requestPath, body, query, headers: { authorization: `Bearer ${token}` },
  });

  const plan = await call('GET', `/admin/roles/${role.id}/question-plan`, undefined, { limit: '50' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.total, 50);
  assert.equal(plan.body.max_questions, 50);

  const candidate = await store.insert('candidates', { name: 'Fifty Seat Candidate', active: true });
  const allocated = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: role.id, question_count: 50,
  });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  assert.equal(allocated.body.snapshot_json.questions.length, 50);
  assert.equal(allocated.body.snapshot_json.question_limit, 50);

  const secondCandidate = await store.insert('candidates', { name: 'Over Cap Candidate', active: true });
  const overCap = await call('POST', '/admin/assessments', {
    candidate_id: secondCandidate.id, role_id: role.id, question_count: 51,
  });
  assert.equal(overCap.status, 400);
  assert.match(overCap.body.error, /cannot exceed 50/i);
});
