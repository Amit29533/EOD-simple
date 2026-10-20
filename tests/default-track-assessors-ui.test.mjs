import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

test('admin can select, save, preserve an unavailable default, and clear it through the real settings form', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const active = await w.assessorUser('available'), inactive = await w.assessorUser('inactive');
  await w.store.update('users', inactive.user.id, { active: false });
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const { roleDetailView, rolesView } = await import('../public/js/views/admin.js');
    await roleDetailView(spa.view, { id: w.role.id });
    spa.view.querySelector('#edit-role').click(); await flush();
    let select = spa.document.querySelector('[name="default_assessor_id"]');
    assert.ok(select);
    assert.deepEqual([...select.options].map((o) => o.value), ['', active.user.id]);
    type(select, active.user.id);
    spa.document.querySelector('.m-foot .btn:last-child').click(); await flush(100);
    assert.equal((await w.store.get('roles', w.role.id)).default_assessor_id, active.user.id);
    assert.match(spa.text(), /Default assessor: Assessor available/);
    await rolesView(spa.view);
    assert.match(spa.text(), /Default assessor/); assert.match(spa.text(), /Assessor available/);

    await w.store.update('users', active.user.id, { active: false });
    await roleDetailView(spa.view, { id: w.role.id });
    assert.match(spa.text(), /Unavailable — choose another/);
    spa.view.querySelector('#edit-role').click(); await flush();
    select = spa.document.querySelector('[name="default_assessor_id"]');
    assert.equal(select.value, active.user.id, 'stale selection retained rather than silently cleared');
    type(spa.document.querySelector('[name="description"]'), 'Updated description');
    spa.document.querySelector('.m-foot .btn:last-child').click(); await flush(100);
    assert.equal((await w.store.get('roles', w.role.id)).default_assessor_id, active.user.id);
    spa.view.querySelector('#edit-role').click(); await flush();
    type(spa.document.querySelector('[name="default_assessor_id"]'), '');
    spa.document.querySelector('.m-foot .btn:last-child').click(); await flush(100);
    assert.equal((await w.store.get('roles', w.role.id)).default_assessor_id, null);
    assert.match(spa.text(), /Default assessor: Not set/);
  } finally { spa.teardown(); }
});
