import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

/**
 * The duplicate-prompt rule is a check-then-write. The create routes hold a
 * lock while they run it (per role for `questions`, per bank for the module
 * bank); the PATCH routes used to run the same check unlocked, so two
 * concurrent renames onto one prompt — or a rename racing a create — both
 * passed the check before either wrote, and both landed: the same question
 * twice in one bank, which is literally the same question asked twice on a
 * paper. These tests fire the pairs concurrently and count the winners.
 */

let app, store, adminToken, role, comp;
const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-duprace-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'admin', password_hash: hashPassword('pw-admin'), name: 'Admin',
    role: 'admin', email: '', active: true,
  });
  role = await store.insert('roles', { key: 'race-track', name: 'Race Track', technology: 'X', active: true });
  comp = await store.insert('competencies', {
    role_id: role.id, key: 'race-comp', name: 'Race Competency', weight: 100, target_level: 5, active: true,
  });
  adminToken = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'pw-admin' } })).body.token;
});

const roleQuestion = (prompt) => ({
  role_id: role.id, competency_id: comp.id, type: 'mcq_single', prompt,
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  correct_option_ids: ['a'], points: 4, difficulty: 'foundation', active: true,
});

const countRoleQuestionsWithPrompt = async (prompt) =>
  (await store.list('questions', { role_id: role.id })).filter((q) => q.prompt === prompt).length;

test('two concurrent renames onto one prompt: exactly one wins (role bank)', async () => {
  const q1 = await call('POST', '/admin/questions', { token: adminToken, body: roleQuestion('Race prompt one.') });
  const q2 = await call('POST', '/admin/questions', { token: adminToken, body: roleQuestion('Race prompt two.') });
  assert.equal(q1.status, 201);
  assert.equal(q2.status, 201);

  const target = 'Both renames race onto this prompt.';
  const [r1, r2] = await Promise.all([
    call('PATCH', `/admin/questions/${q1.body.id}`, { token: adminToken, body: { prompt: target } }),
    call('PATCH', `/admin/questions/${q2.body.id}`, { token: adminToken, body: { prompt: target } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `one rename lands, the other is refused: got ${statuses}`);
  assert.equal(await countRoleQuestionsWithPrompt(target), 1, 'the bank holds the prompt exactly once');
});

test('a rename racing a create of the same prompt: exactly one wins (role bank)', async () => {
  const q = await call('POST', '/admin/questions', { token: adminToken, body: roleQuestion('Rename me onto the created prompt.') });
  assert.equal(q.status, 201);

  const target = 'A create and a rename race onto this prompt.';
  const [renamed, created] = await Promise.all([
    call('PATCH', `/admin/questions/${q.body.id}`, { token: adminToken, body: { prompt: target } }),
    call('POST', '/admin/questions', { token: adminToken, body: roleQuestion(target) }),
  ]);
  const winners = [renamed.status === 200, created.status === 201].filter(Boolean).length;
  const conflicts = [renamed.status, created.status].filter((s) => s === 409).length;
  assert.equal(winners, 1, `exactly one write lands: PATCH ${renamed.status} / POST ${created.status}`);
  assert.equal(conflicts, 1, 'the loser is a 409, not a silent overwrite');
  assert.equal(await countRoleQuestionsWithPrompt(target), 1, 'the bank holds the prompt exactly once');
});

const bankQuestion = (prompt) => ({
  module: 'T01', family: 'Advanced Technical Judgment', type: 'open', prompt,
  rubric: 'Some expected evidence.',
});

test('two concurrent renames onto one prompt: exactly one wins (module bank)', async () => {
  const a = await call('POST', '/admin/question-bank/questions', { token: adminToken, body: bankQuestion('Bank race prompt one?') });
  const b = await call('POST', '/admin/question-bank/questions', { token: adminToken, body: bankQuestion('Bank race prompt two?') });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));

  const target = 'Both bank renames race onto this prompt?';
  const [r1, r2] = await Promise.all([
    call('PATCH', `/admin/question-bank/questions/${a.body.question.id}`, { token: adminToken, body: { prompt: target } }),
    call('PATCH', `/admin/question-bank/questions/${b.body.question.id}`, { token: adminToken, body: { prompt: target } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `one rename lands, the other is refused: got ${statuses}`);
  const rows = (await store.list('bank_questions')).filter((q) => q.prompt === target);
  assert.equal(rows.length, 1, 'the bank holds the prompt exactly once');
});

test('a rename racing a create of the same prompt: exactly one wins (module bank)', async () => {
  const a = await call('POST', '/admin/question-bank/questions', { token: adminToken, body: bankQuestion('Rename me onto the created bank prompt?') });
  assert.equal(a.status, 201, JSON.stringify(a.body));

  const target = 'A bank create and a rename race onto this prompt?';
  const [renamed, created] = await Promise.all([
    call('PATCH', `/admin/question-bank/questions/${a.body.question.id}`, { token: adminToken, body: { prompt: target } }),
    call('POST', '/admin/question-bank/questions', { token: adminToken, body: bankQuestion(target) }),
  ]);
  const winners = [renamed.status === 200, created.status === 201].filter(Boolean).length;
  const conflicts = [renamed.status, created.status].filter((s) => s === 409).length;
  assert.equal(winners, 1, `exactly one write lands: PATCH ${renamed.status} / POST ${created.status}`);
  assert.equal(conflicts, 1, 'the loser is a 409, not a silent overwrite');
  const rows = (await store.list('bank_questions')).filter((q) => q.prompt === target);
  assert.equal(rows.length, 1, 'the bank holds the prompt exactly once');
});
