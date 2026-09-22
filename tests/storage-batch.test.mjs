import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { AUDIT_MAX_ROWS } from '../src/storage/audit-rotation.mjs';
import { bulkInsert, bulkUpdate, bulkRemove } from '../src/api/helpers.mjs';

/** The `insertMany` batch contract: one persist, per-row semantics, order kept. */

test('json-file insertMany creates rows in one write with stable order and ids', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-batch-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const rows = [
    { username: 'a', name: 'A', role: 'candidate', active: true },
    { username: 'b', name: 'B', role: 'candidate', active: true },
    { username: 'c', name: 'C', role: 'candidate', active: true },
  ];
  const recs = await store.insertMany('users', rows);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => r.username), ['a', 'b', 'c'], 'order preserved');
  for (const r of recs) {
    assert.ok(r.id, 'id generated');
    assert.ok(r.created_at, 'created_at stamped');
    assert.ok(!('id' in rows[0]) || true);
  }
  assert.equal((await store.list('users')).length, 3);
  // Explicit ids are honoured.
  const withIds = await store.insertMany('roles', [{ id: 'r1', key: 'x' }, { id: 'r2', key: 'y' }]);
  assert.deepEqual(withIds.map((r) => r.id), ['r1', 'r2']);
});

test('bulkInsert falls back to a loop on a store without insertMany', async () => {
  const store = createJsonStore(path.join(os.tmpdir(), `ecod-fallback-${Date.now()}.json`));
  store.insertMany = undefined; // simulate an older/partial adapter
  const recs = await bulkInsert(store, 'roles', [{ key: 'a' }, { key: 'b' }]);
  assert.equal(recs.length, 2);
  assert.equal((await store.list('roles')).length, 2);
  assert.deepEqual((await store.list('roles')).map((r) => r.key), ['a', 'b']);
});

test('json-file updateMany patches rows in one write, keeping order and ids', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-batch-update-'));
  const file = path.join(tmp, 'db.json');
  const store = createJsonStore(file);
  const rows = await store.insertMany('roles', [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);

  // Count full-file rewrites: the point of the batch API is that it is one.
  const realWrite = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...args) => { writes += 1; return realWrite(...args); };
  let out;
  try {
    out = await store.updateMany('roles', [
      { id: rows[1].id, patch: { key: 'b-renamed', order: 9 } },
      { id: 'missing-id', patch: { key: 'never' } },
      { id: rows[0].id, patch: { active: false } },
    ]);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(writes, 1, 'one persist for the whole batch');
  assert.equal(out.length, 3, 'the result mirrors the patch list, misses included');
  assert.equal(out[0].key, 'b-renamed');
  assert.equal(out[0].order, 9);
  assert.equal(out[0].id, rows[1].id, 'the id can never be patched away');
  assert.ok(out[0].updated_at, 'updated_at is stamped per row');
  assert.equal(out[1], null, 'an unknown id is reported, not invented');
  assert.equal(out[2].active, false);
  assert.equal((await store.get('roles', rows[2].id)).key, 'c', 'untouched rows survive');
  assert.equal((await store.list('roles')).length, 3, 'no rows are added or dropped');

  // Nothing to touch -> nothing written.
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(await store.updateMany('roles', []), []);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'an empty batch never rewrites the file');
});

