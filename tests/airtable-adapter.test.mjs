import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAirtableStore, AIRTABLE_TEXT_CELL_LIMIT } from '../src/storage/airtable.mjs';
import { TABLES, overflowColumns } from '../src/storage/schema.mjs';
import { SCHEMA } from '../scripts/airtable-setup.mjs';

/**
 * Faithful-enough mock of the Airtable REST API: records CRUD, 100-row
 * pagination with offsets, equality/AND filterByFormula, 404 on missing ids.
 * Validates the adapter end-to-end without real credentials.
 *
 * It also reproduces the three Airtable behaviours that bit the app:
 *  - an unchecked checkbox, `null` and `''` are NOT stored — the field is
 *    simply absent from the record on read (`{f} = FALSE()` still matches);
 *  - a text cell holds at most 100,000 characters (422 past that);
 *  - a field that is not a column of the table is rejected (422) — with
 *    `columns` set, the mock knows the provisioned schema.
 */
function mockAirtable({ columns } = {}) {
  const deleteCalls = []; // every batch-delete request, as the list of ids it named
  const tables = new Map(); // table -> Map(id -> {id, fields})
  const table = (t) => tables.get(t) || tables.set(t, new Map()).get(t);
  let seq = 0;
  const stored = (tbl, fields, res) => {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
      if (columns && !columns[tbl]?.includes(k)) { res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'UNKNOWN_FIELD_NAME', message: `Unknown field name: "${k}"` } })); return null; }
      if (typeof v === 'string' && v.length > AIRTABLE_TEXT_CELL_LIMIT) { res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'INVALID_VALUE_FOR_COLUMN' } })); return null; }
      if (v === false || v === null || v === '' || v === undefined) continue;
      out[k] = v;
    }
    return out;
  };
  const merged = (tbl, prev, patch, res) => {
    const next = stored(tbl, patch, res);
    if (!next) return null;
    const out = { ...prev, ...next };
    // A PATCH that unchecks/clears a field removes it from the record.
    for (const [k, v] of Object.entries(patch || {})) if (v === false || v === null || v === '') delete out[k];
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // [v0, base, table, id?]
    const [, base, tbl, id] = parts;
    if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end('{"error":"unauthorized"}'); return; }
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (columns && !columns[tbl]) { json(404, { error: { type: 'TABLE_NOT_FOUND', message: `Could not find table ${tbl} in application ${base}` } }); return; }
    const t = table(tbl);

    if (req.method === 'GET' && !id) {
      const pageSize = Math.min(Number(url.searchParams.get('pageSize') || 100), 100);
      const all = [...t.values()];
      let filtered = all;
      const f = url.searchParams.get('filterByFormula');
      if (f) {
        const conds = f.startsWith('AND(') ? f.slice(4, -1).split(/,\s*(?=\{)/) : [f];
        const parsed = conds.map((c) => {
          const m = /^\{([^}]+)\}\s*=\s*(.+)$/.exec(c.trim());
          let v = m[2].trim();
          if (v === 'TRUE()') v = true; else if (v === 'FALSE()') v = false;
          else if (v.startsWith("'")) v = v.slice(1, -1).replace(/\\'/g, "'");
          else v = Number(v);
          return [m[1], v];
        });
        // An absent checkbox is "unchecked": `{f} = FALSE()` matches it.
        filtered = all.filter((r) => parsed.every(([k, v]) => (v === false ? r.fields[k] !== true : r.fields[k] === v)));
      }
      const offset = Number(url.searchParams.get('offset') || 0);
      const page = filtered.slice(offset, offset + pageSize);
      const out = { records: page };
      if (offset + pageSize < filtered.length) out.offset = String(offset + pageSize);
      json(200, out); return;
    }
    if (req.method === 'GET' && id) {
      const rec = t.get(id);
      if (!rec) { json(404, { error: 'NOT_FOUND' }); return; }
      json(200, rec); return;
    }
    let body = '';
    for await (const c of req) body += c;
    const payload = body ? JSON.parse(body) : {};
    if (req.method === 'POST' && !id) {
      const created = [];
      for (const r of payload.records || []) {
        const fields = stored(tbl, r.fields, res);
        if (!fields) return;
        created.push({ id: `rec${String(++seq).padStart(14, '0')}x`, fields });
      }
      for (const rec of created) t.set(rec.id, rec);
      json(200, { records: created }); return;
    }
    if (req.method === 'PATCH' && id) {
      const rec = t.get(id);
      if (!rec) { json(404, {}); return; }
      const fields = merged(tbl, rec.fields, payload.fields, res);
      if (!fields) return;
      rec.fields = fields;
      json(200, rec); return;
    }
    if (req.method === 'PATCH' && !id) {
      // Batch update: Airtable rejects the whole request when any id is unknown.
      const wanted = payload.records || [];
      if (wanted.length > 10) { json(422, { error: 'max 10 records' }); return; }
      if (wanted.some((r) => !t.has(r.id))) { json(404, { error: 'MODEL_ID_NOT_FOUND' }); return; }
      const next = [];
      for (const r of wanted) {
        const fields = merged(tbl, t.get(r.id).fields, r.fields, res);
        if (!fields) return;
        next.push([t.get(r.id), fields]);
      }
      for (const [rec, fields] of next) rec.fields = fields;
      json(200, { records: next.map(([rec]) => rec) }); return;
    }
    if (req.method === 'DELETE' && id) {
      if (!t.has(id)) { json(404, {}); return; }
      t.delete(id);
      json(200, { id, deleted: true }); return;
    }
    if (req.method === 'DELETE' && !id) {
      // Batch delete: `DELETE /{table}?records[]=a&records[]=b`, max 10.
      const wanted = url.searchParams.getAll('records[]');
      if (!wanted.length || wanted.length > 10) { json(422, { error: 'records[] required, max 10' }); return; }
      if (wanted.some((w) => !t.has(w))) { json(404, { error: { type: 'NOT_FOUND' } }); return; }
      deleteCalls.push(wanted);
      for (const w of wanted) t.delete(w);
      json(200, { records: wanted.map((w) => ({ id: w, deleted: true })) }); return;
    }
    json(500, { error: `mock: unhandled ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, deleteCalls })));
}

test('airtable adapter: full CRUD contract + pagination + JSON fields', async () => {
  const { server, port } = await mockAirtable();
  try {
    const store = createAirtableStore({ apiKey: 'test-key', baseId: 'appTEST', apiUrl: `http://127.0.0.1:${port}/v0` });

    // insert + get
    const role = await store.insert('roles', { key: 'databricks-rsa', name: 'RSA', active: true });
    assert.ok(role.id.startsWith('rec'));
    assert.equal((await store.get('roles', role.id)).name, 'RSA');
    // The storage contract stamps created_at (every "newest first" list sorts
    // by it); the adapter used to leave it blank unless the caller passed one.
    assert.ok(role.created_at && !Number.isNaN(Date.parse(role.created_at)), 'insert stamps created_at');
    const dated = await store.insert('roles', { key: 'dated', name: 'Dated', created_at: '2020-01-01T00:00:00.000Z' });
    assert.equal(dated.created_at, '2020-01-01T00:00:00.000Z', 'an explicit created_at is kept');

    // JSON field round-trip on questions.options
    const q = await store.insert('questions', {
      role_id: role.id, competency_id: 'comp1', type: 'mcq_multi', prompt: 'p?',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      correct_option_ids: ['a', 'b'], points: 4, active: true,
    });
    const fetched = await store.get('questions', q.id);
    assert.deepEqual(fetched.options, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    assert.deepEqual(fetched.correct_option_ids, ['a', 'b']);
    assert.equal(typeof fetched.points, 'number');

    // equality filter + AND filter
    await store.insert('questions', { role_id: role.id, competency_id: 'comp2', type: 'text', prompt: 't?', rubric: 'r', points: 6, active: true });
    assert.equal((await store.list('questions', { competency_id: 'comp1' })).length, 1);
    assert.equal((await store.list('questions', { role_id: role.id, active: true })).length, 2);
    assert.equal((await store.list('questions', { role_id: role.id, competency_id: 'nope' })).length, 0);

    // update
    const updated = await store.update('questions', q.id, { rubric: 'updated rubric' });
    assert.equal(updated.rubric, 'updated rubric');
    assert.ok(updated.updated_at);

    // insertMany: batch in 10-record chunks, order preserved, per-row semantics
    const batch = [];
    for (let i = 0; i < 12; i++) batch.push({ actor_name: 'b', action: 'bulk', entity: 'e', entity_id: `bulk-${i}` });
    const recs = await store.insertMany('audit_log', batch);
    assert.equal(recs.length, 12);
    assert.deepEqual(recs.map((r) => r.entity_id), batch.map((r) => r.entity_id), 'order preserved across chunks');
    assert.equal((await store.list('audit_log', { action: 'bulk' })).length, 12);
    assert.ok(recs.every((r) => r.created_at), 'insertMany stamps created_at on every row');

    // updateMany: 10-record batches, caller order, null for unknown ids, and a
    // chunk with an unknown id still applies the known rows in it.
    const patched = await store.updateMany('audit_log', recs.map((r, i) => ({ id: r.id, patch: { message: `m${i}` } })));
    assert.equal(patched.length, 12);
    assert.deepEqual(patched.map((r) => r.message), recs.map((_, i) => `m${i}`), 'updateMany keeps caller order');
    assert.ok(patched.every((r) => r.updated_at), 'updateMany stamps updated_at');
    const mixed = await store.updateMany('audit_log', [
      { id: recs[0].id, patch: { message: 'again' } },
      { id: 'recDOESNOTEXIST', patch: { message: 'nope' } },
    ]);
    assert.equal(mixed[0]?.message, 'again', 'known row in a rejected chunk is still updated');
    assert.equal(mixed[1], null, 'unknown id maps to null');

    // pagination across >100 rows
    for (let i = 0; i < 150; i++) await store.insert('audit_log', { actor_name: 't', action: 'a', entity: 'e', entity_id: `id-${i}` });
    const logs = await store.list('audit_log');
    assert.equal(logs.length, 150 + 12);

    // remove
    assert.equal(await store.remove('roles', role.id), true);
    assert.equal(await store.get('roles', role.id), null);
    assert.equal(await store.remove('roles', role.id), false);
  } finally {
    server.close();
  }
});

const provisioned = Object.fromEntries(Object.entries(SCHEMA).map(([t, fields]) => [t, fields.map((f) => f.name)]));
const connect = (port) => createAirtableStore({ apiKey: 'test-key', baseId: 'appTEST', apiUrl: `http://127.0.0.1:${port}/v0` });

test('airtable adapter: an unchecked checkbox reads back as false, not undefined', async () => {
  // Airtable omits an unchecked checkbox from the record entirely. The app
  // reads `active === false` as "deactivated", so a dropped `false` used to
  // let a deactivated user sign in and kept a deactivated question in papers.
  const { server, port } = await mockAirtable({ columns: provisioned });
  try {
    const store = connect(port);
    const user = await store.insert('users', { username: 'gone', name: 'Gone', role: 'assessor', password_hash: 'x', active: true });
    assert.equal(user.active, true);
    const off = await store.update('users', user.id, { active: false });
    assert.equal(off.active, false, 'the update result carries the false that was written');
    assert.equal((await store.get('users', user.id)).active, false, 'a re-read carries it too');
    assert.equal((await store.list('users', { username: 'gone' }))[0].active, false, 'and a listed row');
    assert.equal((await store.list('users', { active: false })).length, 1, 'filtering on false still finds it');
    assert.equal((await store.list('users', { active: true })).length, 0);

    // Inserted without the flag at all → false as well (never undefined).
    const bare = await store.insert('users', { username: 'bare', name: 'Bare', role: 'candidate', password_hash: 'x' });
    assert.equal((await store.get('users', bare.id)).active, false);

    // Every boolean column the app reads as tri-state is covered, per table.
    const q = await store.insert('questions', { role_id: 'r', competency_id: 'c', type: 'text', prompt: 'p', rubric: 'r', points: 1, active: true, pin_first: false, audio_required: false });
    const qr = await store.get('questions', q.id);
    assert.deepEqual([qr.active, qr.pin_first, qr.audio_required], [true, false, false]);
    const bq = await store.insert('bank_questions', { role_key: 'k', module: 'm', family_id: 'm:f', type: 'open', prompt: 'p', active: true, randomizable: true, needs_option_review: false });
    const bqr = await store.update('bank_questions', bq.id, { active: false, randomizable: false });
    assert.deepEqual([bqr.active, bqr.randomizable, bqr.needs_option_review], [false, false, false]);
    const ov = await store.insert('bank_question_overrides', { question_id: 'q1', role_key: 'k', active: false });
    assert.equal((await store.list('bank_question_overrides', { question_id: 'q1' }))[0].active, false, 'a removal override survives the round trip');
    const resp = await store.insert('responses', { assessment_id: 'a', question_id: 'q', answer: { text: 'x' }, locked: false });
    assert.equal((await store.get('responses', resp.id)).locked, false);
    assert.equal(ov.active, false);

    // Non-boolean columns are untouched: an empty string is dropped by Airtable
    // and comes back absent, which the app already tolerates (`|| ''`).
    const cand = await store.insert('candidates', { name: 'C', email: '', stage: 'new' });
    assert.equal((await store.get('candidates', cand.id)).email, undefined);
  } finally {
    server.close();
  }
});

test('airtable adapter: the boolean registry matches the provisioned checkbox columns', () => {
  for (const [table, fields] of Object.entries(SCHEMA)) {
    const checkboxes = fields.filter((f) => f.type === 'checkbox').map((f) => f.name).sort();
    assert.deepEqual([...(TABLES[table]?.flags || [])].sort(), checkboxes, `${table}: schema.mjs flags vs airtable-setup checkbox columns`);
  }
});

test('airtable adapter: values past one 100,000-character cell are split across continuation columns and rejoined', async () => {
  const { server, port } = await mockAirtable({ columns: provisioned });
  try {
    const store = connect(port);
    // A recorded answer: ~400k of base64 audio inside the answer JSON.
    const answer = { text: 'notes', source: 'audio', audio_mime: 'audio/webm', audio_b64: 'A'.repeat(390_000) };
    const resp = await store.insert('responses', { assessment_id: 'a1', question_id: 'q1', answer, locked: false });
    assert.deepEqual(resp.answer, answer, 'insert returns the value as written');
    const back = await store.get('responses', resp.id);
    assert.deepEqual(back.answer, answer, 'a re-read rejoins the pieces');
    assert.equal(back.answer__2, undefined, 'continuation cells never leak into the record');
    const listed = (await store.list('responses', { assessment_id: 'a1' }))[0];
    assert.deepEqual(listed.answer, answer, 'list rejoins too');

    // Shrinking the value later must not resurrect stale continuation cells.
    const small = { text: 'typed instead' };
    await store.update('responses', resp.id, { answer: small });
    assert.deepEqual((await store.get('responses', resp.id)).answer, small);
    // …and growing it again works.
    const big2 = { ...answer, audio_b64: 'B'.repeat(250_000) };
    await store.update('responses', resp.id, { answer: big2 });
    assert.deepEqual((await store.get('responses', resp.id)).answer, big2);

    // A whole-bank paper (snapshot) and a report on assessments.
    const snapshot = { questions: Array.from({ length: 140 }, (_, i) => ({ id: `q${i}`, prompt: 'x'.repeat(900), options: [{ id: 'a', label: 'y'.repeat(200) }] })) };
    assert.ok(JSON.stringify(snapshot).length > AIRTABLE_TEXT_CELL_LIMIT);
    const a = await store.insert('assessments', { candidate_id: 'c', role_id: 'r', status: 'allocated', snapshot_json: snapshot });
    assert.deepEqual((await store.get('assessments', a.id)).snapshot_json, snapshot);
    const report = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, note: 'n'.repeat(300) })) };
    assert.ok(JSON.stringify(report).length > AIRTABLE_TEXT_CELL_LIMIT);
    const scored = await store.update('assessments', a.id, { report_json: report });
    assert.deepEqual(scored.report_json, report);
    assert.deepEqual((await store.get('assessments', a.id)).report_json, report);

    // Batch paths split as well.
    const many = await store.insertMany('responses', [1, 2, 3].map((i) => ({ assessment_id: 'a2', question_id: `q${i}`, answer: { audio_b64: String(i).repeat(150_000) } })));
    assert.deepEqual(many.map((r) => r.answer.audio_b64.length), [150_000, 150_000, 150_000]);
    const relisted = await store.list('responses', { assessment_id: 'a2' });
    assert.deepEqual(relisted.map((r) => r.answer.audio_b64.length).sort(), [150_000, 150_000, 150_000]);
    const patched = await store.updateMany('responses', many.map((r) => ({ id: r.id, patch: { answer: { audio_b64: 'Z'.repeat(120_000) } } })));
    assert.ok(patched.every((r) => r.answer.audio_b64 === 'Z'.repeat(120_000)));

    // A recording row: the clip alone, at the API's ceiling (400k of base64),
    // in the `audio` JSON column. Airtable keeps every table as separate
    // records already, so recordings are an ordinary table there.
    const clip = { b64: 'C'.repeat(400_000), mime: 'audio/webm;codecs=opus' };
    const rec = await store.insert('recordings', { assessment_id: 'a1', question_id: 'q1', audio: clip });
    assert.deepEqual((await store.get('recordings', rec.id)).audio, clip);
    const [byKey] = await store.list('recordings', { assessment_id: 'a1', question_id: 'q1' });
    assert.deepEqual(byKey.audio, clip, 'the per-question lookup the lock and the assessor make');
    assert.equal(byKey.audio__2, undefined);
    assert.deepEqual(await store.list('recordings', { assessment_id: 'a1', question_id: 'q2' }), []);
    await store.update('recordings', rec.id, { audio: { b64: 'd', mime: 'audio/webm' } });
    assert.deepEqual((await store.get('recordings', rec.id)).audio, { b64: 'd', mime: 'audio/webm' }, 'a shorter re-take leaves no stale continuation cells');
    assert.equal(await store.removeMany('recordings', [rec.id]), 1);
    assert.deepEqual(await store.list('recordings', { assessment_id: 'a1' }), []);

    // The provisioning script creates every continuation column the adapter may write.
    for (const t of ['assessments', 'responses', 'recordings']) {
      for (const col of overflowColumns(t)) assert.ok(provisioned[t].includes(col), `${t}.${col} is provisioned`);
    }
  } finally {
    server.close();
  }
});

