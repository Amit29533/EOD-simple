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

test('candidate create/patch reject invalid years of experience instead of silently storing null', async () => {
  for (const years of ['abc', -1, 51, Infinity, NaN]) {
    const create = await call('POST', '/admin/candidates', {
      token: adminToken,
      body: { name: 'Bad Years', years_experience: years },
    });
    assert.equal(create.status, 400, `create accepted invalid years=${years}`);
    assert.match(create.body.error, /years of experience must be a number between 0 and 50/i);

    const patch = await call('PATCH', `/admin/candidates/${candA.id}`, {
      token: adminToken,
      body: { years_experience: years },
    });
    assert.equal(patch.status, 400, `patch accepted invalid years=${years}`);
    assert.match(patch.body.error, /years of experience must be a number between 0 and 50/i);
  }

  // Boundary values remain accepted through both paths.
  for (const years of [0, 3.5, 50]) {
    const create = await call('POST', '/admin/candidates', {
      token: adminToken,
      body: { name: `Valid ${years}`, years_experience: years },
    });
    assert.equal(create.status, 201, `create rejected valid years=${years}`);
    assert.equal(create.body.years_experience, years);
  }
});

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

  // A valid stage must actually persist — the Edit form sends it on every save,
  // but PATCH used to validate it and then drop it from the write.
  res = await call('PATCH', `/admin/candidates/${candA.id}`, {
    token: adminToken, body: { stage: 'enrichment' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.stage, 'enrichment', 'PATCH must persist a valid pipeline stage');
  assert.equal((await store.get('candidates', candA.id)).stage, 'enrichment');

  // Clearing years of experience must store null, not 0 (Number(null) === 0).
  res = await call('PATCH', `/admin/candidates/${candA.id}`, {
    token: adminToken, body: { years_experience: null },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.years_experience, null, 'clearing years_experience stores null, not 0');

  res = await call('POST', '/admin/candidates', {
    token: adminToken, body: { name: 'No Years', years_experience: null },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.years_experience, null, 'create with blank years stores null, not 0');

  res = await call('PATCH', `/admin/candidates/${candA.id}`, {
    token: adminToken, body: { years_experience: '' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.years_experience, null, 'empty-string years_experience stores null, not 0');

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

test('legacy question points reject non-numeric input instead of silently defaulting', async () => {
  const bad = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({ points: 'abc' }),
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /points must be between 1 and 20/i);

  const badPatch = await call('PATCH', `/admin/questions/${(await call('POST', '/admin/questions', { token: adminToken, body: validQuestion() })).body.id}`, {
    token: adminToken,
    body: { points: 'not-a-number' },
  });
  assert.equal(badPatch.status, 400, JSON.stringify(badPatch.body));
  assert.match(badPatch.body.error, /points must be between 1 and 20/i);
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

test('competency PATCH caps every text field exactly like POST', async () => {
  // POST capped name at 160, category and key at 60; PATCH capped all five of
  // them at 1500, so an edit could store a value the create path refuses.
  const long = (ch) => ch.repeat(2000);   // longer than every cap, so each is truncated
  const created = await call('POST', '/admin/competencies', {
    token: adminToken,
    body: {
      role_id: roleA.id, name: long('n'), key: long('k'), category: long('c'),
      description: long('d'), enrichment_hint: long('e'), weight: 50, target_level: 4,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const patched = await call('PATCH', `/admin/competencies/${created.body.id}`, {
    token: adminToken,
    body: {
      name: long('N'), key: long('K'), category: long('C'),
      description: long('D'), enrichment_hint: long('E'),
    },
  });
  assert.equal(patched.status, 200);
  for (const [field, max] of Object.entries({ name: 160, key: 60, category: 60, description: 1500, enrichment_hint: 1500 })) {
    assert.equal(patched.body[field].length, max, `${field} capped at ${max} by PATCH`);
    assert.equal(patched.body[field].length, created.body[field].length, `${field} PATCH cap == POST cap`);
  }
});

test('a malformed options array is a validation error, never a 500', async () => {
  // Options reach the API from a form, a CSV grid and the workbook extractor, so
  // an entry can be null, a bare string, a number, or an object with a numeric
  // label. Validation used to read `o.label` off whatever arrived, and a single
  // null crashed both question endpoints.
  const hostile = [
    [null, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    ['a', 'b'],
    [1, 2],
    [{ id: 'a', label: 5 }, { id: 'b', label: 6 }],
    [{ id: 'a', label: { toString: () => 'x' } }, { id: 'b', label: 'B' }],
    [{ label: 'A' }, { label: 'B' }],
    ['a', ['b'], { id: 'c', label: 'C', extra: { deep: true } }],
  ];
  for (const [i, options] of hostile.entries()) {
    for (const path of ['/admin/questions', '/admin/question-bank/questions']) {
      const body = {
        role_id: roleA.id, competency_id: compA.id, module: 'T01', type: 'mcq_single',
        prompt: `Hostile options payload ${i}?`, points: 4, difficulty: 'intermediate',
        order: 1, active: true, options, correct_option_ids: ['a'],
      };
      const res = await call('POST', path, { token: adminToken, body });
      assert.ok(res.status < 500, `${path} rejected payload ${i} with ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`);
    }
  }
  // Non-array `options` values must not crash either.
  for (const options of ['abc', { 0: { id: 'a', label: 'A' } }, 42, true]) {
    const res = await call('POST', '/admin/questions', {
      token: adminToken,
      body: validQuestion({ options, correct_option_ids: ['a'] }),
    });
    assert.equal(res.status, 400, `options ${JSON.stringify(options)} is refused, not crashed`);
  }
});

test('junk options are dropped, and an answer key pointing at dropped text is still refused', async () => {
  // The refusal must stay consistent: dropping a malformed entry is only safe if
  // the correct-answer check runs against what survived.
  // One entry survives the drop, so the count check fires first: proof that the
  // blank/null entries never made it into the option list the key is checked on.
  const res = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({
      options: [null, undefined, 'x', { id: 'a', label: 'Alpha' }, { id: 'b', label: '   ' }],
      correct_option_ids: ['b'],
    }),
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /at least two options/i);

  // Two survivors, and the key points at a dropped entry -> refused.
  const dangling = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({
      options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: '' }],
      correct_option_ids: ['c'],
    }),
  });
  assert.equal(dangling.status, 400, JSON.stringify(dangling.body));
  assert.match(dangling.body.error, /correct option/i, 'a dropped option cannot be the answer key');

  const okRes = await call('POST', '/admin/questions', {
    token: adminToken,
    body: validQuestion({
      options: [null, { id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
      correct_option_ids: ['a'],
    }),
  });
  assert.equal(okRes.status, 201, JSON.stringify(okRes.body));
  assert.deepEqual(okRes.body.options.map((o) => o.id), ['a', 'b'], 'only the well-formed options persist');
});

test('a structured prompt is refused, not stringified into "[object Object]"', async () => {
  // str() is forgiving by design, which let an object body be stored as the
  // literal text "[object Object]" -- and since the prompt is what the duplicate
  // check and the serving dedupe compare, every such row collapsed into one.
  for (const prompt of [{ a: 1 }, ['a', 'b'], { toString: () => 'x' }, new Map()]) {
    const res = await call('POST', '/admin/questions', {
      token: adminToken, body: validQuestion({ prompt }),
    });
    assert.equal(res.status, 400, `prompt ${JSON.stringify(prompt)} must be refused, got ${res.status}`);
    assert.match(res.body.error, /plain text/i);
  }
  const bank = await call('POST', '/admin/question-bank/questions', {
    token: adminToken,
    body: { role_id: roleA.id, competency_id: compA.id, module: 'T01', type: 'objective', prompt: { a: 1 }, points: 4 },
  });
  assert.equal(bank.status, 422, JSON.stringify(bank.body));
  assert.ok(bank.body.errors.some((e) => /plain text/i.test(e)), JSON.stringify(bank.body.errors));
  // A numeric prompt is still just "too short" rather than a type error, and a
  // real string prompt keeps working.
  const good = await call('POST', '/admin/questions', {
    token: adminToken, body: validQuestion({ prompt: 'Which governance layer owns row-level access?' }),
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.prompt, 'Which governance layer owns row-level access?');
});
