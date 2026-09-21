/**
 * Regression suite for the project-wide audit: every test here pins a defect
 * that was reproduced against the real app before it was fixed, so the fix
 * cannot quietly regress. Each world is a fresh json store + app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';
import { corsAllowOrigin, corsHeaders } from '../src/api/cors.mjs';

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-audit-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);
  const call = (method, p, { token, body, query } = {}) =>
    app({ method, path: p, query: query || {}, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  const login = async (username, password) =>
    (await call('POST', '/auth/login', { body: { username, password } })).body.token;
  const admin = await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', password_hash: hashPassword('Admin-pass-123'), active: true,
  });
  const tok = await login('admin', 'Admin-pass-123');
  const role = (await call('POST', '/admin/roles', { token: tok, body: { key: 'audit-track', name: 'Audit Track', technology: 'X' } })).body;
  const comp = async (name, weight = 50) => (await call('POST', '/admin/competencies', {
    token: tok, body: { role_id: role.id, name, weight, target_level: 4 },
  })).body;
  const c1 = await comp('Comp One');
  const c2 = await comp('Comp Two');
  const question = (body) => call('POST', '/admin/questions', { token: tok, body: { role_id: role.id, ...body } });
  const mcq = (competency_id, prompt) => question({
    competency_id, type: 'mcq_single', prompt,
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['a'], points: 4,
  });
  const open = (competency_id, prompt) => question({ competency_id, type: 'text', prompt, rubric: 'r', points: 5 });
  const candidateUser = async (username) => {
    const cand = (await call('POST', '/admin/candidates', { token: tok, body: { name: `Cand ${username}`, target_role_id: role.id } })).body;
    const created = await call('POST', '/admin/users', {
      token: tok, body: { username, name: username, role: 'candidate', password: 'Cand-pass-123', candidate_id: cand.id, auto_allocate: false },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { cand, token: await login(username, 'Cand-pass-123') };
  };
  return { store, app, call, login, admin, tok, role, c1, c2, question, mcq, open, candidateUser };
}

/* ----------------------------------------------------------- questions */

