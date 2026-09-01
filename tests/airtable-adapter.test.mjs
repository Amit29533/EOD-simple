import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAirtableStore } from '../src/storage/airtable.mjs';

/**
 * Faithful-enough mock of the Airtable REST API: records CRUD, 100-row
 * pagination with offsets, equality/AND filterByFormula, 404 on missing ids.
 * Validates the adapter end-to-end without real credentials.
 */
function mockAirtable() {
  const tables = new Map(); // table -> Map(id -> {id, fields})
  const table = (t) => tables.get(t) || tables.set(t, new Map()).get(t);
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // [v0, base, table, id?]
    const [, base, tbl, id] = parts;
    if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end('{"error":"unauthorized"}'); return; }
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
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
        filtered = all.filter((r) => parsed.every(([k, v]) => r.fields[k] === v));
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
      const created = (payload.records || []).map((r) => {
        const rid = `rec${String(++seq).padStart(14, '0')}x`;
        const rec = { id: rid, fields: r.fields };
        t.set(rid, rec);
        return rec;
      });
      json(200, { records: created }); return;
    }
    if (req.method === 'PATCH' && id) {
      const rec = t.get(id);
      if (!rec) { json(404, {}); return; }
      rec.fields = { ...rec.fields, ...payload.fields };
      json(200, rec); return;
    }
    if (req.method === 'DELETE' && id) {
      if (!t.has(id)) { json(404, {}); return; }
      t.delete(id);
      json(200, { id, deleted: true }); return;
    }
    json(500, { error: `mock: unhandled ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('airtable adapter: full CRUD contract + pagination + JSON fields', async () => {
  const { server, port } = await mockAirtable();
  try {
    const store = createAirtableStore({ apiKey: 'test-key', baseId: 'appTEST', apiUrl: `http://127.0.0.1:${port}/v0` });

    // insert + get
    const role = await store.insert('roles', { key: 'databricks-rsa', name: 'RSA', active: true });
    assert.ok(role.id.startsWith('rec'));
    assert.equal((await store.get('roles', role.id)).name, 'RSA');

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
