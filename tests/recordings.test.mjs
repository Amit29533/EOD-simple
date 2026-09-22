import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createBlobsStore } from '../src/storage/netlify-blobs.mjs';
import { ROW_TABLES, isRowTable, createRowTable } from '../src/storage/row-tables.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';
import { JSDOM, SKIP } from './helpers/jsdom.mjs';

/**
 * Recordings out of the hot path.
 *
 * A two-minute spoken answer is ~320,000 base64 characters and a whole-bank
 * paper holds 33 of them. Stored inline on the response rows, one finished
 * candidate added ~10 MB that then rode along everywhere: on every exam
 * request (the responses table is read per GET and lock, rewritten per lock),
 * on every unrelated mutation of the file store (whole-database rewrite — an
 * admin login went from 5 ms to 210 ms), on the single `responses` blob on
 * Netlify, and on the assessor's detail payload (10.17 MB measured, past a
 * serverless function's 6 MB response cap: the paper could not be opened).
 *
 * Recordings now live in their own `recordings` table, stored one row per
 * object under the assessment's shard, referenced from the answer by
 * `audio_ref`, and fetched by the assessor one question at a time.
 */

const B64 = 'ZmFrZS13ZWJtLWJ5dGVz';
const B64_2 = 'c2Vjb25kLXRha2U=';

/* ------------------------------------------------------------------------ */
/* Storage: row tables on both adapters                                      */
/* ------------------------------------------------------------------------ */

/** In-memory stand-in for @netlify/blobs with the four calls the adapter uses. */
function fakeBlobs() {
  const data = new Map();
  const ops = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const store = {
    async get(key, opts) { ops.push(['get', key, opts?.consistency]); return data.has(key) ? clone(data.get(key)) : null; },
    async setJSON(key, value) { ops.push(['set', key]); data.set(key, clone(value)); },
    async delete(key) { ops.push(['delete', key]); data.delete(key); },
    async list({ prefix = '' } = {}) {
      ops.push(['list', prefix]);
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: 'x' })), directories: [] };
    },
  };
  return { data, ops, module: { getStore: () => store } };
}

test('ROW_TABLES: recordings are sharded by assessment and keyed by question', () => {
  assert.deepEqual(ROW_TABLES, { recordings: { shard: 'assessment_id', key: 'question_id' } });
  assert.equal(isRowTable('recordings'), true);
  assert.equal(isRowTable('responses'), false);
  assert.equal(isRowTable('constructor'), false, 'prototype names are not tables');
});

