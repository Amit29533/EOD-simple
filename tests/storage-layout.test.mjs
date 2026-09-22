import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createBlobsStore } from '../src/storage/netlify-blobs.mjs';
import { KEY_ROOTS, isDetachedMarker } from '../src/storage/row-tables.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { paperSummary, paperFacts } from '../src/api/assessment-service.mjs';

/**
 * Storage layout at scale (file and blob adapters).
 *
 * Both adapters kept every table as ONE object rewritten on every write. The
 * exam tables grew with every paper ever allocated — ~130 KB of frozen paper
 * and report per assessment row, ~37 KB of answers per paper — so an exam
 * step (a cursor change of a few bytes, one locked answer) read and rewrote
 * 8.7 MB at 100 papers and 26 MB at 300, all of it other candidates' data
 * (220 ms / 735 ms per step against the real SDK on localhost, before any
 * network). The paper and the report now live in their own objects
 * (`columns/assessments/<id>/<column>`), the answers one object per
 * assessment (`shards/responses/<assessment>`), and the assessments table
 * object holds the small rows only: a step at 300 papers moves ~150 KB.
 */

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-layout-')), 'db.json');
const paper = (n = 2) => ({
  role: { id: 'r1', name: 'RSA' },
  framework: {}, competencies: [],
  questions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, prompt: `Q${i + 1} ${'x'.repeat(500)}`, points: i + 2, type: 'mcq_single' })),
  question_limit: null, bank_total: n,
});