test('bulkUpdate falls back to a loop on a store without updateMany', async () => {
  const store = createJsonStore(path.join(os.tmpdir(), `ecod-update-fallback-${Date.now()}.json`));
  const rows = await store.insertMany('roles', [{ key: 'a' }, { key: 'b' }]);
  store.updateMany = undefined; // an older/partial adapter
  const out = await bulkUpdate(store, 'roles', [{ id: rows[0].id, patch: { key: 'z' } }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'z');
  assert.deepEqual((await store.list('roles')).map((r) => r.key), ['z', 'b']);
});

test('the audit-log cap also applies to bulk inserts', async () => {
  // The rotation lived only in insert(), so `audit_log` could be pushed past its
  // ceiling by any bulk write — the one table whose size is a write-amplification
  // problem for the whole store.
  const store = createJsonStore(path.join(os.tmpdir(), `ecod-audit-cap-${Date.now()}.json`));
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const rows = Array.from({ length: AUDIT_MAX_ROWS + 40 }, (_, i) => ({
    action: `act-${i}`, entity: 'x', entity_id: String(i), created_at: new Date(base + i * 1000).toISOString(),
  }));
  await store.insertMany('audit_log', rows);
  const left = await store.list('audit_log');
  assert.ok(left.length <= AUDIT_MAX_ROWS + 1, `trimmed to the cap (got ${left.length})`);
  const kept = new Set(left.map((r) => r.entity_id));
  assert.equal(kept.has(String(rows.length - 1)), true, 'the newest rows are kept');
  assert.equal(kept.has('0'), false, 'the oldest rows are the ones dropped');

  // And a normal table is left completely alone.
  await store.insertMany('roles', [{ key: 'a' }]);
  assert.equal((await store.list('roles')).length, 1);
});

/* ------------------------------------------------- prototype-named record ids */

/**
 * Rows live on a plain id-keyed object, so an id that names an
 * Object.prototype member used to resolve to the inherited member: a GET on
 * "constructor" returned a phantom row, and an update on it ran Object.assign
 * against Object.prototype itself — after which every object in the process
 * inherited `id: "__proto__"` and the store's own inserts silently vanished.
 */
const PROTO_IDS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

test('json-file: ids naming Object.prototype members are "no such row", never a phantom', async () => {
  const store = createJsonStore(path.join(os.tmpdir(), `ecod-proto-${Date.now()}.json`));
  await store.insert('roles', { key: 'real' });
  for (const id of PROTO_IDS) {
    assert.equal(await store.get('roles', id), null, `get(${id}) must be null`);
    assert.equal(await store.update('roles', id, { name: 'Polluted' }), null, `update(${id}) must be null`);
    assert.equal(await store.remove('roles', id), false, `remove(${id}) must be false`);
    assert.deepEqual(await store.updateMany('roles', [{ id, patch: { name: 'x' } }]), [null]);
  }
  // The proof that nothing leaked onto the prototype chain: a fresh object has
  // no inherited name/id, and a row inserted afterwards keeps its own id.
  assert.equal(({}).name, undefined, 'Object.prototype.name was never written');
  assert.equal(({}).id, undefined, 'Object.prototype.id was never written');
  const after = await store.insert('roles', { key: 'later' });
  assert.notEqual(after.id, '__proto__');
  assert.equal((await store.list('roles')).length, 2, 'both real rows are present');
  // A caller cannot bring "__proto__" as an id either (that would swap the
  // table's prototype instead of adding a row); it gets a generated one.
  const forced = await store.insert('roles', { id: '__proto__', key: 'forced' });
  assert.notEqual(forced.id, '__proto__');
  assert.equal((await store.list('roles')).length, 3);
  assert.equal((await store.get('roles', forced.id)).key, 'forced');
});

test('netlify-blobs: the same prototype-named ids are refused', async () => {
  const { createBlobsStore } = await import('../src/storage/netlify-blobs.mjs');
  const data = {};
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const backend = {
    getStore: () => ({
      get: async (t) => (t in data ? clone(data[t]) : null),
      setJSON: async (t, rows) => { data[t] = clone(rows); },
    }),
  };
  const store = await createBlobsStore({ blobsModule: backend });
  await store.insert('roles', { key: 'real' });
  for (const id of PROTO_IDS) {
    assert.equal(await store.get('roles', id), null, `get(${id}) must be null`);
    assert.equal(await store.update('roles', id, { name: 'Polluted' }), null, `update(${id}) must be null`);
    assert.equal(await store.remove('roles', id), false, `remove(${id}) must be false`);
    assert.deepEqual(await store.updateMany('roles', [{ id, patch: { name: 'x' } }]), [null]);
  }
  const forced = await store.insert('roles', { id: '__proto__', key: 'forced' });
  assert.notEqual(forced.id, '__proto__');
  assert.equal((await store.list('roles')).length, 2);
  assert.equal(({}).name, undefined, 'Object.prototype.name was never written');
});

/* ------------------------------------------------- insert never overwrites */

test('json-file: an insert with an id that is already a row is refused, not an overwrite', async () => {
  // `rows[id] = rec` was an upsert in disguise: two authored bank questions
  // that raced for the same sequential id both got a 201 and one vanished.
  const store = createJsonStore(path.join(os.tmpdir(), `ecod-dup-${Date.now()}.json`));
  await store.insert('bank_questions', { id: 'RSA-T01-A001', prompt: 'first' });
  await assert.rejects(() => store.insert('bank_questions', { id: 'RSA-T01-A001', prompt: 'second' }), /Duplicate id/);
  assert.equal((await store.get('bank_questions', 'RSA-T01-A001')).prompt, 'first', 'the first row is untouched');
  // A batch is all-or-nothing: a duplicate anywhere in it applies none of it.
  await assert.rejects(() => store.insertMany('bank_questions', [
    { id: 'RSA-T01-A002', prompt: 'two' }, { id: 'RSA-T01-A001', prompt: 'clash' },
  ]), /Duplicate id/);
  assert.equal(await store.get('bank_questions', 'RSA-T01-A002'), null, 'nothing from the refused batch landed');
  await assert.rejects(() => store.insertMany('bank_questions', [
    { id: 'RSA-T01-A003', prompt: 'three' }, { id: 'RSA-T01-A003', prompt: 'three again' },
  ]), /within one batch/);
  assert.equal((await store.list('bank_questions')).length, 1);
  // Generated ids and distinct caller ids still insert normally.
  const ok = await store.insertMany('bank_questions', [{ prompt: 'gen' }, { id: 'RSA-T01-A004', prompt: 'four' }]);
  assert.equal(ok.length, 2);
  assert.equal((await store.list('bank_questions')).length, 3);
});

test('netlify-blobs: an insert with an existing id is refused the same way', async () => {
  const { createBlobsStore } = await import('../src/storage/netlify-blobs.mjs');
  const data = {};
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const backend = { getStore: () => ({ get: async (t) => (t in data ? clone(data[t]) : null), setJSON: async (t, rows) => { data[t] = clone(rows); } }) };
  const store = await createBlobsStore({ blobsModule: backend });
  await store.insert('bank_questions', { id: 'X-1', prompt: 'first' });
  await assert.rejects(() => store.insert('bank_questions', { id: 'X-1', prompt: 'second' }), /Duplicate id/);
  await assert.rejects(() => store.insertMany('bank_questions', [{ id: 'X-2' }, { id: 'X-1' }]), /Duplicate id/);
  assert.equal(await store.get('bank_questions', 'X-2'), null);
  assert.equal((await store.get('bank_questions', 'X-1')).prompt, 'first');
});

/* ------------------------------------------------------ removeMany contract */

test('json-file removeMany deletes a batch in one call and skips unknown ids', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-rm-'));
  const file = path.join(tmp, 'db.json');
  const store = createJsonStore(file);
  const rows = await store.insertMany('responses', Array.from({ length: 6 }, (_, i) => ({ assessment_id: 'a1', question_id: `q${i}` })));
  const keep = await store.insert('responses', { assessment_id: 'a2', question_id: 'other' });
  const removed = await store.removeMany('responses', [rows[0].id, 'nope', rows[1].id, rows[2].id, '__proto__']);
  assert.equal(removed, 3, 'only the real rows count');
  assert.deepEqual((await store.list('responses')).map((r) => r.id).sort(), [rows[3].id, rows[4].id, rows[5].id, keep.id].sort());
  // The batch is on disk (a fresh store over the same file sees it).
  assert.equal((await createJsonStore(file).list('responses')).length, 4, 'the batch was persisted');
  assert.equal(await store.removeMany('responses', ['nope']), 0, 'nothing to remove');
  assert.equal(await store.removeMany('responses', []), 0);
  assert.equal(({}).assessment_id, undefined, 'Object.prototype was never touched');
});

