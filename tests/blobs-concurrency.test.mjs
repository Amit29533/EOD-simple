import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlobsStore } from '../src/storage/netlify-blobs.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';

/**
 * Netlify Blobs across function instances.
 *
 * A deploy runs many function instances behind ONE blob store, and each table
 * is one blob. The adapter's per-process lock serialises the read-modify-write
 * inside an instance only: two candidates locking an answer at the same
 * moment on two instances both read `responses`, each added their own row,
 * and each wrote the whole blob back — the second write erased the first
 * candidate's answer. Same for two cursor advances on `assessments` (one
 * candidate was re-served the question they had just left). Reproduced with
 * a two-instance double at 20 ms of blob latency: one of two updates lost,
 * one of two answers lost, every time.
 *
 * Every blob carries an ETag and the store offers conditional writes
 * (`onlyIfMatch` / `onlyIfNew`, @netlify/blobs ≥ 10.7.12). Every whole-table
 * write is now conditional on the ETag the read saw; a conflict re-reads and
 * re-applies the mutation; a table rewritten faster than an instance can
 * re-read it gives up with STORE_CONFLICT, which the API answers as 503 —
 * never with silently dropped data.
 */

/** In-memory Netlify Blobs with production semantics: ETags on reads, conditional writes, 412 → modified:false. */
function blobBackend({ latency = 0, jitter = 0, etagsOnRead = true, conditional = true, forceConflicts = null } = {}) {
  const data = new Map(); // key -> { json, etag }
  const log = [];
  let n = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const wait = () => (latency || jitter ? new Promise((r) => setTimeout(r, latency + Math.random() * jitter)) : Promise.resolve());
  const stats = { conflicts: 0, writes: 0, reads: 0 };
  const store = {
    async get(key, opts) { await wait(); stats.reads += 1; log.push(['get', key, opts?.consistency]); return data.has(key) ? clone(data.get(key).json) : null; },
    async getWithMetadata(key, opts) {
      await wait(); stats.reads += 1; log.push(['getWithMetadata', key, opts?.consistency]);
      if (!data.has(key)) return null;
      const { json, etag } = data.get(key);
      return { data: clone(json), etag: etagsOnRead ? etag : undefined, metadata: {} };
    },
    async setJSON(key, value, opts = {}) {
      await wait(); stats.writes += 1; log.push(['setJSON', key, opts]);
      const cur = data.get(key);
      if (forceConflicts && forceConflicts(key, opts)) { stats.conflicts += 1; return { modified: false }; }
      if (conditional) {
        if (opts.onlyIfNew && cur) { stats.conflicts += 1; return { modified: false }; }
        if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) { stats.conflicts += 1; return { modified: false }; }
      }
      const etag = `"v${++n}"`;
      data.set(key, { json: clone(value), etag });
      return { modified: true, etag };
    },
    async delete(key) { await wait(); log.push(['delete', key]); data.delete(key); },
    async list({ prefix = '' } = {}) {
      await wait();
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: data.get(key).etag })), directories: [] };
    },
  };
  return { data, log, stats, module: { getStore: () => store }, table: (t) => (data.has(t) ? clone(data.get(t).json) : null) };
}

test('two instances updating different rows of one table at the same moment: both updates survive', async () => {
  const be = blobBackend({ latency: 15, jitter: 10 });
  const inst1 = await createBlobsStore({ blobsModule: be.module });
  const inst2 = await createBlobsStore({ blobsModule: be.module });
  await inst1.insert('assessments', { id: 'A', quiz_state: { index: 0 } });
  await inst1.insert('assessments', { id: 'B', quiz_state: { index: 0 } });

  await Promise.all([
    inst1.update('assessments', 'A', { quiz_state: { index: 1 } }),
    inst2.update('assessments', 'B', { quiz_state: { index: 1 } }),
  ]);
  const table = be.table('assessments');
  assert.equal(table.A.quiz_state.index, 1, "instance 1's cursor advance is stored");
  assert.equal(table.B.quiz_state.index, 1, "instance 2's cursor advance is stored too");
  assert.ok(be.stats.conflicts >= 1, 'the overlap was detected as a conflict and retried, not overwritten');
  assert.ok(be.log.some(([op, , opts]) => op === 'setJSON' && opts?.onlyIfMatch), 'writes are conditional on the ETag that was read');
  // and each instance's own view (its cache) agrees with the store
  assert.equal((await inst1.get('assessments', 'B')).quiz_state.index, 1);
  assert.equal((await inst2.get('assessments', 'A')).quiz_state.index, 1);
});

