/**
 * Competency keys: the published-catalogue sync (synchronizeBank) finds a
 * track's competencies by key and creates any it cannot find. PATCH used to
 * accept a blank key, and the next sync then added a second, empty copy of
 * the competency: on the RSA track, 7 competencies became 8 and the weights
 * summed to 118, with an extra "not assessed" row on every later report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { PUBLISHED_CATALOGUES, isCatalogueCompetency } from '../src/api/catalogue-service.mjs';

async function rsaWorld(t) {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  w.expectOk(await w.call('POST', '/admin/content/tracks', { token: w.tok, body: { role_key: 'databricks-rsa' } }), 'install RSA');
  const role = (await w.store.list('roles')).find((r) => r.key === 'databricks-rsa');
  const comps = () => w.store.list('competencies', { role_id: role.id });
  const weights = async () => (await comps()).filter((c) => c.active !== false).reduce((s, c) => s + Number(c.weight || 0), 0);
  const sync = async () => w.expectOk(await w.call('POST', '/admin/content/sync', { token: w.tok, body: { role_key: 'databricks-rsa' } }), 'sync');
  return { w, role, comps, weights, sync };
}

test('a blank key is refused, and the next sync leaves the track as it was', async (t) => {
  const { w, comps, weights, sync } = await rsaWorld(t);
  const [victim] = await comps();
  assert.equal((await comps()).length, 7);
  assert.equal(await weights(), 100);
  for (const key of ['', '   ', '\t\n']) {
    const r = await w.call('PATCH', `/admin/competencies/${victim.id}`, { token: w.tok, body: { key } });
    assert.equal(r.status, 400, `key ${JSON.stringify(key)}`);
    assert.match(r.body.error, /cannot be blank/);
  }
  assert.equal((await w.store.get('competencies', victim.id)).key, victim.key, 'the key is untouched');
  const s = await sync();
  assert.equal(s.competencies_added, 0);
  assert.equal((await comps()).length, 7, 'no duplicate competency');
  assert.equal(await weights(), 100, 'weights still sum to 100');
});

test('a catalogue competency keeps its key; echoing the same key back is not an error', async (t) => {
  const { w, comps } = await rsaWorld(t);
  const [victim] = await comps();
  const renamed = await w.call('PATCH', `/admin/competencies/${victim.id}`, { token: w.tok, body: { key: 'my-own-key' } });
  assert.equal(renamed.status, 409);
  assert.match(renamed.body.error, /published .* catalogue/);
  assert.equal((await w.store.get('competencies', victim.id)).key, victim.key);
  // An integration that sends the whole record back, key included, still saves.
  const echoed = await w.call('PATCH', `/admin/competencies/${victim.id}`, { token: w.tok, body: { key: victim.key, weight: 20 } });
  assert.equal(echoed.status, 200, JSON.stringify(echoed.body));
  assert.equal(echoed.body.weight, 20);
  assert.equal(echoed.body.key, victim.key);
  // Everything else about it stays editable.
  assert.equal((await w.call('PATCH', `/admin/competencies/${victim.id}`, { token: w.tok, body: { name: 'Renamed', description: 'x' } })).status, 200);
});

test('on a custom track a key can change, but never to blank or to a sibling\'s key', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  const [c1, c2] = await w.store.list('competencies');
  const patch = (id, key) => w.call('PATCH', `/admin/competencies/${id}`, { token: w.tok, body: { key } });
  const ok = await patch(c1.id, 'architecture-core');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.key, 'architecture-core');
  assert.equal((await patch(c2.id, 'architecture-core')).status, 409, 'a sibling\'s key is taken');
  assert.equal((await patch(c2.id, '')).status, 400);
  assert.equal((await w.store.get('competencies', c2.id)).key, c2.key);
});

test('create: an explicit key must be free; derived keys never collide and are never blank', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  const role = (await w.store.list('roles'))[0];
  const post = (body) => w.call('POST', '/admin/competencies', { token: w.tok, body: { role_id: role.id, weight: 10, target_level: 3, ...body } });
  const existingKey = (await w.store.list('competencies'))[0].key;
  assert.equal((await post({ name: 'Anything', key: existingKey })).status, 409, 'explicit duplicate refused');

  const a = await post({ name: 'Data Governance' });
  const b = await post({ name: 'Data Governance' });
  const c = await post({ name: 'data  governance!' });
  assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
  assert.deepEqual([a.body.key, b.body.key, c.body.key], ['data-governance', 'data-governance-2', 'data-governance-3']);

  const script = await post({ name: 'संचार कौशल' });
  assert.equal(script.status, 201);
  assert.equal(script.body.key, 'competency', 'a name with no a-z letters still gets a key');
  const script2 = await post({ name: 'अनुपालन' });
  assert.equal(script2.body.key, 'competency-2');

  const explicit = await post({ name: 'Custom', key: 'custom-key' });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.key, 'custom-key');
  const keys = (await w.store.list('competencies', { role_id: role.id })).map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length, 'every key in the track is unique');
});

test('the sync repairs a catalogue competency whose key was blanked before this fix', async (t) => {
  const { w, comps, weights, sync } = await rsaWorld(t);
  const [victim] = await comps();
  const before = (await w.store.list('questions', { competency_id: victim.id })).length;
  assert.ok(before > 0, 'the competency carries questions');
  // What the old PATCH left behind.
  await w.store.update('competencies', victim.id, { key: '' });
  const s = await sync();
  assert.equal(s.competencies_repaired, 1, 'the orphan is adopted');
  assert.equal(s.competencies_added, 0, 'no second copy is created');
  assert.equal((await comps()).length, 7);
  assert.equal(await weights(), 100);
  const healed = await w.store.get('competencies', victim.id);
  assert.equal(healed.key, victim.key, 'its catalogue key is back');
  assert.equal((await w.store.list('questions', { competency_id: victim.id })).length, before, 'its questions stay with it');
  // Idempotent: a second sync has nothing to repair.
  const again = await sync();
  assert.equal(again.competencies_repaired, 0);
  assert.equal(again.competencies_added, 0);
});

test('isCatalogueCompetency recognises every published catalogue\'s competencies, and nothing else', () => {
  for (const [key, catalogue] of Object.entries(PUBLISHED_CATALOGUES)) {
    const role = { key };
    for (const c of catalogue.competencies) assert.equal(isCatalogueCompetency(role, { key: c.key }), true, `${key}/${c.key}`);
    assert.equal(isCatalogueCompetency(role, { key: 'not-in-the-catalogue' }), false);
    assert.equal(isCatalogueCompetency(role, { key: '' }), false);
  }
  assert.equal(isCatalogueCompetency({ key: 'custom-track' }, { key: 'lakehouse-architecture' }), false);
  assert.equal(isCatalogueCompetency({ key: '__proto__' }, { key: 'x' }), false);
  assert.equal(isCatalogueCompetency(null, { key: 'x' }), false);
});