test('airtable adapter: a value that cannot fit even with continuation cells fails loudly, before the request', async () => {
  const { server, port } = await mockAirtable({ columns: provisioned });
  try {
    const store = connect(port);
    // answer has 4 continuation cells → 5 × 100k. Past that: a named error.
    await assert.rejects(
      store.insert('responses', { assessment_id: 'a', question_id: 'q', answer: { audio_b64: 'A'.repeat(520_000) } }),
      (err) => err.code === 'VALUE_TOO_LARGE' && err.table === 'responses' && err.field === 'answer' && /answer is 5200\d\d characters/.test(err.message),
    );
    // A plain text column has no continuation cells at all.
    await assert.rejects(
      store.insert('candidates', { name: 'x', notes: 'n'.repeat(AIRTABLE_TEXT_CELL_LIMIT + 1) }),
      (err) => err.code === 'VALUE_TOO_LARGE' && err.field === 'notes',
    );
    // Exactly at the limit is fine and unsplit.
    const exact = await store.insert('candidates', { name: 'y', notes: 'n'.repeat(AIRTABLE_TEXT_CELL_LIMIT) });
    assert.equal((await store.get('candidates', exact.id)).notes.length, AIRTABLE_TEXT_CELL_LIMIT);
    assert.equal((await store.list('candidates')).length, 1, 'the rejected inserts never reached Airtable');
  } finally {
    server.close();
  }
});