for (const kind of ['json-file', 'netlify-blobs']) {
  test(`${kind}: recording rows are stored one per object, outside the table blob/file`, async () => {
    let store; let mainBytes; let fake; let tmp;
    if (kind === 'json-file') {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-recordings-'));
      store = createJsonStore(path.join(tmp, 'db.json'));
      await store.insert('roles', { key: 'r', name: 'R', active: true });
      mainBytes = () => fs.readFileSync(path.join(tmp, 'db.json'), 'utf8');
    } else {
      fake = fakeBlobs();
      store = await createBlobsStore({ blobsModule: fake.module });
      await store.insert('roles', { key: 'r', name: 'R', active: true });
      mainBytes = () => JSON.stringify([...fake.data.entries()].filter(([k]) => !k.startsWith('rows/recordings/')));
    }
    const before = mainBytes();

    const rec = await store.insert('recordings', { assessment_id: 'asm1', question_id: 'q1', audio: { b64: B64, mime: 'audio/webm' } });
    assert.equal(rec.id, 'asm1/q1', 'a path-safe shard + key gives a deterministic id');
    assert.ok(rec.created_at);
    const second = await store.insert('recordings', { assessment_id: 'asm1', question_id: 'q2', audio: { b64: B64_2, mime: 'audio/ogg' } });
    assert.equal(second.id, 'asm1/q2');
    const other = await store.insert('recordings', { assessment_id: 'asm2', question_id: 'q1', audio: { b64: 'eA==', mime: 'audio/mp4' } });
    assert.equal(other.id, 'asm2/q1');

    assert.equal(mainBytes(), before, 'recordings never touch the main database file / table blobs');
    if (kind === 'json-file') {
      assert.ok(fs.existsSync(path.join(tmp, 'db.rows', 'rows', 'recordings', 'asm1', 'q1.json')), 'one file per row under <db>.rows/rows/');
      assert.ok(!fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
    } else {
      assert.ok(fake.data.has('rows/recordings/asm1/q1'), 'one blob per row under rows/<table>/<shard>/');
      assert.ok(!fake.ops.some(([op, key]) => op === 'set' && key === 'recordings'), 'no whole-table blob is ever written');
    }

    // reads
    assert.deepEqual((await store.get('recordings', 'asm1/q1')).audio, { b64: B64, mime: 'audio/webm' });
    assert.equal(await store.get('recordings', 'nope/q1'), null);
    assert.equal(await store.get('recordings', 'asm1'), null, 'an id without a shard cannot exist');
    assert.deepEqual((await store.list('recordings', { assessment_id: 'asm1' })).map((r) => r.id).sort(), ['asm1/q1', 'asm1/q2']);
    assert.deepEqual((await store.list('recordings', { assessment_id: 'asm1', question_id: 'q2' })).map((r) => r.audio.b64), [B64_2]);
    assert.deepEqual(await store.list('recordings', { assessment_id: 'asm1', question_id: 'q9' }), []);
    assert.equal((await store.list('recordings')).length, 3, 'an unfiltered list walks every shard');
    assert.equal((await store.list('recordings', { question_id: 'q1' })).length, 2, 'a non-shard filter still works (full scan)');
    if (kind === 'netlify-blobs') {
      const keyed = fake.ops.length;
      await store.list('recordings', { assessment_id: 'asm1', question_id: 'q1' });
      const since = fake.ops.slice(keyed);
      assert.deepEqual(since.map(([op]) => op), ['get'], 'shard + key resolves to ONE object read, no listing');
      assert.equal(since[0][2], 'strong', 'row reads are strongly consistent (the lock that wrote it is followed by a read)');
    }

    // filters that could name a path outside the table are inert
    for (const bad of ['../roles', 'asm1/../asm2', 'a b', '.', '..', '%2e%2e']) {
      assert.deepEqual(await store.list('recordings', { assessment_id: bad }), [], `shard ${JSON.stringify(bad)} matches nothing`);
      assert.equal(await store.get('recordings', `${bad}/q1`), null);
      assert.equal(await store.remove('recordings', `${bad}/q1`), false);
    }
    assert.equal((await store.list('recordings', { assessment_id: '' })).length, 3, 'an empty filter value means "no filter", like every other table');
    assert.equal(await store.get('recordings', '/q1'), null);
    assert.equal(await store.get('recordings', 'asm1/'), null);
    assert.equal(await store.get('recordings', 'asm1/q1/extra'), null);
    assert.deepEqual(await store.list('recordings', { assessment_id: 'asm1', question_id: '../q1' }), []);

    // update
    const upd = await store.update('recordings', 'asm1/q1', { audio: { b64: B64_2, mime: 'audio/webm' } });
    assert.equal(upd.audio.b64, B64_2);
    assert.ok(upd.updated_at);
    assert.equal((await store.get('recordings', 'asm1/q1')).audio.b64, B64_2);
    assert.equal(await store.update('recordings', 'asm9/q1', { audio: null }), null, 'updating a missing row is a no-op');
    assert.equal(mainBytes(), before);

    // duplicate / invalid ids
    await assert.rejects(store.insert('recordings', { assessment_id: 'asm1', question_id: 'q1', audio: {} }), (e) => e.code === 'DUPLICATE_ID');
    await assert.rejects(store.insert('recordings', { question_id: 'q1', audio: {} }), (e) => e.code === 'MISSING_SHARD');
    await assert.rejects(store.insert('recordings', { assessment_id: '../x', question_id: 'q1', audio: {} }), (e) => e.code === 'MISSING_SHARD');
    await assert.rejects(store.insert('recordings', { id: 'asm2/custom', assessment_id: 'asm1', question_id: 'q3' }), (e) => e.code === 'INVALID_ID', 'an id must live under its own shard');
    await assert.rejects(store.insert('recordings', { id: 'flat', assessment_id: 'asm1', question_id: 'q3' }), (e) => e.code === 'INVALID_ID');
    const odd = await store.insert('recordings', { assessment_id: 'asm1', question_id: 'weird key/../x', audio: {} });
    assert.match(odd.id, /^asm1\/[A-Za-z0-9_-]+$/, 'an unsafe natural key gets a random tail instead');
    assert.equal((await store.list('recordings', { assessment_id: 'asm1', question_id: 'weird key/../x' })).length, 1, 'and is still found by filter');

    // batches + removal
    const many = await store.insertMany('recordings', [
      { assessment_id: 'asm3', question_id: 'q1', audio: {} },
      { assessment_id: 'asm3', question_id: 'q2', audio: {} },
    ]);
    assert.deepEqual(many.map((r) => r.id), ['asm3/q1', 'asm3/q2']);
    const patched = await store.updateMany('recordings', many.map((r) => ({ id: r.id, patch: { audio: { b64: 'eQ==' } } })));
    assert.ok(patched.every((r) => r.audio.b64 === 'eQ=='));
    assert.equal(await store.removeMany('recordings', ['asm3/q1', 'asm3/q2', 'asm3/q3']), 2, 'unknown ids are skipped, not errors');
    assert.equal(await store.remove('recordings', 'asm1/q2'), true);
    assert.equal(await store.remove('recordings', 'asm1/q2'), false);
    assert.deepEqual((await store.list('recordings', { assessment_id: 'asm1' })).map((r) => r.id).sort(), ['asm1/q1', odd.id].sort());
    if (kind === 'json-file') {
      assert.ok(!fs.existsSync(path.join(tmp, 'db.rows', 'recordings', 'asm3')), 'an emptied shard directory is removed');
    }
    assert.equal(mainBytes(), before, 'still untouched after updates and deletes');
    // the main table keeps working alongside
    assert.equal((await store.list('roles')).length, 1);
  });
}

test('createRowTable serialises mutations through the adapter lock', async () => {
  const mem = new Map();
  let depth = 0; let maxDepth = 0; let chain = Promise.resolve();
  const io = {
    read: async (k) => (mem.has(k) ? { ...mem.get(k) } : null),
    write: async (k, row) => { mem.set(k, row); },
    remove: async (k) => mem.delete(k),
    keys: async (prefix) => [...mem.keys()].filter((k) => k.startsWith(prefix)),
    lock: (fn) => {
      const run = async () => {
        depth += 1; maxDepth = Math.max(maxDepth, depth);
        await new Promise((r) => setTimeout(r, 2));
        try { return await fn(); } finally { depth -= 1; }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
  };
  const table = createRowTable('recordings', io);
  const results = await Promise.allSettled([
    table.insert({ assessment_id: 'a', question_id: 'q', audio: { b64: '1' } }),
    table.insert({ assessment_id: 'a', question_id: 'q', audio: { b64: '2' } }),
    table.update('a/q', { audio: { b64: '3' } }),
  ]);
  assert.equal(maxDepth, 1, 'never two mutations inside the lock at once');
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[1].reason.code, 'DUPLICATE_ID');
  assert.equal(mem.get('rows/recordings/a/q').audio.b64, '3');
});

/* ------------------------------------------------------------------------ */
/* API: the exam stores references, the assessor fetches clips on demand     */
/* ------------------------------------------------------------------------ */

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-recordings-api-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);

  const role = await store.insert('roles', { key: 'rec', name: 'Recorded Track', technology: 'X', description: '', active: true });
  const comp = await store.insert('competencies', {
    role_id: role.id, key: 'core', name: 'Core', category: 'technical', weight: 100, target_level: 3, order: 1, active: true,
  });
  const base = { role_id: role.id, competency_id: comp.id, help_text: '', difficulty: 'intermediate', points: 4, rubric: '', active: true };
  const open1 = await store.insert('questions', {
    ...base, type: 'text', points: 6, order: 0, prompt: 'Talk us through it.', rubric: 'R1', options: [], correct_option_ids: [], audio_required: true,
  });
  const open2 = await store.insert('questions', {
    ...base, type: 'text', points: 6, order: 1, prompt: 'And the rollout?', rubric: 'R2', options: [], correct_option_ids: [],
  });
  await store.insert('questions', {
    ...base, type: 'mcq_single', order: 2, prompt: 'Pick B.',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
  });
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });

  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mkUser({ username: 'assessor', name: 'Assessor', role: 'assessor', email: '', password: 'a-pass-x' });
  const assessor2 = await mkUser({ username: 'assessor2', name: 'Other', role: 'assessor', email: '', password: 'a2-pass-x' });
  const candidate = await store.insert('candidates', { name: 'Candidate', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'candidate', name: 'Candidate', role: 'candidate', email: '', candidate_id: candidate.id, password: 'c-pass-x' });
  const candidate2 = await store.insert('candidates', { name: 'Second', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'candidate2', name: 'Second', role: 'candidate', email: '', candidate_id: candidate2.id, password: 'c2-pass-x' });

  const call = (method, p, { token, body } = {}) =>
    app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (username, password) => (await call('POST', '/auth/login', { body: { username, password } })).body.token;
  const tokens = {
    admin: await login('admin', 'admin-pass-x'),
    assessor: await login('assessor', 'a-pass-x'),
    assessor2: await login('assessor2', 'a2-pass-x'),
    candidate: await login('candidate', 'c-pass-x'),
    candidate2: await login('candidate2', 'c2-pass-x'),
  };

  const allocate = async (candId = candidate.id) => {
    const res = await call('POST', '/admin/assessments', {
      token: tokens.admin, body: { candidate_id: candId, role_id: role.id, assessor_id: assessor.id },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { id: res.body.id, paper: sortedQuestions(res.body.snapshot_json) };
  };
  /** Walk the paper: spoken answers for the open questions (or as given), 'b' for the MCQ. */
  const walk = async (id, tok, answers) => {
    for (let i = 0; i < 20; i += 1) {
      const d = (await call('GET', `/candidate/assessments/${id}`, { token: tok })).body;
      if (d.exam.complete) break;
      if (d.exam.phase === 'review') {
        await call('POST', `/candidate/assessments/${id}/phase`, { token: tok, body: { phase: 'answer' } });
        continue;
      }
      const q = d.current_question;
      const answer = q.type === 'text' ? (answers?.[q.id] ?? { text: '', transcript: `spoken ${q.id}`, source: 'audio', audio_b64: B64, audio_mime: 'audio/webm' }) : 'b';
      const r = await call('POST', `/candidate/assessments/${id}/next`, { token: tok, body: { question_id: q.id, answer } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  };
  /**
   * Bring an open question on screen (the paper is shuffled, and a draft is
   * only taken for the live question) and return it.
   */
  const liveOpen = async (id, tok) => {
    for (let i = 0; i < 20; i += 1) {
      const d = (await call('GET', `/candidate/assessments/${id}`, { token: tok })).body;
      const q = d.current_question;
      if (!q) throw new Error('no live question');
      if (q.type === 'text') {
        if (d.exam.phase === 'review') await call('POST', `/candidate/assessments/${id}/phase`, { token: tok, body: { phase: 'answer' } });
        return q;
      }
      if (d.exam.phase === 'review') { await call('POST', `/candidate/assessments/${id}/phase`, { token: tok, body: { phase: 'answer' } }); continue; }
      await call('POST', `/candidate/assessments/${id}/next`, { token: tok, body: { question_id: q.id, answer: 'b' } });
    }
    throw new Error('no open question reached');
  };
  const recordings = (id) => store.list('recordings', { assessment_id: id });
  const row = async (id, qid) => (await store.list('responses', { assessment_id: id })).find((r) => r.question_id === qid);
  return { store, call, tokens, allocate, walk, liveOpen, recordings, row, open1, open2, candidate, candidate2, assessor2, tmp };
}

test('a spoken answer is stored as a reference plus one recording row, never inline', async () => {
  const w = await makeWorld();
  const { id } = await w.allocate();
  const tok = w.tokens.candidate;
  const dbBefore = fs.statSync(path.join(w.tmp, 'db.json')).size;

  await w.walk(id, tok);

  const r1 = await w.row(id, w.open1.id);
  assert.equal(r1.locked, true);
  assert.equal(r1.answer.audio_b64, undefined, 'no clip on the response row');
  assert.equal(r1.answer.audio_ref, `${id}/${w.open1.id}`);
  assert.equal(r1.answer.audio_mime, 'audio/webm');
  assert.equal(r1.answer.audio_missing, undefined, 'a referenced recording satisfies the spoken-answer contract');
  const recs = await w.recordings(id);
  assert.deepEqual(recs.map((r) => r.id).sort(), [`${id}/${w.open1.id}`, `${id}/${w.open2.id}`].sort());
  assert.deepEqual(recs.find((r) => r.question_id === w.open1.id).audio, { b64: B64, mime: 'audio/webm' });
  const dbAfter = fs.statSync(path.join(w.tmp, 'db.json')).size;
  assert.ok(dbAfter - dbBefore < 4000, `the database file grows by the answers, not the audio (${dbAfter - dbBefore} bytes)`);
  assert.ok(!fs.readFileSync(path.join(w.tmp, 'db.json'), 'utf8').includes(B64), 'the clip is not in the database file at all');

  // the candidate's own view never carries the clip either (only that it exists)
  const mine = await w.call('GET', `/candidate/assessments/${id}`, { token: tok });
  assert.ok(!JSON.stringify(mine.body).includes(B64));

  // submit keeps the reference and the row, and writes nothing new for it
  assert.equal((await w.call('POST', `/candidate/assessments/${id}/submit`, { token: tok, body: { answers: {} } })).status, 200);
  assert.equal((await w.row(id, w.open1.id)).answer.audio_ref, `${id}/${w.open1.id}`);
  assert.equal((await w.recordings(id)).length, 2);
});

test('re-recording replaces the row in place; clearing the draft removes it; a typed-only draft keeps no recording', async () => {
  const w = await makeWorld();
  const { id } = await w.allocate();
  const tok = w.tokens.candidate;
  const put = (answers) => w.call('PUT', `/candidate/assessments/${id}/answers`, { token: tok, body: { answers } });
  const q = await w.liveOpen(id, tok);
  const requiresAudio = true; // every open question does (spoken-answer contract)

  assert.equal((await put({ [q.id]: { text: '', transcript: 'take one', source: 'audio', audio_b64: B64, audio_mime: 'audio/webm' } })).status, 200);
  assert.equal((await put({ [q.id]: { text: '', transcript: 'take two', source: 'audio', audio_b64: B64_2, audio_mime: 'audio/webm' } })).status, 200);
  let recs = await w.recordings(id);
  assert.equal(recs.length, 1, 'one row per (assessment, question), replaced in place');
  assert.equal(recs[0].audio.b64, B64_2);
  assert.ok(recs[0].updated_at, 'the second take is an update of the first row');

  // a re-save without a clip but with typed notes keeps the answer as typed notes only
  assert.equal((await put({ [q.id]: { text: 'typed instead', transcript: '', source: 'typed' } })).status, 200);
  const typed = await w.row(id, q.id);
  assert.equal(typed.answer.text, 'typed instead');
  assert.equal(typed.answer.audio_ref, undefined, 'the candidate cannot keep a clip by omitting it from the draft');
  assert.equal(typed.answer.audio_missing, requiresAudio);
  assert.deepEqual(await w.recordings(id), [], 'and the superseded recording is gone');

  // the candidate cannot point an answer at someone else's recording
  await w.store.insert('recordings', { assessment_id: 'other', question_id: 'x', audio: { b64: 'c3RvbGVu', mime: 'audio/webm' } });
  assert.equal((await put({ [q.id]: { text: '', transcript: 'spoken', source: 'audio', audio_ref: 'other/x' } })).status, 200);
  assert.equal((await w.row(id, q.id)).answer.audio_ref, undefined, 'a client-supplied audio_ref is ignored');

  // clearing the draft entirely removes both the row and the recording
  assert.equal((await put({ [q.id]: { text: '', transcript: 'again', source: 'audio', audio_b64: B64, audio_mime: 'audio/webm' } })).status, 200);
  assert.equal((await w.recordings(id)).length, 1);
  assert.equal((await put({ [q.id]: { text: '', transcript: '' } })).status, 200);
  assert.equal(await w.row(id, q.id), undefined);
  assert.deepEqual(await w.recordings(id), []);
});

test('the mime type is kept to what a recorder reports; anything else falls back to audio/webm', async () => {
  const w = await makeWorld();
  const { id } = await w.allocate();
  const tok = w.tokens.candidate;
  const q = await w.liveOpen(id, tok);
  const put = (mime) => w.call('PUT', `/candidate/assessments/${id}/answers`, {
    token: tok, body: { answers: { [q.id]: { text: '', transcript: 'x', source: 'audio', audio_b64: B64, audio_mime: mime } } },
  });
  for (const [sent, kept] of [
    ['audio/webm;codecs=opus', 'audio/webm;codecs=opus'],
    ['audio/ogg; codecs=opus', 'audio/ogg; codecs=opus'],
    ['audio/mp4', 'audio/mp4'],
    ['audio/webm;codecs=opus"><img src=x onerror=alert(1)>', 'audio/webm'],
    ['text/html', 'audio/webm'],
    ['', 'audio/webm'],
    [42, 'audio/webm'],
  ]) {
    assert.equal((await put(sent)).status, 200);
    assert.equal((await w.row(id, q.id)).answer.audio_mime, kept, `mime ${JSON.stringify(sent)}`);
    assert.equal((await w.recordings(id))[0].audio.mime, kept);
  }
});

test('assessor detail carries has_recording only; the clip comes from the per-question endpoint with the same access rules', async () => {
  const w = await makeWorld();
  const { id } = await w.allocate();
  const tok = w.tokens.candidate;
  await w.walk(id, tok, { [w.open2.id]: { text: 'typed only', transcript: '', source: 'typed' } });
  const rec = (t, qid = w.open1.id, aid = id) => w.call('GET', `/assessor/assessments/${aid}/recordings/${qid}`, { token: t });

  // before submission: detail refuses, and so does the recording endpoint
  assert.equal((await rec(w.tokens.assessor)).status, 409, 'not submitted yet');
  assert.equal((await w.call('POST', `/candidate/assessments/${id}/submit`, { token: tok, body: { answers: {} } })).status, 200);

  const detail = await w.call('GET', `/assessor/assessments/${id}`, { token: w.tokens.assessor });
  assert.equal(detail.status, 200);
  const text = JSON.stringify(detail.body);
  assert.ok(!text.includes('audio_b64') && !text.includes('audio_ref') && !text.includes(B64), 'the detail payload has no audio bytes and no storage references');
  const byQ = Object.fromEntries(detail.body.responses.map((r) => [r.question_id, r.answer]));
  assert.equal(byQ[w.open1.id].has_recording, true);
  assert.equal(byQ[w.open1.id].transcript, `spoken ${w.open1.id}`);
  assert.equal(byQ[w.open1.id].audio_mime, 'audio/webm', 'the mime stays: harmless, and useful for the player');
  assert.equal(byQ[w.open2.id].has_recording, false);
  assert.equal(byQ[w.open2.id].text, 'typed only');
  assert.equal(byQ[w.open2.id].audio_missing, true, 'every open question expects a spoken answer; typed-only is flagged');

  // the clip, on demand
  const clip = await rec(w.tokens.assessor);
  assert.equal(clip.status, 200, JSON.stringify(clip.body));
  assert.deepEqual(clip.body, { question_id: w.open1.id, audio_b64: B64, audio_mime: 'audio/webm' });
  assert.equal((await rec(w.tokens.assessor, w.open2.id)).status, 404, 'a question without a recording');
  assert.equal((await rec(w.tokens.assessor, 'nope')).status, 404);
  assert.equal((await rec(w.tokens.assessor, '../../etc/passwd')).status, 404, 'traversal-shaped ids match nothing');
  assert.equal((await rec(w.tokens.assessor2)).status, 404, 'another assessor: existence is hidden, like the detail');
  assert.equal((await rec(w.tokens.assessor, w.open1.id, 'missing')).status, 404);
  assert.equal((await rec(w.tokens.admin)).status, 403, 'admin reviews reports, not raw recordings');
  assert.equal((await rec(tok)).status, 403, 'the candidate cannot pull their own clip back out');
  assert.equal((await rec(null)).status, 401);

  // still served after the assessor finalizes (the report view can revisit it)
  assert.equal((await w.call('PUT', `/assessor/assessments/${id}/scores`, {
    token: w.tokens.assessor, body: { scores: [{ question_id: w.open1.id, score: 5 }, { question_id: w.open2.id, score: 3 }] },
  })).status, 200);
  assert.equal((await w.call('POST', `/assessor/assessments/${id}/finalize`, { token: w.tokens.assessor })).status, 200);
  assert.equal((await rec(w.tokens.assessor)).status, 200);
});

test('a paper stored before the recordings table (clip inline on the row) is still served, and migrated on submit', async () => {
  const w = await makeWorld();
  // (a) an already-submitted legacy paper: served straight from the row
  const legacy = await w.allocate();
  await w.walk(legacy.id, w.tokens.candidate, { [w.open1.id]: { text: '', transcript: 'old', source: 'audio' } });
  assert.equal((await w.call('POST', `/candidate/assessments/${legacy.id}/submit`, { token: w.tokens.candidate, body: { answers: {} } })).status, 200);
  const legacyRow = await w.row(legacy.id, w.open1.id);
  await w.store.update('responses', legacyRow.id, {
    answer: { text: '', transcript: 'old', source: 'audio', audio_mime: 'audio/ogg', audio_b64: B64_2 },
  });
  const detail = await w.call('GET', `/assessor/assessments/${legacy.id}`, { token: w.tokens.assessor });
  const ans = detail.body.responses.find((r) => r.question_id === w.open1.id).answer;
  assert.equal(ans.has_recording, true);
  assert.equal(ans.audio_b64, undefined, 'even a legacy inline clip is stripped from the detail');
  const clip = await w.call('GET', `/assessor/assessments/${legacy.id}/recordings/${w.open1.id}`, { token: w.tokens.assessor });
  assert.deepEqual(clip.body, { question_id: w.open1.id, audio_b64: B64_2, audio_mime: 'audio/ogg' });

  // (b) an in-progress legacy paper: submit moves the clip into the recordings table
  const live = await w.allocate(w.candidate2.id);
  const tok = w.tokens.candidate2;
  await w.walk(live.id, tok);
  const liveRow = await w.row(live.id, w.open1.id);
  await w.store.remove('recordings', liveRow.answer.audio_ref);
  await w.store.update('responses', liveRow.id, {
    answer: { text: '', transcript: 'inline era', source: 'audio', audio_mime: 'audio/webm', audio_b64: B64 },
  });
  assert.equal((await w.call('POST', `/candidate/assessments/${live.id}/submit`, { token: tok, body: { answers: {} } })).status, 200);
  const migrated = await w.row(live.id, w.open1.id);
  assert.equal(migrated.answer.audio_b64, undefined, 'the clip left the response row');
  assert.equal(migrated.answer.audio_ref, `${live.id}/${w.open1.id}`);
  assert.equal(migrated.answer.transcript, 'inline era');
  assert.equal((await w.store.get('recordings', `${live.id}/${w.open1.id}`)).audio.b64, B64);
  assert.equal((await w.call('GET', `/assessor/assessments/${live.id}/recordings/${w.open1.id}`, { token: w.tokens.assessor })).body.audio_b64, B64);
});

test('deleting an assessment or a candidate removes their recordings too', async () => {
  const w = await makeWorld();
  const a = await w.allocate();
  const q = await w.liveOpen(a.id, w.tokens.candidate);
  assert.equal((await w.call('PUT', `/candidate/assessments/${a.id}/answers`, {
    token: w.tokens.candidate, body: { answers: { [q.id]: { text: '', transcript: 'x', source: 'audio', audio_b64: B64, audio_mime: 'audio/webm' } } },
  })).status, 200);
  assert.equal((await w.recordings(a.id)).length, 1);
  assert.equal((await w.call('DELETE', `/admin/assessments/${a.id}`, { token: w.tokens.admin })).status, 200);
  assert.deepEqual(await w.recordings(a.id), [], 'DELETE /admin/assessments/:id cascades to recordings');

  const b = await w.allocate(w.candidate2.id);
  await w.walk(b.id, w.tokens.candidate2);
  assert.equal((await w.call('POST', `/candidate/assessments/${b.id}/submit`, { token: w.tokens.candidate2, body: { answers: {} } })).status, 200);
  assert.equal((await w.recordings(b.id)).length, 2);
  const del = await w.call('DELETE', `/admin/candidates/${w.candidate2.id}`, { token: w.tokens.admin, body: { password: 'admin-pass-x' } });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(await w.recordings(b.id), [], 'deleting the candidate cascades to recordings');
  assert.deepEqual(await w.store.list('recordings'), [], 'nothing orphaned');
});

/* ------------------------------------------------------------------------ */
/* UI: the scoring screen streams clips in two at a time                     */
/* ------------------------------------------------------------------------ */

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function setupDom(fetchImpl) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
    { url: 'http://localhost:3000/#/workspace', pretendToBeVisual: true },
  );
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, location: window.location, localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HashChangeEvent: window.HashChangeEvent, Event: window.Event, fetch: fetchImpl,
  });
  return dom;
}
function teardown(dom) {
  dom.window.close();
  for (const k of ['window', 'document', 'location', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'Event', 'fetch']) delete globalThis[k];
}

