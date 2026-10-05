import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeWorld } from './helpers/world.mjs';
import { createApp } from '../src/api/app.mjs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { registerRoutes } from '../src/api/router.mjs';
import { USER_PASSWORD } from './helpers/world.mjs';

const clip = (text) => ({ text: '', transcript: 'independent transcript', source: 'audio',
  audio_b64: Buffer.from(text).toString('base64'), audio_mime: 'audio/webm' });
const ok = (r) => { assert.ok(r.status < 300, `${r.status}: ${JSON.stringify(r.body)}`); return r.body; };

test('every private route rejects signed-out and wrong-role callers before performing any mutation', async (t) => {
  const w = await makeWorld({ t });
  const candidate = await w.candidateUser('matrix.candidate');
  const assessor = await w.assessorUser('matrix.assessor');
  const tokens = { admin: w.tok, candidate: candidate.token, assessor: assessor.token };
  for (const role of ['validator', 'trainer']) {
    ok(await w.call('POST', '/admin/users', { token: w.tok, body: {
      username: `matrix.${role}`, name: role, role, password: USER_PASSWORD,
    } }));
    tokens[role] = await w.login(`matrix.${role}`);
  }
  const before = await import('node:fs/promises').then((fs) => fs.readFile(path.join(w.tmp, 'db.json'), 'utf8'));
  let checks = 0;
  for (const route of registerRoutes().filter((r) => r.roles !== 'public')) {
    const url = route.pattern.replace(/:[^/]+/g, 'nonexistent');
    assert.equal((await w.call(route.method, url)).status, 401, `${route.method} ${route.pattern} requires a session`);
    checks++;
    for (const [prefix, role] of [['/admin/', 'admin'], ['/candidate/', 'candidate'], ['/assessor/', 'assessor']]) {
      if (route.pattern.startsWith(prefix)) assert.deepEqual(route.roles, [role], 'role namespace must not accidentally become unrestricted');
    }
    if (!Array.isArray(route.roles)) continue;
    for (const [role, token] of Object.entries(tokens)) {
      if (route.roles.includes(role)) continue;
      const result = await w.call(route.method, url, { token, body: { role: 'admin', candidate_id: candidate.cand.id } });
      assert.equal(result.status, 403, `${role} denied ${route.method} ${route.pattern}, regardless of forged body fields`);
      checks++;
    }
  }
  const after = await import('node:fs/promises').then((fs) => fs.readFile(path.join(w.tmp, 'db.json'), 'utf8'));
  assert.equal(after, before, 'forbidden actions leave stored state unchanged');
  ok(await w.call('PATCH', `/admin/users/${candidate.user.id}`, { token: w.tok, body: { active: false } }));
  assert.equal((await w.call('GET', '/candidate/assessments', { token: candidate.token })).status, 401);
  ok(await w.call('PATCH', `/admin/users/${candidate.user.id}`, { token: w.tok, body: { active: true } }));
  assert.equal((await w.call('GET', '/candidate/assessments', { token: candidate.token })).status, 401,
    'reactivation must not resurrect a revoked session');
  const freshToken = await w.login('matrix.candidate');
  ok(await w.call('GET', '/candidate/assessments', { token: freshToken }));
  t.diagnostic(`${checks} authorization probes across the private route inventory`);
});

async function setup(t) {
  const w = await makeWorld({ mcq: 0, open: 3, t });
  const candidate = await w.candidateUser('chaos.candidate');
  const assessor = await w.assessorUser('chaos.assessor');
  await w.assign(candidate.assessmentId, assessor.user.id);
  const base = `/candidate/assessments/${candidate.assessmentId}`;
  const screen = ok(await w.call('GET', base, { token: candidate.token }));
  if (screen.exam.phase === 'review') ok(await w.call('POST', `${base}/phase`, { token: candidate.token, body: { phase: 'answer' } }));
  return { w, candidate, assessor, base, q: screen.current_question };
}

test('malformed audio uploads are rejected without discarding an existing valid recording', async (t) => {
  const { w, candidate, base, q } = await setup(t);
  const draft = (answer) => w.call('PUT', `${base}/answers`, { token: candidate.token, body: { answers: { [q.id]: answer } } });
  ok(await draft(clip('original valid bytes')));
  const before = (await w.store.list('responses', { assessment_id: candidate.assessmentId, question_id: q.id }))[0].answer;
  for (const invalid of ['====', 'ab=c', 'not base64!', 'A', { bytes: 'AAAA' }, 1234]) {
    const result = await draft({ ...clip('unused'), audio_b64: invalid });
    assert.equal(result.status, 422, `reject ${JSON.stringify(invalid)} instead of acknowledging unusable audio`);
    const after = (await w.store.list('responses', { assessment_id: candidate.assessmentId, question_id: q.id }))[0].answer;
    assert.deepEqual(after, before, 'failed upload must not replace the saved recording');
    assert.equal((await w.call('POST', `${base}/next`, { token: candidate.token,
      body: { question_id: q.id, answer: { ...clip('unused'), audio_b64: invalid } } })).status, 422,
    'locking must reject corrupt audio too');
    assert.equal((await w.call('POST', `${base}/submit`, { token: candidate.token,
      body: { answers: { [q.id]: { ...clip('unused'), audio_b64: invalid } } } })).status, 422,
    'a final answer sheet cannot bypass audio validation');
  }
  assert.equal(ok(await w.call('GET', base, { token: candidate.token })).exam.index, 0);
});

