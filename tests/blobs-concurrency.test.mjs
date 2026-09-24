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

test('two instances conditionally advancing one assessment only start the next clock once', async () => {
  const be = blobBackend({ latency: 4 });
  const first = await createBlobsStore({ blobsModule: be.module });
  const second = await createBlobsStore({ blobsModule: be.module });
  await first.insert('assessments', { id: 'asm', status: 'in_progress', quiz_state: { index: 0, question_started_at: 'first' } });
  const blob = be.module.getStore();
  const read = blob.getWithMetadata.bind(blob);
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => { release = resolve; });
  blob.getWithMetadata = async (name, opts) => {
    const value = await read(name, opts);
    if (name === 'assessments' && ++arrived <= 2) {
      if (arrived === 2) release();
      await both;
    }
    return value;
  };
  const transition = (name) => (row) => row?.quiz_state?.index === 0
    ? { quiz_state: { index: 1, question_started_at: name } } : undefined;
  const attempts = await Promise.all([
    first.changeRow('assessments', { id: 'asm' }, transition('first lock')),
    second.changeRow('assessments', { id: 'asm' }, transition('second lock')),
  ]);
  assert.deepEqual(attempts.map((a) => a.changed).sort(), [false, true]);
  const state = (await first.get('assessments', 'asm')).quiz_state;
  assert.equal(state.index, 1);
  assert.equal(state.question_started_at, attempts.find((a) => a.changed).row.quiz_state.question_started_at);
  assert.ok(be.stats.conflicts >= 1, 'the losing request re-evaluated its guard after the ETag conflict');
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

test('Lock & continue handles a draft inserted after its response read on another function instance', async () => {
  const be = blobBackend({ latency: 3 });
  const first = await createBlobsStore({ blobsModule: be.module });
  const second = await createBlobsStore({ blobsModule: be.module });
  const { role, assessor, cands } = await seedWorld(first);
  const app1 = await createApp(first);
  const app2 = await createApp(second);
  const call = (app, method, path, token, body) => app({ method, path, body, headers: { authorization: `Bearer ${token}` } });
  const admin = (await app1({ method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'admin-pass-x' } })).body.token;
  const alloc = await call(app1, 'POST', '/admin/assessments', admin,
    { candidate_id: cands[0].id, role_id: role.id, assessor_id: assessor.id });
  assert.equal(alloc.status, 201);
  const id = alloc.body.id;
  const token = (await app1({ method: 'POST', path: '/auth/login', body: { username: 'one', password: 'one-pass-x' } })).body.token;
  const open = await call(app1, 'GET', `/candidate/assessments/${id}`, token);
  assert.equal(open.status, 200);
  const qid = open.body.current_question.id;

  // Simulate /next having read a response snapshot before the autosave on
  // another function instance inserted the deterministic <paper>/<question>
  // id. The real per-process mutex cannot cover both Netlify instances. An
  // insert based on that snapshot would throw DUPLICATE_ID (409) mid-exam.
  const draft = await call(app1, 'PUT', `/candidate/assessments/${id}/answers`, token, { answers: { [qid]: 'a' } });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const list = second.list.bind(second);
  let snapshotDelivered = false;
  second.list = (table, filter, opts) => {
    if (table === 'responses' && filter?.assessment_id === id && !snapshotDelivered) {
      snapshotDelivered = true;
      return Promise.resolve([]);
    }
    return list(table, filter, opts);
  };
  const next = await call(app2, 'POST', `/candidate/assessments/${id}/next`, token, { question_id: qid, answer: 'b' });
  assert.equal(snapshotDelivered, true, 'the advance planned its write from the pre-draft snapshot');
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.index, 1);
  const rows = await first.list('responses', { assessment_id: id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].locked, true);
  assert.equal(rows[0].answer, 'b', 'the lock, not the racing draft, determines the final answer');
  assert.equal((await first.get('assessments', id)).quiz_state.index, 1);

  // If the lock itself carries no answer, the draft saved in time must win,
  // even when it appeared after this instance's response snapshot.
  const q2 = (await call(app1, 'GET', `/candidate/assessments/${id}`, token)).body.current_question.id;
  await call(app1, 'PUT', `/candidate/assessments/${id}/answers`, token, { answers: { [q2]: 'b' } });
  snapshotDelivered = false;
  const blankLock = await call(app2, 'POST', `/candidate/assessments/${id}/next`, token, { question_id: q2, answer: null });
  assert.equal(blankLock.status, 200, JSON.stringify(blankLock.body));
  assert.equal(blankLock.body.index, 2);
  const savedDraft = await first.get('responses', `${id}/${q2}`);
  assert.equal(savedDraft.answer, 'b', 'the newest draft is locked instead of a blank');
  assert.equal(savedDraft.locked, true);
});