const DETAIL = {
  assessment: { id: 'asm1', status: 'submitted', submitted_at: '2026-09-20T10:00:00Z', role: { name: 'RSA' } },
  candidate: { name: 'Cand', current_title: 'Engineer', years_experience: 5 },
  competencies: [{ id: 'c1', name: 'Core', weight: 100, target_level: 3 }],
  questions: [
    { id: 'q1', competency_id: 'c1', type: 'text', prompt: 'One', points: 6, rubric: 'R', audio_required: true },
    { id: 'q2', competency_id: 'c1', type: 'text', prompt: 'Two', points: 6, rubric: 'R', audio_required: true },
    { id: 'q3', competency_id: 'c1', type: 'text', prompt: 'Three', points: 6, rubric: 'R' },
    { id: 'q4', competency_id: 'c1', type: 'text', prompt: 'Four', points: 6, rubric: 'R', audio_required: true },
  ],
  responses: [
    { question_id: 'q1', answer: { text: '', transcript: 'one', source: 'audio', audio_mime: 'audio/webm', has_recording: true }, auto_score: null, assessor_score: null, assessor_comment: '' },
    { question_id: 'q2', answer: { text: '', transcript: 'two', source: 'audio', audio_mime: 'audio/webm', has_recording: true }, auto_score: null, assessor_score: null, assessor_comment: '' },
    { question_id: 'q3', answer: { text: 'typed', transcript: '', source: 'typed', has_recording: false }, auto_score: null, assessor_score: null, assessor_comment: '' },
    { question_id: 'q4', answer: { text: 'notes only', transcript: '', source: 'typed', has_recording: false, audio_missing: true }, auto_score: null, assessor_score: null, assessor_comment: '' },
  ],
  scoring_progress: { manual_total: 4, manual_scored: 0 },
  report: null,
};