/** In-memory Netlify Blobs with ETags and conditional writes (production semantics). */
function blobBackend() {
  const data = new Map();
  const reads = [];
  let n = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const store = {
    async get(key) { reads.push(key); return data.has(key) ? clone(data.get(key).json) : null; },
    async getWithMetadata(key) { reads.push(key); return data.has(key) ? { data: clone(data.get(key).json), etag: data.get(key).etag, metadata: {} } : null; },
    async setJSON(key, value, opts = {}) {
      const cur = data.get(key);
      if (opts.onlyIfNew && cur) return { modified: false };
      if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `"v${++n}"`;
      data.set(key, { json: clone(value), etag });
      return { modified: true, etag };
    },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
  return { data, reads, module: { getStore: () => store }, json: (k) => (data.has(k) ? clone(data.get(k).json) : null) };
}

/* --------------------------------------------------------------- json-file */

test('json-file: the paper, the report and the answers live outside the database file; the row keeps markers', async () => {
  const file = tmpFile();
  const store = createJsonStore(file);
  const a = await store.insert('assessments', { id: 'asm1', candidate_id: 'c1', status: 'assigned', snapshot_json: paper(), report_json: null, quiz_state: { index: 0 } });
  assert.deepEqual(a.snapshot_json, paper(), 'insert returns the full row');
  const rowsDir = file.replace(/\.json$/, '.rows');
  assert.ok(fs.existsSync(path.join(rowsDir, KEY_ROOTS.column, 'assessments', 'asm1', 'snapshot_json.json')), 'the paper has its own file');
  assert.ok(!fs.existsSync(path.join(rowsDir, KEY_ROOTS.column, 'assessments', 'asm1', 'report_json.json')), 'a null column is not detached');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).tables.assessments.asm1;
  assert.ok(isDetachedMarker(onDisk.snapshot_json), 'the database file holds a marker, not the paper');
  assert.equal(onDisk.report_json, null);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('xxxxxxxx'), 'no question text in the database file');

  // reads put it back
  assert.deepEqual((await store.get('assessments', 'asm1')).snapshot_json, paper());
  assert.deepEqual((await store.list('assessments', { candidate_id: 'c1' }))[0].snapshot_json, paper(), 'list attaches by default');
  const lean = await store.list('assessments', {}, { detached: false });
  assert.ok(isDetachedMarker(lean[0].snapshot_json), 'a listing can ask for the small columns only');
  assert.equal(lean[0].status, 'assigned');

  // a small update does not touch the paper file
  const paperFile = path.join(rowsDir, KEY_ROOTS.column, 'assessments', 'asm1', 'snapshot_json.json');
  const before = fs.statSync(paperFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const updated = await store.update('assessments', 'asm1', { quiz_state: { index: 1 } });
  assert.deepEqual(updated.snapshot_json, paper(), 'update returns the full row');
  assert.equal(updated.quiz_state.index, 1);
  assert.equal(fs.statSync(paperFile).mtimeMs, before, 'the paper was not rewritten for a cursor change');

  // the report is detached when it arrives
  await store.update('assessments', 'asm1', { status: 'scored', report_json: { overall_pct: 50 } });
  assert.ok(fs.existsSync(path.join(rowsDir, KEY_ROOTS.column, 'assessments', 'asm1', 'report_json.json')));
  assert.deepEqual((await store.get('assessments', 'asm1')).report_json, { overall_pct: 50 });

  // answers: one file per assessment, ids `<assessment>/<question>`
  const r1 = await store.insert('responses', { assessment_id: 'asm1', question_id: 'q1', answer: 'a' });
  const r2 = await store.insert('responses', { assessment_id: 'asm1', question_id: 'q2', answer: 'b' });
  assert.equal(r1.id, 'asm1/q1');
  const shardFile = path.join(rowsDir, KEY_ROOTS.shard, 'responses', 'asm1.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(shardFile, 'utf8'))).sort(), ['asm1/q1', 'asm1/q2']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tables.responses, undefined, 'no responses in the database file');
  assert.deepEqual((await store.list('responses', { assessment_id: 'asm1' })).map((r) => r.answer), ['a', 'b']);
  assert.deepEqual((await store.list('responses', { assessment_id: 'asm1', question_id: 'q2' })).map((r) => r.id), ['asm1/q2']);
  assert.equal((await store.get('responses', r2.id)).answer, 'b');
  assert.equal((await store.update('responses', r2.id, { locked: true })).locked, true);
  assert.deepEqual((await store.updateMany('responses', [{ id: r1.id, patch: { locked: true } }, { id: 'asm1/none', patch: {} }])).map((r) => r && r.locked), [true, null]);
  assert.equal((await store.list('responses')).length, 2, 'an unfiltered list scans the shards');
  await assert.rejects(store.insert('responses', { question_id: 'q9' }), (e) => e.code === 'MISSING_SHARD');
  await assert.rejects(store.insert('responses', { assessment_id: 'asm1', question_id: 'q1' }), (e) => e.code === 'DUPLICATE_ID');

  // deleting the row deletes its detached objects
  assert.equal(await store.remove('assessments', 'asm1'), true);
  assert.ok(!fs.existsSync(paperFile), 'the paper file is gone with the row');
  assert.equal(await store.removeMany('responses', [r1.id, r2.id, 'asm1/none']), 2);
  assert.deepEqual(await store.list('responses', { assessment_id: 'asm1' }), []);

  // a reopened store sees exactly the same
  const again = createJsonStore(file);
  assert.equal(await again.get('assessments', 'asm1'), null);
});

test('json-file: the database file no longer grows with the papers and answers', async () => {
  const file = tmpFile();
  const store = createJsonStore(file);
  const size = () => fs.statSync(file).size;
  await store.insert('assessments', { id: 'asm0', candidate_id: 'c0', status: 'assigned', snapshot_json: paper(40), report_json: null });
  const one = size();
  for (let i = 1; i <= 20; i += 1) {
    await store.insert('assessments', { id: `asm${i}`, candidate_id: `c${i}`, status: 'assigned', snapshot_json: paper(40), report_json: null });
    await store.insertMany('responses', Array.from({ length: 40 }, (_, k) => ({ assessment_id: `asm${i}`, question_id: `q${k + 1}`, answer: 'x'.repeat(200), locked: true })));
  }
  const growth = size() - one;
  assert.ok(growth < 20 * 600, `20 more papers with 40 answers each added ${growth} bytes to the database file (rows only)`);
  assert.ok(fs.statSync(path.join(file.replace(/\.json$/, '.rows'), KEY_ROOTS.column, 'assessments', 'asm7', 'snapshot_json.json')).size > 20_000);
});

test('json-file: a database written by the previous version (papers inline, answers in the file) is read as is and moved out on first use', async () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = {
    rev: 'abcdefabcdefabcdefabcdef',
    tables: {
      assessments: {
        asm1: { id: 'asm1', candidate_id: 'c1', status: 'in_progress', snapshot_json: paper(), report_json: null, quiz_state: { index: 1 }, created_at: '2026-01-01T00:00:00.000Z' },
        asm2: { id: 'asm2', candidate_id: 'c2', status: 'scored', snapshot_json: paper(3), report_json: { overall_pct: 70 }, created_at: '2026-01-02T00:00:00.000Z' },
      },
      responses: {
        rec_a: { id: 'rec_a', assessment_id: 'asm1', question_id: 'q1', answer: 'legacy-1', locked: true },
        rec_b: { id: 'rec_b', assessment_id: 'asm1', question_id: 'q2', answer: 'legacy-2', locked: true },
        rec_c: { id: 'rec_c', assessment_id: 'asm2', question_id: 'q1', answer: 'other paper', locked: true },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = createJsonStore(file);

  // the inline paper is served, before and without any write
  const a1 = await store.get('assessments', 'asm1');
  assert.deepEqual(a1.snapshot_json, paper());
  assert.deepEqual((await store.list('assessments', {}, { detached: false })).find((a) => a.id === 'asm2').report_json, { overall_pct: 70 }, 'an inline column is inline whichever way it is listed');

  // the answers of one paper move to their shard on first read, re-keyed by question
  const rows = await store.list('responses', { assessment_id: 'asm1' });
  assert.deepEqual(rows.map((r) => [r.id, r.answer]).sort(), [['asm1/q1', 'legacy-1'], ['asm1/q2', 'legacy-2']]);
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).tables;
  assert.deepEqual(Object.keys(onDisk().responses), ['rec_c'], "asm1's rows left the database file; the other paper's row waits for its own first read");
  assert.equal((await store.update('responses', 'asm1/q1', { answer: 'edited' })).answer, 'edited');
  assert.equal((await store.list('responses', { assessment_id: 'asm2' }))[0].answer, 'other paper');
  assert.deepEqual(onDisk().responses, {}, 'now empty');
  assert.equal((await store.list('responses')).length, 3);

  // the first update of a legacy row moves its paper out
  await store.update('assessments', 'asm1', { quiz_state: { index: 2 } });
  assert.ok(isDetachedMarker(onDisk().assessments.asm1.snapshot_json), 'moved out on the first write');
  assert.deepEqual((await store.get('assessments', 'asm1')).snapshot_json, paper(), 'and still read back whole');
  assert.deepEqual(onDisk().assessments.asm2.snapshot_json.questions.length, 3, 'a row that was never written keeps its inline paper');
});

/* ------------------------------------------------------------------ blobs */

test('netlify-blobs: one blob per paper, per report and per assessment of answers; the table blob holds small rows', async () => {
  const be = blobBackend();
  const store = await createBlobsStore({ blobsModule: be.module });
  await store.insert('assessments', { id: 'asm1', candidate_id: 'c1', status: 'assigned', snapshot_json: paper(), report_json: null });
  assert.deepEqual(be.json(`${KEY_ROOTS.column}/assessments/asm1/snapshot_json`), { value: paper() });
  assert.ok(isDetachedMarker(be.json('assessments').asm1.snapshot_json));
  assert.ok(!be.data.has(`${KEY_ROOTS.column}/assessments/asm1/report_json`));
  assert.deepEqual((await store.get('assessments', 'asm1')).snapshot_json, paper());

  // the paper is read once per instance, then served from memory (write-once)
  const paperReads = () => be.reads.filter((k) => k === `${KEY_ROOTS.column}/assessments/asm1/snapshot_json`).length;
  const n = paperReads();
  await store.get('assessments', 'asm1');
  await store.update('assessments', 'asm1', { quiz_state: { index: 1 } });
  await store.list('assessments', { candidate_id: 'c1' });
  assert.equal(paperReads(), n, 'no further paper reads on this instance');
  const other = await createBlobsStore({ blobsModule: be.module });
  assert.deepEqual((await other.get('assessments', 'asm1')).snapshot_json, paper(), 'another instance fetches it');
  assert.equal(paperReads(), n + 1);

  await store.insertMany('responses', [{ assessment_id: 'asm1', question_id: 'q1', answer: 'a' }, { assessment_id: 'asm1', question_id: 'q2', answer: 'b' }]);
  assert.deepEqual(Object.keys(be.json(`${KEY_ROOTS.shard}/responses/asm1`)).sort(), ['asm1/q1', 'asm1/q2']);
  assert.equal(be.json('responses'), null, 'no whole-table responses blob');
  assert.deepEqual((await other.list('responses', { assessment_id: 'asm1' })).map((r) => r.answer), ['a', 'b']);

  await store.update('assessments', 'asm1', { status: 'scored', report_json: { overall_pct: 80 } });
  assert.deepEqual(be.json(`${KEY_ROOTS.column}/assessments/asm1/report_json`), { value: { overall_pct: 80 } });
  assert.deepEqual((await other.get('assessments', 'asm1')).report_json, { overall_pct: 80 });

  assert.equal(await store.remove('assessments', 'asm1'), true);
  assert.ok(!be.data.has(`${KEY_ROOTS.column}/assessments/asm1/snapshot_json`), 'the paper blob is deleted with the row');
  assert.ok(!be.data.has(`${KEY_ROOTS.column}/assessments/asm1/report_json`));
  assert.equal(await store.removeMany('responses', ['asm1/q1', 'asm1/q2']), 2);
  assert.deepEqual(be.json(`${KEY_ROOTS.shard}/responses/asm1`), {}, 'an emptied shard is written back empty, never deleted (a delete cannot be conditional)');
});

test('netlify-blobs: two instances writing the same paper of answers (autosave and lock) keep both writes; legacy rows migrate under compare-and-swap', async () => {
  const be = blobBackend();
  // the whole-table blob a previous deploy left behind
  await be.module.getStore().setJSON('responses', {
    rec_a: { id: 'rec_a', assessment_id: 'asm1', question_id: 'q1', answer: 'legacy-1', locked: true },
    rec_z: { id: 'rec_z', assessment_id: 'asm9', question_id: 'q1', answer: 'someone else', locked: true },
  });
  const inst1 = await createBlobsStore({ blobsModule: be.module });
  const inst2 = await createBlobsStore({ blobsModule: be.module });
  const rows = await inst1.list('responses', { assessment_id: 'asm1' });
  assert.deepEqual(rows.map((r) => [r.id, r.answer]), [['asm1/q1', 'legacy-1']], 'moved into the shard, re-keyed');
  assert.deepEqual(Object.keys(be.json('responses')), ['rec_z'], 'and removed from the old blob');
  assert.deepEqual((await inst2.list('responses', { assessment_id: 'asm1' })).map((r) => r.id), ['asm1/q1'], 'the other instance reads the shard');

  await Promise.all([
    inst1.insert('responses', { assessment_id: 'asm1', question_id: 'q2', answer: 'autosaved' }),
    inst2.update('responses', 'asm1/q1', { answer: 'locked', locked: true }),
  ]);
  const shard = be.json(`${KEY_ROOTS.shard}/responses/asm1`);
  assert.equal(shard['asm1/q2'].answer, 'autosaved');
  assert.equal(shard['asm1/q1'].answer, 'locked');
  assert.equal((await inst1.list('responses')).length, 2 + 1, 'an unfiltered list also finds the paper still in the old blob');

  // a previous-version instance still running for a moment writes into the
  // old blob AFTER the shard exists: folded in on the next read, newest wins
  const raw = be.module.getStore();
  const old = (await raw.get('responses')) || {};
  old.rec_new = { id: 'rec_new', assessment_id: 'asm1', question_id: 'q3', answer: 'late from old code', created_at: '2026-01-01T00:00:00.000Z' };
  old.rec_dup = { id: 'rec_dup', assessment_id: 'asm1', question_id: 'q2', answer: 'older autosave', updated_at: '2020-01-01T00:00:00.000Z' };
  await raw.setJSON('responses', old);
  const fresh = await createBlobsStore({ blobsModule: be.module }); // (inst1 remembers the old blob as empty for a minute)
  const now = await fresh.list('responses', { assessment_id: 'asm1' });
  assert.deepEqual(now.map((r) => [r.id, r.answer]).sort(), [['asm1/q1', 'locked'], ['asm1/q2', 'autosaved'], ['asm1/q3', 'late from old code']]);
  assert.deepEqual(be.json('responses'), {}, 'folded rows leave the old blob (the unfiltered list above had already moved asm9 into its own shard)');
  assert.deepEqual(Object.keys(be.json(`${KEY_ROOTS.shard}/responses/asm9`)), ['asm9/q1']);
});

/* ---------------------------------------------------------- through the API */

async function seedWorld(store) {
  const role = await store.insert('roles', { key: 'rsa', name: 'RSA', technology: 'X', description: '', active: true });
  const comp = await store.insert('competencies', { role_id: role.id, key: 'core', name: 'Core', category: 'technical', weight: 100, target_level: 3, order: 1, active: true });
  for (let i = 0; i < 3; i += 1) {
    await store.insert('questions', {
      role_id: role.id, competency_id: comp.id, help_text: '', difficulty: 'intermediate', points: i + 2, rubric: '', active: true,
      type: 'mcq_single', order: i, prompt: `Pick B (${i}).`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['b'],
    });
  }
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: (await import('../src/core/constants.mjs')).DEFAULT_FRAMEWORK_CONFIG, active: true });
  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mkUser({ username: 'assessor', name: 'Assessor', role: 'assessor', email: '', password: 'a-pass-x' });
  const cand = await store.insert('candidates', { name: 'one', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'one', name: 'one', role: 'candidate', email: '', candidate_id: cand.id, password: 'one-pass-x' });
  return { role, assessor, cand };
}