test('a blank points field stores the 4-point default, not a 0-point question', async () => {
  const w = await makeWorld();
  const created = await w.question({
    competency_id: w.c1.id, type: 'mcq_single', prompt: 'Blank points?',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['a'], points: '',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.points, 4, 'validation reads "" as the default; persistence must store the same');

  const edited = await w.call('PATCH', `/admin/questions/${created.body.id}`, { token: w.tok, body: { points: '' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.points, 4);
  assert.equal((await w.call('PATCH', `/admin/questions/${created.body.id}`, { token: w.tok, body: { points: 0 } })).status, 400,
    'an explicit zero is still refused');
});

test('switching a choice question to an open one drops its stale options and answer key', async () => {
  const w = await makeWorld();
  const q = (await w.mcq(w.c1.id, 'Was a choice question')).body;
  const switched = await w.call('PATCH', `/admin/questions/${q.id}`, { token: w.tok, body: { type: 'text', rubric: 'Expect X' } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.deepEqual(switched.body.options, []);
  assert.deepEqual(switched.body.correct_option_ids, []);
  assert.equal(switched.body.audio_required, true);
});

test('questions under a deactivated competency leave the bank: never served, never invisible in the plan', async () => {
  const w = await makeWorld();
  await w.mcq(w.c1.id, 'Kept one');
  await w.open(w.c1.id, 'Kept two');
  const orphan = (await w.open(w.c2.id, 'Orphaned by deactivation')).body;
  await w.call('PATCH', `/admin/competencies/${w.c2.id}`, { token: w.tok, body: { active: false } });

  const plan = (await w.call('GET', `/admin/roles/${w.role.id}/question-plan`, { token: w.tok })).body;
  assert.equal(plan.total, 2, 'the plan total matches what allocation can actually place');
  assert.equal(plan.per_competency.reduce((n, r) => n + r.count, 0), plan.total, 'no question is counted but unlisted');

  const cand = (await w.call('POST', '/admin/candidates', { token: w.tok, body: { name: 'Orphan Cand', target_role_id: w.role.id } })).body;
  const alloc = await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: cand.id, role_id: w.role.id } });
  assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
  const snap = alloc.body.snapshot_json;
  const compIds = new Set(snap.competencies.map((c) => c.id));
  assert.equal(snap.questions.length, 2);
  assert.ok(snap.questions.every((q) => compIds.has(q.competency_id)), 'every served question belongs to a snapshot competency');
  assert.ok(!snap.questions.some((q) => q.id === orphan.id));

  // Reactivating the competency brings its questions back.
  await w.call('PATCH', `/admin/competencies/${w.c2.id}`, { token: w.tok, body: { active: true } });
  const again = (await w.call('GET', `/admin/roles/${w.role.id}/question-plan`, { token: w.tok })).body;
  assert.equal(again.total, 3);
});

/* ----------------------------------------------------------- exam answers */

test('a bare-string open answer is normalised and still trips the spoken-answer contract', async () => {
  const w = await makeWorld();
  await w.open(w.c1.id, 'Open one');
  await w.mcq(w.c1.id, 'Choice one');
  const { cand, token } = await w.candidateUser('str.cand');
  const alloc = (await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: cand.id, role_id: w.role.id } })).body;
  const paper = sortedQuestions(alloc.snapshot_json);
  assert.equal((await w.call('GET', `/candidate/assessments/${alloc.id}`, { token })).status, 200);
  for (const q of paper) {
    const answer = q.type === 'text' ? 'typed as a plain string by a scripted client' : 'a';
    const r = await w.call('POST', `/candidate/assessments/${alloc.id}/next`, { token, body: { answer, question_id: q.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const openQ = paper.find((q) => q.type === 'text');
  const row = (await w.store.list('responses', { assessment_id: alloc.id })).find((r) => r.question_id === openQ.id);
  assert.equal(typeof row.answer, 'object', 'stored in the open-answer shape');
  assert.equal(row.answer.text, 'typed as a plain string by a scripted client');
  assert.equal(row.answer.source, 'typed');
  assert.equal(row.answer.audio_missing, true, 'no recording, no transcript: flagged like the object form');
  const a = await w.store.get('assessments', alloc.id);
  assert.equal(a.quiz_state.integrity.spoken_answer_missing, 1, 'the proctoring counter sees it');
  assert.ok((await w.store.list('audit_log')).some((e) => e.action === 'exam_spoken_answer_missing'));
});

test('opening the exam persists a healed legacy quiz state instead of restarting its clock on every load', async () => {
  const w = await makeWorld();
  await w.mcq(w.c1.id, 'Q1');
  await w.mcq(w.c1.id, 'Q2');
  const { cand, token } = await w.candidateUser('legacy.cand');
  const alloc = (await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: cand.id, role_id: w.role.id } })).body;
  // A state written by an older build: cursor but no question clock.
  await w.store.update('assessments', alloc.id, { status: 'in_progress', quiz_state: { index: 1, integrity: {}, events: [] } });

  const first = await w.call('GET', `/candidate/assessments/${alloc.id}`, { token });
  assert.equal(first.status, 200);
  const stored = await w.store.get('assessments', alloc.id);
  assert.equal(stored.quiz_state.index, 1, 'the cursor is untouched');
  assert.ok(stored.quiz_state.question_started_at, 'the backfilled clock is written');

  const startedAt = stored.quiz_state.question_started_at;
  await new Promise((r) => setTimeout(r, 15));
  await w.call('GET', `/candidate/assessments/${alloc.id}`, { token });
  assert.equal((await w.store.get('assessments', alloc.id)).quiz_state.question_started_at, startedAt,
    'a reload keeps the same clock (it used to mint a fresh budget every time)');
});

/* ----------------------------------------------------------- users & access */

test('passwords must be strings: structured values are refused instead of hashed as "[object Object]"', async () => {
  const w = await makeWorld();
  for (const password of [{ a: 1 }, ['x', 'y', 'z', 'w', 'a', 'b', 'c', 'd'], 12345678, true]) {
    const r = await w.call('POST', '/admin/users', { token: w.tok, body: { username: 'weird.pass', name: 'W', role: 'assessor', password } });
    assert.equal(r.status, 400, `password ${JSON.stringify(password)} must be refused`);
    assert.match(r.body.error, /string/i);
  }
  const okUser = await w.call('POST', '/admin/users', { token: w.tok, body: { username: 'fine.pass', name: 'F', role: 'assessor', password: 'Fine-pass-123' } });
  assert.equal(okUser.status, 201);
  const patched = await w.call('PATCH', `/admin/users/${okUser.body.id}`, { token: w.tok, body: { password: { nested: true } } });
  assert.equal(patched.status, 400);
  assert.equal((await w.call('PATCH', `/admin/users/${okUser.body.id}`, { token: w.tok, body: { password: 'short' } })).status, 400);
  assert.equal((await w.call('PATCH', `/admin/users/${okUser.body.id}`, { token: w.tok, body: { password: 'Long-enough-1' } })).status, 200);
  assert.ok(await w.login('fine.pass', 'Long-enough-1'), 'a proper password change still works');
});

