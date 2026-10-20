import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-integrity-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'db.json') };
}

test('a corrupt or malformed JSON database never starts as an empty writable store', (t) => {
  const { file } = fixture(t);
  for (const raw of ['{"tables":', 'null', '[]', '{"tables":[]}', '{"tables":{"users":[]}}', '{"tables":{"users":{"u1":null}}}']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => createJsonStore(file), { code: 'STORE_CORRUPT' }, raw);
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'the original file is preserved');
  }
});

test('a malformed response shard refuses reads and writes without replacing saved evidence', async (t) => {
  const { file } = fixture(t); const store = createJsonStore(file);
  await store.insert('responses', { assessment_id: 'paper', question_id: 'q1', answer: 'saved' });
  const shard = path.join(file.replace(/\.json$/, '.rows'), 'shards', 'responses', 'paper.json');
  const original = fs.readFileSync(shard, 'utf8');
  for (const corrupt of [original.slice(0, -2), 'null', '[]', '{"paper/q1":null}']) {
    fs.writeFileSync(shard, corrupt);
    await assert.rejects(store.list('responses', { assessment_id: 'paper' }), { code: 'STORE_CORRUPT' });
    await assert.rejects(store.insert('responses', { assessment_id: 'paper', question_id: 'q2', answer: 'new' }), { code: 'STORE_CORRUPT' });
    assert.equal(fs.readFileSync(shard, 'utf8'), corrupt);
  }
  fs.writeFileSync(shard, original);
  assert.equal((await store.list('responses', { assessment_id: 'paper' }))[0].answer, 'saved');
});

test('a malformed recording refuses overwrite rather than masquerading as missing audio', async (t) => {
  const { file } = fixture(t); const store = createJsonStore(file);
  const row = await store.insert('recordings', { assessment_id: 'paper', question_id: 'q1', audio: { b64: 'YXVkaW8=' } });
  const recording = path.join(file.replace(/\.json$/, '.rows'), 'rows', 'recordings', row.id + '.json');
  const corrupt = '{broken'; fs.writeFileSync(recording, corrupt);
  await assert.rejects(store.get('recordings', row.id), { code: 'STORE_CORRUPT' });
  await assert.rejects(store.update('recordings', row.id, { audio: { b64: 'bmV3' } }), { code: 'STORE_CORRUPT' });
  assert.equal(fs.readFileSync(recording, 'utf8'), corrupt);
});
