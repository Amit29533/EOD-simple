import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { createAirtableStore } from '../src/storage/airtable.mjs';

test('all paginated directories return finite integer boundaries and consistent slices', async (t) => {
  const w = await makeWorld({ t });
  await w.candidateUser('page.one'); await w.candidateUser('page.two');
  for (const [path, key] of [['candidates', 'candidates'], ['users', 'users'], ['questions', 'questions'], ['assessments', 'assessments']]) {
    const all = await w.call('GET', `/admin/${path}`, { token: w.tok });
    const page = await w.call('GET', `/admin/${path}`, { token: w.tok, query: { limit: '1.9', offset: '1.9' } });
    assert.equal(page.status, 200);
    assert.equal(page.body.limit, 1, path); assert.equal(page.body.offset, 1, path);
    assert.deepEqual(page.body[key].map((r) => r.id), all.body[key].slice(1, 2).map((r) => r.id));
    for (const offset of ['Infinity', '-Infinity', '1e9999', '-1.4', 'NaN']) {
      const result = await w.call('GET', `/admin/${path}`, { token: w.tok, query: { limit: '2.9', offset } });
      assert.equal(result.body.offset, 0, `${path}: ${offset}`);
      assert.equal(result.body.limit, 2);
      assert.equal(result.body[key].length, Math.min(2, all.body.total));
    }
  }
});

test('Airtable bulk deletion surfaces permission/service failures instead of reporting successful cleanup', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return new Response(JSON.stringify({ error: 'permission denied' }), { status: 403 });
  };
  try {
    const store = createAirtableStore({ apiKey: 'test-key', baseId: 'test-base', apiUrl: 'http://airtable.test/v0' });
    await assert.rejects(store.removeMany('recordings', ['recBLOCKED']), /403/);
    assert.equal(calls.length, 2, 'one batch attempt followed by one individual attempt');
  } finally { globalThis.fetch = original; }
});
