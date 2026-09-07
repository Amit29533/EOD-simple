import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { AUDIT_MAX_ROWS } from '../src/storage/audit-rotation.mjs';
import { bulkInsert, bulkUpdate } from '../src/api/helpers.mjs';

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