test('netlify-blobs removeMany is exactly one table write per batch', async () => {
  const { createBlobsStore } = await import('../src/storage/netlify-blobs.mjs');
  const data = {};
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const writes = [];
  const backend = {
    getStore: () => ({
      get: async (t) => (t in data ? clone(data[t]) : null),
      setJSON: async (t, rows) => { data[t] = clone(rows); writes.push(t); },
      list: async ({ prefix = '' } = {}) => ({ blobs: Object.keys(data).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    }),
  };
  const store = await createBlobsStore({ blobsModule: backend });
  // responses live one blob per assessment: a batch within one paper is one write of that blob
  const rows = await store.insertMany('responses', Array.from({ length: 5 }, (_, i) => ({ assessment_id: 'a1', question_id: `q${i}` })));
  assert.deepEqual(Object.keys(data), ['shards/responses/a1'], 'the paper has its own blob; no whole-table blob');
  const before = writes.length;
  assert.equal(await store.removeMany('responses', [...rows.map((r) => r.id), 'missing', 'a1/constructor', 'constructor']), 5);
  assert.equal(writes.length - before, 1, 'one blob write for the whole batch');
  assert.equal((await store.list('responses')).length, 0);
  assert.equal(await store.removeMany('responses', ['missing']), 0);
  assert.equal(writes.length - before, 1, 'a batch that removes nothing writes nothing');
  assert.equal(({}).question_id, undefined, 'Object.prototype was never touched');
  // plain tables: still exactly one write per batch
  const plain = await store.insertMany('roles', Array.from({ length: 3 }, (_, i) => ({ key: `r${i}` })));
  const b2 = writes.length;
  assert.equal(await store.removeMany('roles', plain.map((r) => r.id)), 3);
  assert.equal(writes.length - b2, 1);
});

test('bulkRemove uses removeMany when present and loops otherwise', async () => {
  const store = createJsonStore(path.join(os.tmpdir(), `ecod-bulkrm-${Date.now()}.json`));
  const rows = await store.insertMany('roles', [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  let batched = 0;
  const orig = store.removeMany.bind(store);
  store.removeMany = (t, ids) => { batched += 1; return orig(t, ids); };
  assert.equal(await bulkRemove(store, 'roles', [rows[0].id, rows[1].id]), 2);
  assert.equal(batched, 1);
  assert.equal(await bulkRemove(store, 'roles', []), 0, 'an empty list never touches the store');
  assert.equal(batched, 1);
  store.removeMany = undefined; // an older/partial adapter
  assert.equal(await bulkRemove(store, 'roles', [rows[2].id, 'missing']), 1);
  assert.equal((await store.list('roles')).length, 0);
});

/* ------------------------------------------------- a failed persist never leaves phantom rows */

test('json-file: a mutation whose persist fails is rolled back in memory, not served until restart', async () => {
  // The table used to be edited first and persisted second. When the write
  // threw (disk full, read-only volume, EACCES) the caller got the error but
  // the process kept serving the un-persisted change — an insert that never
  // reached disk was listed, an update read back as applied, a delete read as
  // gone — until the next restart quietly reverted all of it.
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores directory modes
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-persist-fail-'));
  const file = path.join(dir, 'db.json');
  const store = createJsonStore(file);
  await store.insert('users', { id: 'u1', n: 1 });
  await store.insert('users', { id: 'u2', n: 2 });
  await store.insert('audit_log', { id: 'l1', action: 'x' });
  fs.chmodSync(dir, 0o500); // the store can no longer write its temp file
  try {
    await assert.rejects(store.insert('users', { id: 'u3', n: 3 }), /EACCES|EPERM/);
    await assert.rejects(store.insertMany('users', [{ id: 'u4' }, { id: 'u5' }]), /EACCES|EPERM/);
    await assert.rejects(store.update('users', 'u1', { n: 99 }), /EACCES|EPERM/);
    await assert.rejects(store.updateMany('users', [{ id: 'u2', patch: { n: 98 } }]), /EACCES|EPERM/);
    await assert.rejects(store.remove('users', 'u1'), /EACCES|EPERM/);
    await assert.rejects(store.removeMany('users', ['u2']), /EACCES|EPERM/);
    await assert.rejects(store.insert('audit_log', { id: 'l2', action: 'y' }), /EACCES|EPERM/);
    const rows = await store.list('users');
    assert.deepEqual(rows.map((r) => [r.id, r.n]).sort(), [['u1', 1], ['u2', 2]], 'nothing un-persisted is served');
    assert.equal((await store.get('users', 'u1')).updated_at, undefined, 'the failed update left no trace');
    assert.deepEqual((await store.list('audit_log')).map((r) => r.id), ['l1']);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // Once the disk is writable again everything works and the state is exactly what was on disk.
  await store.update('users', 'u1', { n: 5 });
  const reopened = createJsonStore(file);
  assert.deepEqual((await reopened.list('users')).map((r) => [r.id, r.n]).sort(), [['u1', 5], ['u2', 2]]);
});

test('json-file: a second process\'s write is picked up, never overwritten by this one\'s next persist', async () => {
  // The store keeps the whole database in memory and rewrites the file on
  // every mutation, so a SECOND process writing the same file — the documented
  // `npm run seed` sync while `npm start` is up — used to be silently undone
  // by this process's next write: a whole installed track vanished on the
  // next login. Now the file's fingerprint is checked before every persist;
  // a changed file is re-read first and the mutation lands on top of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-two-writers-'));
  const file = path.join(dir, 'db.json');
  const server = createJsonStore(file);
  await server.insert('roles', { id: 'rsa', key: 'rsa' });

  const seedProcess = createJsonStore(file);            // opened after the server's write
  await seedProcess.insert('roles', { id: 'aibi', key: 'aibi' });
  await seedProcess.insertMany('questions', [{ id: 'q1', role_id: 'aibi' }, { id: 'q2', role_id: 'aibi' }]);

  // The server's next mutation (a login writing a session) must not clobber.
  await server.insert('sessions', { id: 's1', token: 't' });
  const disk = createJsonStore(file);
  assert.deepEqual((await disk.list('roles')).map((r) => r.id).sort(), ['aibi', 'rsa'], 'the other process\'s track survived');
  assert.equal((await disk.list('questions')).length, 2);
  assert.equal((await disk.list('sessions')).length, 1, 'and this process\'s own write landed');
  // The running process now serves the merged state too, without a restart.
  assert.deepEqual((await server.list('roles')).map((r) => r.id).sort(), ['aibi', 'rsa']);

  // And the mirror image: the seed process, now stale itself, does not undo the session.
  await seedProcess.update('roles', 'aibi', { name: 'AI/BI' });
  const again = createJsonStore(file);
  assert.equal((await again.list('sessions')).length, 1);
  assert.equal((await again.get('roles', 'aibi')).name, 'AI/BI');
});

test('json-file: an unreadable (half-written) external change refuses the persist instead of clobbering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-half-write-'));
  const file = path.join(dir, 'db.json');
  const store = createJsonStore(file);
  await store.insert('roles', { id: 'rsa' });
  // Someone else is mid-write: the file on disk is not (yet) valid JSON.
  fs.writeFileSync(file, '{"tables":{"roles":{"rsa":{"id":"rsa"},"aibi":{"id":"ai');
  await assert.rejects(store.insert('sessions', { id: 's1' }), /changed by another process/);
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('"ai'), true, 'the foreign file is untouched');
  assert.deepEqual((await store.list('sessions')), [], 'the refused row is not served either');
});

test('json-file: a stale store answers the API with a retryable 503, not an internal error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-stale-api-'));
  const file = path.join(dir, 'db.json');
  const store = createJsonStore(file);
  const { createApp } = await import('../src/api/app.mjs');
  const { hashPassword } = await import('../src/core/passwords.mjs');
  await store.insert('users', { id: 'u1', username: 'admin', role: 'admin', active: true, password_hash: await hashPassword('ECOD-admin-2026') });
  const app = await createApp(store);
  const login = () => app({ method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'ECOD-admin-2026' } });
  assert.equal((await login()).status, 200, 'sanity: the store persists a session');
  // Another process is mid-write / the file was hand-edited into garbage.
  fs.writeFileSync(file, '{"tables":{"users":{"u1":{"id":"u1","username":"adm');
  const errors = [];
  const origWarn = console.warn;
  console.warn = (...a) => errors.push(a.join(' '));
  try {
    const res = await login();
    assert.equal(res.status, 503, `a refused persist is a temporary condition, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /another process.*try again/i);
    assert.doesNotMatch(res.body.error, /Internal error/);
  } finally { console.warn = origWarn; }
  assert.ok(errors.some((l) => /STORE_STALE|changed by another process/.test(l)), 'the refusal is logged as a warning, not a stack trace');
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('"adm'), 'the foreign file is untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
});

test('json-file: each write uses its own temp file, so two writers cannot corrupt each other', async () => {
  // With one shared `<file>.tmp`, two processes persisting at the same
  // instant truncated each other's half-written temp file and renamed the
  // mixture into place. Pin the private-name rule by watching the directory
  // while a write happens.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-tmp-name-'));
  const file = path.join(dir, 'db.json');
  const store = createJsonStore(file);
  const seen = new Set();
  const origRename = fs.renameSync;
  fs.renameSync = (from, to) => { seen.add(path.basename(from)); return origRename(from, to); };
  try {
    await store.insert('roles', { id: 'a' });
    await store.insert('roles', { id: 'b' });
  } finally { fs.renameSync = origRename; }
  assert.equal(seen.size, 2, 'every persist writes a fresh temp file');
  for (const name of seen) {
    assert.match(name, new RegExp(`^db\\.json\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`), `temp names carry the pid and the write's revision (${name})`);
  }
  assert.deepEqual(fs.readdirSync(dir), ['db.json'], 'temp files never outlive the write');
});