test('two instances inserting into one table at the same moment: both rows survive, ids unique, a retried insert is not duplicated', async () => {
  const be = blobBackend({ latency: 10, jitter: 10 });
  const instances = await Promise.all([1, 2, 3].map(() => createBlobsStore({ blobsModule: be.module })));
  const results = await Promise.all(instances.flatMap((inst, i) => [0, 1, 2, 3].map((k) =>
    inst.insert('responses', { assessment_id: `asm${i}`, question_id: `q${k}`, answer: k }))));
  // responses are one blob per assessment, so the three papers never collide
  // with each other at all; the four inserts of one paper (one instance) are
  // serialised by that instance's lock
  const shards = [0, 1, 2].map((i) => be.table(`shards/responses/asm${i}`));
  assert.equal(be.table('responses'), null, 'no whole-table blob');
  assert.deepEqual(shards.map((t) => Object.keys(t).length), [4, 4, 4], 'every locked answer is in its paper');
  assert.equal(new Set(results.map((r) => r.id)).size, 12, 'ids are unique');
  for (const r of results) assert.deepEqual(shards[Number(r.assessment_id.slice(3))][r.id], r, 'the row stored under the returned id is the row returned');
  assert.equal(be.stats.conflicts, 0, 'per-paper blobs: nothing to conflict on');

  // the same, for a table that IS shared: three instances inserting sessions
  const sessions = await Promise.all(instances.flatMap((inst, i) => [0, 1].map((k) => inst.insert('sessions', { token: `t${i}${k}`, user_id: 'u' }))));
  assert.equal(Object.keys(be.table('sessions')).length, 6, 'every session is in the store');
  for (const r of sessions) assert.deepEqual(be.table('sessions')[r.id], r, 'a retry re-wrote the same id, not a second row');
  assert.ok(be.stats.conflicts >= 1);
});

test('the very first write of a table is create-only: two instances creating a table at once keep both rows', async () => {
  const be = blobBackend({ latency: 10 });
  const inst1 = await createBlobsStore({ blobsModule: be.module });
  const inst2 = await createBlobsStore({ blobsModule: be.module });
  await Promise.all([
    inst1.insert('audit_log', { id: 'e1', action: 'a' }),
    inst2.insert('audit_log', { id: 'e2', action: 'b' }),
  ]);
  assert.deepEqual(Object.keys(be.table('audit_log')).sort(), ['e1', 'e2']);
  assert.ok(be.log.some(([op, key, opts]) => op === 'setJSON' && key === 'audit_log' && opts?.onlyIfNew === true), 'a missing blob is written with onlyIfNew');
  assert.ok(be.stats.conflicts >= 1, 'the loser of the create race retried as an update');
});

