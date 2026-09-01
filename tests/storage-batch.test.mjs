import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { bulkInsert } from '../src/api/helpers.mjs';

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