for (const boundary of ['recording insert', 'response commit', 'cursor commit']) {
  test(`lost acknowledgement after ${boundary} recovers without duplicate answers or skipped questions`, async (t) => {
    const { w, candidate, assessor, base, q } = await setup(t);
    const originalInsert = w.store.insert.bind(w.store);
    const originalChange = w.store.changeRow.bind(w.store);
    let injected = false;
    w.store.insert = async (table, value) => {
      const out = await originalInsert(table, value);
      if (!injected && boundary === 'recording insert' && table === 'recordings') {
        injected = true; throw new Error('Injected lost acknowledgement after recording write');
      }
      return out;
    };
    w.store.changeRow = async (table, key, decide) => {
      const out = await originalChange(table, key, decide);
      const matches = boundary === 'response commit' && table === 'responses'
        || boundary === 'cursor commit' && table === 'assessments' && out.row?.quiz_state?.index === 1;
      if (!injected && out.changed && matches) {
        injected = true; throw new Error(`Injected lost acknowledgement after ${boundary}`);
      }
      return out;
    };
    const answer = clip(`committed at ${boundary}`);
    const lock = () => w.call('POST', `${base}/next`, { token: candidate.token, body: { question_id: q.id, answer } });
    assert.equal((await lock()).status, 500, 'client sees failure even though part of its write committed');
    assert.equal(injected, true);
    ok(await lock());
    ok(await lock());
    const screen = ok(await w.call('GET', base, { token: candidate.token }));
    assert.equal(screen.exam.index, 1, 'retry must advance exactly once');
    const rows = await w.store.list('responses', { assessment_id: candidate.assessmentId, question_id: q.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].locked, true);
    const saved = await w.store.get('recordings', rows[0].answer.audio_ref);
    assert.equal(saved.audio.b64, answer.audio_b64);
    await w.store.update('assessments', candidate.assessmentId, { status: 'submitted' });
    const playback = ok(await w.call('GET', `/assessor/assessments/${candidate.assessmentId}/recordings/${q.id}`, { token: assessor.token }));
    assert.equal(playback.audio_b64, answer.audio_b64);
  });
}

test('cold restart preserves recording references and missing physical files fail visibly without inventing audio', async (t) => {
  const { w, candidate, assessor, base, q } = await setup(t);
  const answer = clip('restart durable bytes');
  ok(await w.call('POST', `${base}/next`, { token: candidate.token, body: { question_id: q.id, answer } }));
  await w.store.update('assessments', candidate.assessmentId, { status: 'submitted' });
  const store = createJsonStore(path.join(w.tmp, 'db.json'));
  const app = await createApp(store);
  const play = () => app({ method: 'GET', path: `/assessor/assessments/${candidate.assessmentId}/recordings/${q.id}`,
    headers: { authorization: `Bearer ${assessor.token}` } });
  assert.equal(ok(await play()).audio_b64, answer.audio_b64);
  const response = (await store.list('responses', { assessment_id: candidate.assessmentId, question_id: q.id }))[0];
  await store.remove('recordings', response.answer.audio_ref);
  assert.equal((await play()).status, 404, 'a missing object cannot be served as a successful empty recording');
  assert.equal((await store.get('responses', response.id)).answer.transcript, answer.transcript);
});

for (const seed of [7, 19, 41, 73]) {
  test(`seed ${seed}: reordered drafts and duplicate locks preserve the committed answer model`, async (t) => {
    const w = await makeWorld({ mcq: 3, open: 3, t });
    const candidate = await w.candidateUser(`model.${seed}`);
    const base = `/candidate/assessments/${candidate.assessmentId}`;
    let randomState = seed;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
    const committed = new Map();
    for (let index = 0; index < 6; index++) {
      const screen = ok(await w.call('GET', base, { token: candidate.token }));
      assert.equal(screen.exam.index, index);
      const q = screen.current_question;
      if (screen.exam.phase === 'review') ok(await w.call('POST', `${base}/phase`, { token: candidate.token, body: { phase: 'answer' } }));
      const answer = q.type === 'text' ? clip(`seed ${seed}, question ${q.id}`) : q.options[0].id;
      for (let i = 0; i < 1 + Math.floor(random() * 4); i++) {
        ok(await w.call('PUT', `${base}/answers`, { token: candidate.token, body: { answers: { [q.id]: answer, unknown: 'ignored' } } }));
      }
      const lock = () => w.call('POST', `${base}/next`, { token: candidate.token, body: { question_id: q.id, answer } });
      for (const result of await Promise.all([lock(), lock(), lock()])) ok(result);
      const row = (await w.store.list('responses', { assessment_id: candidate.assessmentId, question_id: q.id }))[0];
      assert.equal(row.locked, true);
      committed.set(q.id, JSON.stringify(row.answer));
      // Delayed browser drafts must not alter any answer already committed.
      for (const [oldId, expected] of committed) {
        const late = typeof JSON.parse(expected) === 'string' ? 'b' : clip('late replacement');
        ok(await w.call('PUT', `${base}/answers`, { token: candidate.token, body: { answers: { [oldId]: late } } }));
        const latest = (await w.store.list('responses', { assessment_id: candidate.assessmentId, question_id: oldId }))[0];
        assert.equal(JSON.stringify(latest.answer), expected);
      }
    }
    ok(await w.call('POST', `${base}/submit`, { token: candidate.token, body: { answers: {} } }));
    const rows = await w.store.list('responses', { assessment_id: candidate.assessmentId });
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map((r) => r.question_id)).size, 6);
  });
}