test('a duplicate Lock & continue cannot restart the next question’s clock or erase integrity events', async () => {
  const be = blobBackend({ latency: 2 });
  const first = await createBlobsStore({ blobsModule: be.module });
  const second = await createBlobsStore({ blobsModule: be.module });
  const { role, assessor, cands } = await seedWorld(first);
  const app1 = await createApp(first);
  const app2 = await createApp(second);
  const call = (app, method, path, token, body) => app({ method, path, body, headers: { authorization: `Bearer ${token}` } });
  const admin = (await app1({ method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'admin-pass-x' } })).body.token;
  const alloc = await call(app1, 'POST', '/admin/assessments', admin,
    { candidate_id: cands[0].id, role_id: role.id, assessor_id: assessor.id });
  const id = alloc.body.id;
  const token = (await app1({ method: 'POST', path: '/auth/login', body: { username: 'one', password: 'one-pass-x' } })).body.token;
  const open = await call(app1, 'GET', `/candidate/assessments/${id}`, token);
  const qid = open.body.current_question.id;
  const before = await second.get('assessments', id);
  await call(app1, 'POST', `/candidate/assessments/${id}/integrity`, token, { event: 'copy', detail: 'blocked' });
  const firstLock = await call(app1, 'POST', `/candidate/assessments/${id}/next`, token, { question_id: qid, answer: 'b' });
  assert.equal(firstLock.status, 200);
  const advanced = (await first.get('assessments', id)).quiz_state;
  assert.equal(advanced.integrity.copy, 1);

  // The other function started while this question was live. The response is
  // already locked and the cursor is already advanced by the time it finishes.
  const get = second.get.bind(second);
  second.get = (table, recordId) => table === 'assessments' && recordId === id
    ? Promise.resolve(before) : get(table, recordId);
  const duplicate = await call(app2, 'POST', `/candidate/assessments/${id}/next`, token,
    { question_id: qid, answer: 'a' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.index, 1);
  assert.equal((await first.get('responses', `${id}/${qid}`)).answer, 'b');
  const after = (await first.get('assessments', id)).quiz_state;
  assert.equal(after.question_started_at, advanced.question_started_at, 'the new question keeps its original deadline');
  assert.equal(after.integrity.copy, 1);
  assert.equal(after.events.filter((e) => e.event === 'copy').length, 1);
});

test('two instances CAS a draft and a lock for the same question: one locked row, no 409 or late overwrite', async () => {
  const be = blobBackend({ latency: 3 });
  const first = await createBlobsStore({ blobsModule: be.module });
  const second = await createBlobsStore({ blobsModule: be.module });
  const key = { assessment_id: 'asm', question_id: 'q1' };
  // Both changeRow calls see the shard before either writes. The losing CAS
  // must rerun its decision using the winner's row, not retry an insert of
  // the same natural id or apply a stale draft over a locked answer.
  const blob = be.module.getStore();
  const read = blob.getWithMetadata.bind(blob);
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => { release = resolve; });
  blob.getWithMetadata = async (name, opts) => {
    const value = await read(name, opts);
    if (name === 'shards/responses/asm' && ++arrived <= 2) {
      if (arrived === 2) release();
      await both;
    }
    return value;
  };
  const draft = (row) => row?.locked ? undefined : { answer: 'draft' };
  const lock = (row) => row?.locked ? undefined : { answer: 'final', locked: true };
  await Promise.all([
    first.changeRow('responses', key, draft),
    second.changeRow('responses', key, lock),
  ]);
  const rows = await first.list('responses', { assessment_id: 'asm' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'asm/q1');
  assert.equal(rows[0].answer, 'final');
  assert.equal(rows[0].locked, true);
  assert.ok(be.stats.conflicts >= 1, 'a refused ETag write was retried against the winning row');
  const late = await first.changeRow('responses', key, draft);
  assert.equal(late.changed, false, 'a delayed autosave cannot change a locked answer');
  assert.equal((await second.get('responses', 'asm/q1')).answer, 'final');
});

test('an autosave delayed until after the lock cannot change that answer, even with a stale exam snapshot', async () => {
  const be = blobBackend({ latency: 2 });
  const first = await createBlobsStore({ blobsModule: be.module });
  const second = await createBlobsStore({ blobsModule: be.module });
  const { role, assessor, cands } = await seedWorld(first);
  const app1 = await createApp(first);
  const app2 = await createApp(second);
  const call = (app, method, path, token, body) => app({ method, path, body, headers: { authorization: `Bearer ${token}` } });
  const admin = (await app1({ method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'admin-pass-x' } })).body.token;
  const alloc = await call(app1, 'POST', '/admin/assessments', admin,
    { candidate_id: cands[0].id, role_id: role.id, assessor_id: assessor.id });
  const id = alloc.body.id;
  const token = (await app1({ method: 'POST', path: '/auth/login', body: { username: 'one', password: 'one-pass-x' } })).body.token;
  const open = await call(app1, 'GET', `/candidate/assessments/${id}`, token);
  const qid = open.body.current_question.id;
  await call(app1, 'PUT', `/candidate/assessments/${id}/answers`, token, { answers: { [qid]: 'a' } });
  const oldAssessment = await second.get('assessments', id);
  const oldResponse = (await second.list('responses', { assessment_id: id }))[0];
  const next = await call(app1, 'POST', `/candidate/assessments/${id}/next`, token,
    { question_id: qid, answer: 'b' });
  assert.equal(next.status, 200);

  // The old PUT has been in flight on instance two. Before the fix a stale
  // response list would lead it to UPDATE the row blindly, replacing the
  // locked 'b' with 'a' while keeping locked=true (and grading the wrong answer).
  const get = second.get.bind(second);
  second.get = (table, recordId) => table === 'assessments' && recordId === id
    ? Promise.resolve(oldAssessment) : get(table, recordId);
  const list = second.list.bind(second);
  second.list = (table, filter, opts) => table === 'responses' && filter?.assessment_id === id
    ? Promise.resolve([oldResponse]) : list(table, filter, opts);
  const late = await call(app2, 'PUT', `/candidate/assessments/${id}/answers`, token, { answers: { [qid]: 'a' } });
  assert.equal(late.status, 200);
  assert.deepEqual(late.body.accepted_question_ids, []);
  assert.deepEqual(late.body.ignored_question_ids, [qid]);
  assert.equal((await first.get('responses', `${id}/${qid}`)).answer, 'b');
  assert.equal((await first.get('assessments', id)).quiz_state.index, 1);
});