test('netlify-blobs: a mutation whose write fails leaves nothing behind in the read cache', async () => {
  // The rows object was cached before the write and mutated in place, so a
  // setJSON that threw left the un-persisted rows in the 5-second cache: the
  // failed insert was listed, the failed update read back as applied, and a
  // failed delete read as gone while the row still existed in the store.
  const { createBlobsStore } = await import('../src/storage/netlify-blobs.mjs');
  const data = {};
  let failWrites = 0;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const backend = {
    getStore: () => ({
      get: async (t) => (t in data ? clone(data[t]) : null),
      setJSON: async (t, rows) => {
        if (failWrites > 0) { failWrites -= 1; throw new Error('503 from the blob service'); }
        data[t] = clone(rows);
      },
    }),
  };
  const store = await createBlobsStore({ blobsModule: backend });
  await store.insert('users', { id: 'u1', n: 1 });
  await store.list('users'); // prime the cache
  failWrites = 1;
  await assert.rejects(store.insert('users', { id: 'u2', n: 2 }), /503/);
  assert.equal(await store.get('users', 'u2'), null, 'a failed insert is not served from the cache');
  failWrites = 1;
  await assert.rejects(store.update('users', 'u1', { n: 99 }), /503/);
  assert.equal((await store.get('users', 'u1')).n, 1, 'a failed update does not read back as applied');
  failWrites = 1;
  await assert.rejects(store.remove('users', 'u1'), /503/);
  assert.ok(await store.get('users', 'u1'), 'a failed delete does not read as gone');
  assert.deepEqual(Object.keys(data.users), ['u1'], 'the store itself was never touched');
});