test('scoring screen: recordings load per question from the endpoint, two at a time, with retry and unmount stop', { skip: SKIP }, async () => {
  const pending = new Map(); // qid -> resolve
  const calls = [];
  let inflight = 0; let maxInflight = 0;
  const fetchImpl = async (url, opts = {}) => {
    const p = String(url);
    calls.push(p);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (p.includes('/auth/me')) return json({ user: { id: 'u1', name: 'A', role: 'assessor' }, candidate: null });
    if (p.includes('/meta/bootstrap')) return json({ pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] });
    const m = p.match(/\/assessor\/assessments\/asm1\/recordings\/(\w+)$/);
    if (m) {
      inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      const body = await new Promise((resolve) => pending.set(m[1], resolve));
      inflight -= 1;
      if (body instanceof Error) return json({ error: body.message }, 500);
      return json(body);
    }
    if (p.endsWith('/assessor/assessments/asm1')) return json(DETAIL);
    assert.equal(opts.method || 'GET', 'GET', `unexpected call ${p}`);
    return json({});
  };
  const dom = setupDom(fetchImpl);
  try {
    localStorage.setItem('ecod.token', 'tok');
    const { state } = await import('../public/js/app.js');
    state.meta = { pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] };
    const { assessmentView } = await import('../public/js/views/assessor.js');
    const view = document.getElementById('view');
    await assessmentView(view, { id: 'asm1' });
    await flush();

    const slots = [...view.querySelectorAll('.exam-audio-slot')];
    assert.deepEqual(slots.map((s) => s.dataset.recording), ['q1', 'q2'], 'one slot per answer that has a recording, in paper order');
    assert.ok(!view.innerHTML.includes('audio_b64'), 'no inline audio in the markup');
    assert.match(view.textContent, /Loading recording…/);
    assert.equal(maxInflight, 2, 'two clips in flight, not all at once');
    assert.deepEqual([...pending.keys()], ['q1', 'q2']);
    assert.ok(!calls.some((c) => c.includes('/recordings/q3')), 'a typed answer requests nothing');

    // q4 is a required-audio question answered without a clip: warned, not a slot
    const cards = [...view.querySelectorAll('.q-card')];
    assert.match(cards[3].textContent, /No recording was submitted/);
    assert.equal(cards[3].querySelector('.exam-audio-slot'), null);
    // q3 (audio not required, typed) shows the typed text plainly
    assert.match(cards[2].textContent, /typed/);
    assert.doesNotMatch(cards[2].textContent, /No recording/);

    // first clip lands → a player with a data: URL; the second request fails → retry offered
    pending.get('q1')({ question_id: 'q1', audio_b64: B64, audio_mime: 'audio/webm' });
    pending.get('q2')(new Error('storage hiccup'));
    await flush();
    const player = slots[0].querySelector('audio.exam-audio-playback');
    assert.ok(player, 'q1 has a player');
    assert.equal(player.getAttribute('src'), `data:audio/webm;base64,${B64}`);
    assert.equal(player.controls, true);
    assert.match(slots[1].textContent, /Recording could not be loaded: storage hiccup/);
    const retry = slots[1].querySelector('button');
    assert.ok(retry, 'and a retry button');
    assert.ok(!calls.some((c) => c.includes('/recordings/q2') && calls.filter((x) => x === c).length > 1), 'no automatic re-request yet');

    retry.click();
    await flush();
    assert.equal(calls.filter((c) => c.endsWith('/recordings/q2')).length, 2, 'retry re-requests exactly that clip');
    assert.match(slots[1].textContent, /Loading recording…/);

    // leaving the page stops the queue: a late answer is dropped, not rendered into a dead slot
    document.dispatchEvent(new window.Event('ecod:view-unmount'));
    view.innerHTML = '<div>another view</div>';
    pending.get('q2')({ question_id: 'q2', audio_b64: B64_2, audio_mime: 'audio/webm' });
    await flush();
    assert.equal(slots[1].querySelector('audio'), null, 'nothing is written after unmount');
    assert.equal(calls.filter((c) => c.includes('/recordings/')).length, 3, 'no further requests after unmount');
  } finally { teardown(dom); }
});