test('a table rewritten faster than the instance can re-read it gives up with STORE_CONFLICT; the API answers 503 and nothing is cached', async () => {
  const be = blobBackend({ forceConflicts: (key) => key === 'sessions' });
  const store = await createBlobsStore({ blobsModule: be.module });
  await store.insert('users', { username: 'admin', name: 'A', role: 'admin', email: '', password_hash: hashPassword('pw-x'), active: true });
  const t0 = Date.now();
  await assert.rejects(store.insert('sessions', { token: 't', user_id: 'u' }), (err) => err.code === 'STORE_CONFLICT' && /sessions/.test(err.message));
  assert.ok(be.stats.conflicts >= 5, `it retried several times (${be.stats.conflicts})`);
  assert.ok(Date.now() - t0 < 5000, 'and gave up within a bounded time');
  assert.deepEqual(await store.list('sessions'), [], 'the failed write left nothing in the cache');

  const app = await createApp(store);
  const res = await app({ method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'pw-x' }, headers: {} });
  assert.equal(res.status, 503, 'a login whose session cannot be written is a retryable 503, not a 500');
  assert.match(res.body.error, /being updated by another process/);
});

test('a mutation that changes nothing writes nothing, so it cannot conflict', async () => {
  const be = blobBackend();
  const store = await createBlobsStore({ blobsModule: be.module });
  await store.insert('roles', { id: 'r1', key: 'a', name: 'A' });
  const writes = be.stats.writes;
  assert.equal(await store.update('roles', 'missing', { name: 'x' }), null);
  assert.equal(await store.remove('roles', 'missing'), false);
  assert.equal(await store.removeMany('roles', ['missing', 'also-missing']), 0);
  assert.deepEqual(await store.updateMany('roles', [{ id: 'missing', patch: {} }]), [null]);
  assert.deepEqual(await store.insertMany('roles', []), []);
  assert.equal(be.stats.writes, writes, 'no blob write for a no-op');
});

test('degrades to the pre-CAS behaviour when the SDK gives no ETag (local BlobsServer, older SDKs, simple doubles)', async () => {
  // (a) reads without an ETag → unconditional writes, still correct in one process
  const noEtag = blobBackend({ etagsOnRead: false });
  const s1 = await createBlobsStore({ blobsModule: noEtag.module });
  await s1.insert('roles', { id: 'r1', key: 'a', name: 'A' });
  await s1.update('roles', 'r1', { name: 'B' });
  assert.equal((await s1.get('roles', 'r1')).name, 'B');
  const writes = noEtag.log.filter(([op]) => op === 'setJSON');
  assert.ok(writes.length >= 2);
  assert.ok(writes.slice(1).every(([, , opts]) => !opts.onlyIfMatch && !opts.onlyIfNew), 'no condition can be asserted without an ETag (the first write of a new blob is still create-only)');
  assert.ok(writes[0][2].onlyIfNew === true, 'the first write of a new blob is create-only');

  // (b) an SDK whose setJSON returns nothing and has no getWithMetadata (v8 shape)
  const v8 = { data: {} };
  const v8store = {
    get: async (key, opts) => { v8.lastGet = opts; return v8.data[key] ? JSON.parse(JSON.stringify(v8.data[key])) : null; },
    setJSON: async (key, value) => { v8.data[key] = JSON.parse(JSON.stringify(value)); },
  };
  const s2 = await createBlobsStore({ blobsModule: { getStore: () => v8store } });
  const r = await s2.insert('roles', { key: 'a', name: 'A' });
  assert.equal(v8.lastGet.consistency, 'strong', 'the read before a write is still strong');
  assert.equal((await s2.update('roles', r.id, { name: 'C' })).name, 'C');
  assert.equal(await s2.remove('roles', r.id), true);
  assert.deepEqual(v8.data.roles, {});
});

/* --------------------------------------------------------------------------- */
/* End to end: two exam requests on two instances                              */
/* --------------------------------------------------------------------------- */