test('listings print the paper facts from the row (allocated now) or from an inline paper (allocated before), never by fetching every paper', async () => {
  const be = blobBackend();
  const store = await createBlobsStore({ blobsModule: be.module });
  const { role, assessor, cand } = await seedWorld(store);
  const app = await createApp(store);
  const call = (method, p, { token, body } = {}) => app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (username, password) => (await call('POST', '/auth/login', { body: { username, password } })).body.token;
  const admin = await login('admin', 'admin-pass-x');

  // a row from the previous version: inline paper, no facts
  const legacy = await store.insert('assessments', {
    candidate_id: cand.id, role_id: role.id, assessor_id: assessor.id, status: 'scored', overall_pct: 60, readiness_key: 'x', readiness_label: 'X',
    snapshot_json: { ...paper(2), role: { id: role.id, name: 'RSA (frozen)' } }, report_json: { overall_pct: 60 }, created_at: '2026-01-01T00:00:00.000Z',
  });
  // and one allocated now
  const alloc = await call('POST', '/admin/assessments', { token: admin, body: { candidate_id: cand.id, role_id: role.id, assessor_id: assessor.id, question_count: 2 } });
  assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
  const stored = be.json('assessments')[alloc.body.id];
  assert.deepEqual(
    { question_count: stored.question_count, total_points: stored.total_points, question_limit: stored.question_limit, bank_total: stored.bank_total, role_name: stored.role_name },
    { question_count: 2, total_points: alloc.body.snapshot_json.questions.reduce((s, q) => s + q.points, 0), question_limit: 2, bank_total: 3, role_name: 'RSA' },
    'allocation stores the facts beside the paper',
  );

  const paperReads = () => be.reads.filter((k) => k.startsWith(`${KEY_ROOTS.column}/assessments/`)).length;
  const before = paperReads();
  const list = await call('GET', '/admin/assessments', { token: admin });
  assert.equal(list.status, 200);
  const byId = Object.fromEntries(list.body.assessments.map((a) => [a.id, a]));
  assert.deepEqual([byId[alloc.body.id].question_count, byId[alloc.body.id].question_limit, byId[alloc.body.id].bank_total], [2, 2, 3]);
  assert.deepEqual([byId[legacy.id].question_count, byId[legacy.id].question_limit, byId[legacy.id].bank_total], [2, null, 2], 'a legacy row is read from its inline paper');
  assert.equal(paperReads(), before, 'the admin listing fetched no paper');

  const cTok = await login('one', 'one-pass-x');
  const mine = await call('GET', '/candidate/assessments', { token: cTok });
  const mineById = Object.fromEntries(mine.body.assessments.map((a) => [a.id, a]));
  assert.deepEqual([mineById[legacy.id].role_name, mineById[legacy.id].question_count, mineById[legacy.id].total_points], ['RSA (frozen)', 2, 5]);
  assert.deepEqual([mineById[alloc.body.id].role_name, mineById[alloc.body.id].question_count], ['RSA', 2]);
  const aTok = await login('assessor', 'a-pass-x');
  const theirs = await call('GET', '/assessor/assessments', { token: aTok });
  assert.deepEqual(theirs.body.assessments.map((a) => [a.id, a.question_count]).sort(), [[alloc.body.id, 2], [legacy.id, 2]].sort());
  assert.equal(paperReads(), before, 'nor did the candidate or assessor listings');
  const dash = await call('GET', '/admin/dashboard', { token: admin });
  assert.equal(dash.body.counts.active_assessments, 1);
  assert.equal(paperReads(), before);

  // opening the new paper: the exam works on the detached paper, and a
  // legacy row gains its facts (and loses its inline paper) on first open
  const legacyOpen = await store.insert('assessments', {
    candidate_id: cand.id, role_id: role.id, assessor_id: assessor.id, status: 'assigned',
    snapshot_json: alloc.body.snapshot_json, report_json: null, created_at: '2026-01-03T00:00:00.000Z',
  });
  await call('DELETE', `/admin/assessments/${alloc.body.id}`, { token: admin });
  const open = await call('GET', `/candidate/assessments/${legacyOpen.id}`, { token: cTok });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const row = be.json('assessments')[legacyOpen.id];
  assert.ok(isDetachedMarker(row.snapshot_json), 'first open moved the paper out');
  assert.deepEqual([row.question_count, row.role_name], [2, 'RSA']);
  assert.ok(!be.data.has(`${KEY_ROOTS.column}/assessments/${alloc.body.id}/snapshot_json`), 'the deleted assessment took its paper blob with it');
  assert.deepEqual(be.json(`${KEY_ROOTS.shard}/responses/${alloc.body.id}`) ?? {}, {}, 'and its answers');

  // paperFacts for a detached row that never got facts fetches once and stamps them
  const bare = await store.insert('assessments', { candidate_id: cand.id, role_id: role.id, status: 'scored', snapshot_json: paper(3), report_json: null });
  await store.update('assessments', bare.id, { status: 'validated' }); // moves the paper out, no facts yet
  const lean = (await store.list('assessments', { candidate_id: cand.id }, { detached: false })).find((a) => a.id === bare.id);
  assert.ok(isDetachedMarker(lean.snapshot_json) && lean.role_name === undefined);
  assert.deepEqual(await paperFacts(store, [lean]), [paperSummary(paper(3))]);
  assert.equal(be.json('assessments')[bare.id].total_points, paperSummary(paper(3)).total_points, 'stamped for the next listing');
});
