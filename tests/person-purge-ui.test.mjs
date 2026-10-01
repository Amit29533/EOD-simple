import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await flush(20);
  }
  assert.fail('Timed out waiting for deletion UI to settle');
}

test('admin sees a deletion inventory before password entry; invalid confirmation and password preserve the person', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('delete.from.ui');
  const spa = await bootSpa({ hash: '#/users', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.usersView(spa.view);
    const primary = (await w.store.list('users', { username: 'admin' }))[0];
    assert.equal(spa.view.querySelector(`[data-purge-user="${primary.id}"]`), null);
    spa.view.querySelector(`[data-purge-user="${c.user.id}"]`).click();
    await until(() => spa.document.querySelector('.deletion-summary'));
    const inventory = spa.document.querySelector('.modal');
    assert.match(inventory.textContent, /Candidate profiles/);
    assert.match(inventory.textContent, /Finalized reports/);
    assert.match(inventory.textContent, /Audio recordings/);
    assert.equal(inventory.querySelector('[name="password"]'), null);
    assert.equal(spa.callsTo(`/admin/users/${c.user.id}/purge`, 'DELETE').length, 0);
    [...inventory.querySelectorAll('button')].find((b) => b.textContent === 'Continue').click();
    await flush(50);
    const form = spa.document.querySelector('.modal');
    const submit = form.querySelector('.m-foot .btn:last-child');
    type(form.querySelector('[name="confirmation"]'), 'delete');
    type(form.querySelector('[name="password"]'), ADMIN_PASSWORD);
    submit.click();
    await flush(50);
    assert.equal(spa.callsTo(`/admin/users/${c.user.id}/purge`, 'DELETE').length, 0);
    type(form.querySelector('[name="confirmation"]'), 'DELETE');
    type(form.querySelector('[name="password"]'), 'wrong');
    submit.click();
    await until(() => form.querySelector('#fm-err-password').textContent);
    assert.match(form.querySelector('#fm-err-password').textContent, /Incorrect admin password/);
    assert.ok(await w.store.get('candidates', c.cand.id));
    type(form.querySelector('[name="password"]'), ADMIN_PASSWORD);
    submit.click();
    await until(async () => !await w.store.get('candidates', c.cand.id));
    assert.equal(await w.store.get('candidates', c.cand.id), null);
    assert.equal(await w.store.get('users', c.user.id), null);
  } finally { spa.teardown(); }
});

test('candidate detail offers full deletion separately from protected Delete; cancelling the preview changes nothing', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('cancel.deletion');
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.candidateDetailView(spa.view, { id: c.cand.id });
    assert.ok(spa.view.querySelector('#del'));
    spa.view.querySelector('#purge-person').click();
    await flush(100);
    const dialog = spa.document.querySelector('.modal');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await flush(30);
    assert.ok(await w.store.get('candidates', c.cand.id));
    assert.equal(spa.callsTo(`/admin/candidates/${c.cand.id}/purge`, 'DELETE').length, 0);
  } finally { spa.teardown(); }
});