test('scoring screen: a report-era answer that still carries inline audio gets a slot too (served by the endpoint)', { skip: SKIP }, async () => {
  const fetchImpl = async (url) => {
    const p = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (p.includes('/auth/me')) return json({ user: { id: 'u1', name: 'A', role: 'assessor' }, candidate: null });
    if (p.includes('/meta/bootstrap')) return json({ pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] });
    if (p.endsWith('/recordings/q1')) return json({ question_id: 'q1', audio_b64: B64, audio_mime: 'audio/ogg; codecs=opus' });
    if (p.endsWith('/assessor/assessments/asm1')) {
      return json({
        ...DETAIL,
        questions: DETAIL.questions.slice(0, 1),
        responses: [{ question_id: 'q1', answer: { text: '', transcript: 'one', source: 'audio', audio_mime: 'audio/ogg; codecs=opus', audio_b64: 'stale-client-cache' }, auto_score: null, assessor_score: null, assessor_comment: '' }],
      });
    }
    return json({});
  };
  const dom = setupDom(fetchImpl);
  try {
    localStorage.setItem('ecod.token', 'tok');
    const { state } = await import('../public/js/app.js');
    state.meta = { pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] };
    const { assessmentView } = await import('../public/js/views/assessor.js');
    const view = document.getElementById('view');
    await assessmentView(view, { id: 'asm1' });
    await flush(40);
    const player = view.querySelector('.exam-audio-slot audio');
    assert.ok(player);
    assert.equal(player.getAttribute('src'), `data:audio/ogg; codecs=opus;base64,${B64}`);
    assert.ok(!view.innerHTML.includes('stale-client-cache'), 'whatever the payload carried inline is never rendered');
  } finally { teardown(dom); }
});