async function seedWorld(store) {
  const role = await store.insert('roles', { key: 'rsa', name: 'RSA', technology: 'X', description: '', active: true });
  const comp = await store.insert('competencies', { role_id: role.id, key: 'core', name: 'Core', category: 'technical', weight: 100, target_level: 3, order: 1, active: true });
  const base = { role_id: role.id, competency_id: comp.id, help_text: '', difficulty: 'intermediate', points: 4, rubric: '', active: true };
  for (let i = 0; i < 3; i += 1) {
    await store.insert('questions', {
      ...base, type: 'mcq_single', order: i, prompt: `Pick B (${i}).`,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
    });
  }
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });
  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mkUser({ username: 'assessor', name: 'Assessor', role: 'assessor', email: '', password: 'a-pass-x' });
  const cands = [];
  for (const name of ['one', 'two']) {
    const c = await store.insert('candidates', { name, stage: 'assessment', target_role_id: role.id });
    await mkUser({ username: name, name, role: 'candidate', email: '', candidate_id: c.id, password: `${name}-pass-x` });
    cands.push(c);
  }
  return { role, assessor, cands };
}

test('two candidates on two function instances lock answers at the same moment: both answers and both cursors are kept', async () => {
  const be = blobBackend({ latency: 12, jitter: 12 });
  const inst1 = await createBlobsStore({ blobsModule: be.module });
  const inst2 = await createBlobsStore({ blobsModule: be.module });
  const { role, assessor, cands } = await seedWorld(inst1);
  const app1 = await createApp(inst1);
  const app2 = await createApp(inst2);
  const call = (app, method, p, { token, body } = {}) => app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (app, username, password) => (await call(app, 'POST', '/auth/login', { body: { username, password } })).body.token;

  const admin = await login(app1, 'admin', 'admin-pass-x');
  const ids = [];
  for (const c of cands) {
    const res = await call(app1, 'POST', '/admin/assessments', { token: admin, body: { candidate_id: c.id, role_id: role.id, assessor_id: assessor.id } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.push(res.body.id);
  }
  // candidate one is served by instance 1, candidate two by instance 2 —
  // and instance 2 must see the sessions instance 1 created
  const tok1 = await login(app1, 'one', 'one-pass-x');
  const tok2 = await login(app2, 'two', 'two-pass-x');
  const open1 = await call(app1, 'GET', `/candidate/assessments/${ids[0]}`, { token: tok1 });
  const open2 = await call(app2, 'GET', `/candidate/assessments/${ids[1]}`, { token: tok2 });
  assert.equal(open1.status, 200); assert.equal(open2.status, 200);

  const [n1, n2] = await Promise.all([
    call(app1, 'POST', `/candidate/assessments/${ids[0]}/next`, { token: tok1, body: { question_id: open1.body.current_question.id, answer: 'b' } }),
    call(app2, 'POST', `/candidate/assessments/${ids[1]}/next`, { token: tok2, body: { question_id: open2.body.current_question.id, answer: 'b' } }),
  ]);
  assert.equal(n1.status, 200, JSON.stringify(n1.body));
  assert.equal(n2.status, 200, JSON.stringify(n2.body));

  assert.equal(Object.values(be.table(`shards/responses/${ids[0]}`)).filter((r) => r.locked).length, 1, "candidate one's locked answer is in the store");
  assert.equal(Object.values(be.table(`shards/responses/${ids[1]}`)).filter((r) => r.locked).length, 1, "candidate two's locked answer is in the store");
  const asm = be.table('assessments');
  assert.equal(asm[ids[0]].quiz_state.index, 1, "candidate one's cursor advanced");
  assert.equal(asm[ids[1]].quiz_state.index, 1, "candidate two's cursor advanced");
  // (whether the two cursor writes actually overlapped depends on the jitter;
  // the first test above forces the overlap — this one proves the outcome)

  // each instance serves the right next question to its candidate afterwards
  const after1 = await call(app1, 'GET', `/candidate/assessments/${ids[0]}`, { token: tok1 });
  const after2 = await call(app2, 'GET', `/candidate/assessments/${ids[1]}`, { token: tok2 });
  assert.equal(after1.body.exam.index, 1);
  assert.equal(after2.body.exam.index, 1);
  assert.notEqual(after1.body.current_question.id, open1.body.current_question.id, 'candidate one is not re-served the question they just left');
});