test('an admin cannot deactivate their own login (self-lockout)', async () => {
  const w = await makeWorld();
  const second = (await w.call('POST', '/admin/users', { token: w.tok, body: { username: 'admin.two', name: 'A2', role: 'admin', password: 'Admin-pass-123' } })).body;
  const tok2 = await w.login('admin.two', 'Admin-pass-123');
  const self = await w.call('PATCH', `/admin/users/${second.id}`, { token: tok2, body: { active: false } });
  assert.equal(self.status, 400);
  assert.match(self.body.error, /own account/i);
  assert.equal((await w.call('GET', '/auth/me', { token: tok2 })).status, 200, 'still signed in');
  // Another admin may still deactivate them, and other self-edits still work.
  assert.equal((await w.call('PATCH', `/admin/users/${second.id}`, { token: tok2, body: { name: 'Renamed' } })).status, 200);
  assert.equal((await w.call('PATCH', `/admin/users/${second.id}`, { token: w.tok, body: { active: false } })).status, 200);
  assert.equal((await w.call('GET', '/auth/me', { token: tok2 })).status, 401);
});

test('roles and competencies cannot be edited into a blank name', async () => {
  const w = await makeWorld();
  const role = await w.call('PATCH', `/admin/roles/${w.role.id}`, { token: w.tok, body: { name: '   ' } });
  assert.equal(role.status, 400);
  assert.equal((await w.store.get('roles', w.role.id)).name, 'Audit Track');
  const comp = await w.call('PATCH', `/admin/competencies/${w.c1.id}`, { token: w.tok, body: { name: '' } });
  assert.equal(comp.status, 400);
  assert.equal((await w.store.get('competencies', w.c1.id)).name, 'Comp One');
  // Renaming still works, and a body without a name is not a rename.
  assert.equal((await w.call('PATCH', `/admin/competencies/${w.c1.id}`, { token: w.tok, body: { weight: 60 } })).status, 200);
  assert.equal((await w.call('PATCH', `/admin/roles/${w.role.id}`, { token: w.tok, body: { name: 'Renamed Track' } })).body.name, 'Renamed Track');
});

test('deleting a role clears the candidates that targeted it', async () => {
  const w = await makeWorld();
  const cand = (await w.call('POST', '/admin/candidates', { token: w.tok, body: { name: 'Pointed', target_role_id: w.role.id } })).body;
  assert.equal(cand.target_role_id, w.role.id);
  assert.equal((await w.call('DELETE', `/admin/roles/${w.role.id}`, { token: w.tok })).status, 200);
  assert.equal((await w.store.get('candidates', cand.id)).target_role_id, null);
});