test('airtable adapter: a table missing from the base is an error, not an empty list', async () => {
  // An older base (created before bank_questions existed) or a wrong
  // AIRTABLE_BASE_ID answers 404 to every table-level call. That used to read
  // as "no rows" on list — a login against such a base failed as "invalid
  // credentials" — and as a TypeError on insert.
  const { server, port } = await mockAirtable({ columns: { users: provisioned.users } });
  try {
    const store = connect(port);
    await assert.rejects(store.list('bank_questions'), (err) => err.code === 'TABLE_NOT_FOUND' && /bank_questions.*not found in base appTEST/.test(err.message) && /airtable:setup/.test(err.message));
    await assert.rejects(store.insert('bank_questions', { role_key: 'k' }), (err) => err.code === 'TABLE_NOT_FOUND');
    await assert.rejects(store.insertMany('bank_questions', [{ role_key: 'k' }]), (err) => err.code === 'TABLE_NOT_FOUND');
    // Record-level misses are still a quiet null/false — that is the contract.
    assert.equal(await store.get('users', 'recNOPE'), null);
    assert.equal(await store.update('users', 'recNOPE', { name: 'x' }), null);
    assert.equal(await store.remove('users', 'recNOPE'), false);
    assert.deepEqual(await store.list('users', { username: 'nobody' }), []);
  } finally {
    server.close();
  }
});

test('airtable adapter: removeMany deletes ten records per request and falls back per row', async () => {
  const { server, port, deleteCalls } = await mockAirtable();
  try {
    const store = connect(port);
    const rows = await store.insertMany('responses', Array.from({ length: 23 }, (_, i) => ({ assessment_id: 'a1', question_id: `q${i}` })));
    assert.equal(rows.length, 23);
    const removed = await store.removeMany('responses', rows.map((r) => r.id));
    assert.equal(removed, 23, 'every row reported removed');
    assert.deepEqual(deleteCalls.map((c) => c.length), [10, 10, 3], 'ceil(23/10) batch requests');
    assert.equal((await store.list('responses')).length, 0);

    // An id that is already gone fails the batch; the chunk falls back to
    // per-row deletes so the rest of the cascade still lands.
    const more = await store.insertMany('responses', [{ question_id: 'x' }, { question_id: 'y' }]);
    const partial = await store.removeMany('responses', [more[0].id, 'recMISSING', more[1].id]);
    assert.equal(partial, 2, 'the two real rows were removed');
    assert.equal((await store.list('responses')).length, 0);
    assert.equal(await store.removeMany('responses', []), 0, 'an empty batch is a no-op');
  } finally {
    server.close();
  }
});