test('a framework saved with numeric strings is stored as numbers', async () => {
  const w = await makeWorld();
  const saved = await w.call('PUT', '/admin/frameworks', {
    token: w.tok,
    body: {
      role_id: w.role.id,
      config: {
        readiness_bands: [{ key: 'a', label: 'A', min: '80' }, { key: 'b', label: 'B', min: '0' }],
        level_thresholds: ['0', '20', '40', '60', '80'],
        gap_severity: { moderate: '1', critical: '2' },
      },
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.config.readiness_bands.map((b) => b.min), [80, 0]);
  assert.deepEqual(saved.body.config.level_thresholds, [0, 20, 40, 60, 80]);
  assert.deepEqual(saved.body.config.gap_severity, { moderate: 1, critical: 2 });
});

/* ----------------------------------------------------------- question bank authoring */

test('editing a deactivated authored bank question does not put it back into circulation', async () => {
  const w = await makeWorld();
  const modules = (await w.call('GET', '/admin/question-bank/modules', { token: w.tok })).body;
  const family = modules.modules[0].families[0];
  const created = await w.call('POST', '/admin/question-bank/questions', {
    token: w.tok,
    body: {
      module: modules.modules[0].key, family_id: family.id, type: 'open',
      prompt: 'Audit-authored open question that will be deactivated and then edited for a typo.',
      rubric: 'Expect a reasoned answer.', probes: ['Why?'],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.question.id;
  const off = await w.call('PATCH', `/admin/question-bank/questions/${id}`, { token: w.tok, body: { active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.question.active, false);

  const typo = await w.call('PATCH', `/admin/question-bank/questions/${id}`, {
    token: w.tok, body: { prompt: 'Audit-authored open question that was deactivated and then edited for a typo.' },
  });
  assert.equal(typo.status, 200, JSON.stringify(typo.body));
  assert.equal(typo.body.question.active, false, 'a content edit keeps the row inactive');
  assert.equal((await w.store.get('bank_questions', id)).active, false);

  const on = await w.call('PATCH', `/admin/question-bank/questions/${id}`, { token: w.tok, body: { active: true } });
  assert.equal(on.body.question.active, true, 'an explicit restore still works');
});

/* ----------------------------------------------------------- assessor scoring */

test('an assessor can clear a score they entered by mistake, and finalize then reports it missing', async () => {
  const w = await makeWorld();
  await w.open(w.c1.id, 'Open scored');
  await w.mcq(w.c1.id, 'Choice');
  const assessor = (await w.call('POST', '/admin/users', { token: w.tok, body: { username: 'scorer', name: 'Scorer', role: 'assessor', password: 'Scorer-pass-1' } })).body;
  const atok = await w.login('scorer', 'Scorer-pass-1');
  const { cand, token } = await w.candidateUser('scored.cand');
  const alloc = (await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: cand.id, role_id: w.role.id, assessor_id: assessor.id } })).body;
  const paper = sortedQuestions(alloc.snapshot_json);
  await w.call('GET', `/candidate/assessments/${alloc.id}`, { token });
  for (const q of paper) {
    await w.call('POST', `/candidate/assessments/${alloc.id}/next`, {
      token, body: { question_id: q.id, answer: q.type === 'text' ? { text: 'x', transcript: 'spoken', source: 'audio' } : 'a' },
    });
  }
  assert.equal((await w.call('POST', `/candidate/assessments/${alloc.id}/submit`, { token, body: { answers: {} } })).status, 200);
  const openQ = paper.find((q) => q.type === 'text');
  const put = (score) => w.call('PUT', `/assessor/assessments/${alloc.id}/scores`, { token: atok, body: { scores: [{ question_id: openQ.id, score, comment: 'c' }] } });
  assert.equal((await put(3)).status, 200);
  const row = () => w.store.list('responses', { assessment_id: alloc.id }).then((rows) => rows.find((r) => r.question_id === openQ.id));
  assert.equal((await row()).assessor_score, 3);
  assert.equal((await put(null)).status, 200);
  assert.equal((await row()).assessor_score, null, 'an explicit blank clears the score');
  assert.equal((await row()).assessor_comment, 'c', 'the comment on the same entry is kept');
  const fin = await w.call('POST', `/assessor/assessments/${alloc.id}/finalize`, { token: atok });
  assert.equal(fin.status, 422, 'the cleared question blocks finalization again');
  assert.equal((await put('')).status, 200, 'an empty string is the same blank');
  assert.equal((await put(4)).status, 200);
  assert.equal((await w.call('POST', `/assessor/assessments/${alloc.id}/finalize`, { token: atok })).status, 200);
});

/* ----------------------------------------------------------- transports */

test('CORS grants the request\'s own origin and the CORS_ORIGINS allowlist, never an arbitrary Origin in production', () => {
  assert.equal(corsAllowOrigin({ origin: 'https://ecod.example.com', host: 'ecod.example.com' }), 'https://ecod.example.com');
  assert.equal(corsAllowOrigin({ origin: 'https://ecod.example.com', host: 'proxy.internal, ecod.example.com' }), 'https://ecod.example.com',
    'a forwarded host list still matches');
  assert.equal(corsAllowOrigin({ origin: 'https://evil.example', host: 'ecod.example.com' }), null);
  assert.equal(corsAllowOrigin({ origin: 'https://evil.example', host: 'ecod.example.com', allowlist: 'https://partner.example,https://evil.example' }), 'https://evil.example');
  assert.equal(corsAllowOrigin({ origin: 'https://anyone.example', host: 'ecod.example.com', allowlist: '*' }), 'https://anyone.example', 'explicit opt-in to reflect');
  assert.equal(corsAllowOrigin({ origin: 'https://evil.example', host: 'ecod.example.com', permissive: true }), '*', 'the dev server stays permissive');
  assert.equal(corsAllowOrigin({ origin: 'not a url', host: 'ecod.example.com' }), null);
  assert.equal(corsAllowOrigin({ host: 'ecod.example.com' }), null, 'no Origin, no CORS headers');
  assert.deepEqual(corsHeaders(null), {});
  assert.equal(corsHeaders('https://ecod.example.com').vary, 'Origin');
  assert.equal(corsHeaders('*').vary, undefined);
});
