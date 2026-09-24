/**
 * Form dialogs keep what the admin typed when a save is refused.
 *
 * Every admin form (candidates, tracks, competencies, roles, users, password
 * resets, the delete confirmation, assessor reassignment) used to close BEFORE
 * calling the API. A refusal such as a taken username, a wrong password or a
 * server rule then appeared as a toast over a closed form, and the admin typed
 * everything again. With `onSubmit`, formModal owns the save. It stays open and
 * busy while saving and shows a refusal against the field it names, or in a
 * banner. It closes only once the save succeeds.
 */
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settledWithin = (promise, ms = 150) => Promise.race([
  promise.then((value) => ({ settled: true, value })),
  new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
]);

const dialog = (spa) => spa.document.querySelector('#modal-root .modal');
const submitBtn = (spa) => dialog(spa).querySelector('.m-foot .btn:last-child');
const cancelBtn = (spa) => dialog(spa).querySelector('.m-foot .btn:first-child');
const input = (spa, name) => dialog(spa).querySelector(`[name="${name}"]`);
const fieldError = (spa, name) => dialog(spa).querySelector(`#fm-err-${name}`);
const banner = (spa) => dialog(spa).querySelector('.form-err');
const toasts = (spa) => spa.document.getElementById('toast-root').textContent;
const pressEscape = (spa) => spa.document.dispatchEvent(new spa.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

const USER_FIELDS = [
  { name: 'username', label: 'Username', required: true },
  { name: 'name', label: 'Full name', required: true },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'role', label: 'Role', type: 'select', allowEmpty: false, options: ['assessor', 'candidate'].map((r) => ({ value: r, label: r })) },
  { name: 'password', label: 'Password', type: 'password', required: true },
  { name: 'candidate_id', label: 'Linked candidate (required for candidate role)', type: 'select', options: [{ value: 'c1', label: 'Asha Menon' }] },
];
const fillUser = (spa) => {
  type(input(spa, 'username'), 'asha.menon');
  type(input(spa, 'name'), 'Asha Menon');
  type(input(spa, 'password'), 'Candidate-pass-1');
  type(input(spa, 'role'), 'candidate');
  type(input(spa, 'candidate_id'), 'c1');
};

test('while a save runs the dialog stays open and busy, and a second click or Enter does not save twice', { skip: SKIP }, async () => {
  const spa = await bootSpa();
  try {
    const { formModal } = await import('../public/js/ui.js');
    const save = deferred();
    let saves = 0;
    const flow = formModal({
      title: 'Create user', fields: USER_FIELDS, submitLabel: 'Create',
      onSubmit: () => { saves += 1; return save.promise; },
    });
    await flush(30);
    fillUser(spa);
    submitBtn(spa).click();
    await flush(10);

    assert.equal(saves, 1);
    assert.ok(dialog(spa), 'the dialog stays open while saving');
    assert.equal(submitBtn(spa).disabled, true);
    assert.equal(submitBtn(spa).textContent, 'Saving…');
    assert.equal(cancelBtn(spa).disabled, true);
    assert.equal(dialog(spa).querySelector('#fm-form').getAttribute('aria-busy'), 'true');

    submitBtn(spa).dispatchEvent(new spa.window.MouseEvent('click', { bubbles: true }));
    input(spa, 'username').dispatchEvent(new spa.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush(10);
    assert.equal(saves, 1, 'no second save while the first is in flight');

    save.resolve({ id: 'u1', username: 'asha.menon' });
    assert.deepEqual(await flow, { id: 'u1', username: 'asha.menon' }, 'resolves with what the save returned');
    assert.equal(dialog(spa), null, 'closes once the save lands');
  } finally { spa.teardown(); }
});

test('a refusal keeps every value, and its message goes on the field it names, or into a banner', { skip: SKIP }, async () => {
  const spa = await bootSpa();
  try {
    const { formModal } = await import('../public/js/ui.js');
    const refusals = [
      // Real server messages for the create-user form.
      ['Username already exists.', 'username'],
      ['Username must be 3+ chars: a-z 0-9 . _ -', 'username'],
      ['That candidate already has a portal user.', 'candidate_id'],
      ['Linked candidate not found.', 'candidate_id'],
      ['Password must be at least 8 characters.', 'password'],
      ['Role must be one of: admin, assessor, candidate', 'role'],
      ['User name is required.', 'name'],
      ['The storage service is unavailable. Try again shortly.', null],
    ];
    for (const [message, expected] of refusals) {
      const flow = formModal({
        title: 'Create user', fields: USER_FIELDS, submitLabel: 'Create',
        onSubmit: () => Promise.reject(Object.assign(new Error(message), { status: 409 })),
      });
      await flush(30);
      fillUser(spa);
      submitBtn(spa).click();
      await flush(20);

      assert.ok(dialog(spa), `${message}: the dialog stays open`);
      assert.equal(input(spa, 'username').value, 'asha.menon', `${message}: typed values survive`);
      assert.equal(input(spa, 'password').value, 'Candidate-pass-1');
      assert.equal(input(spa, 'candidate_id').value, 'c1');
      assert.equal(submitBtn(spa).disabled, false, `${message}: the form can be submitted again`);
      assert.equal(submitBtn(spa).textContent, 'Create');
      assert.equal(cancelBtn(spa).disabled, false);
      const marked = USER_FIELDS.map((f) => f.name).filter((n) => input(spa, n).getAttribute('aria-invalid') === 'true');
      if (expected) {
        assert.deepEqual(marked, [expected], `${message}: marks ${expected}`);
        assert.equal(fieldError(spa, expected).hidden, false);
        assert.equal(fieldError(spa, expected).textContent, message);
        assert.equal(banner(spa).hidden, true, `${message}: no banner as well`);
        assert.equal(spa.document.activeElement, input(spa, expected), `${message}: focus moves to the field`);
      } else {
        assert.deepEqual(marked, [], `${message}: names no field, so marks none`);
        assert.equal(banner(spa).hidden, false);
        assert.equal(banner(spa).textContent, message);
        assert.equal(spa.document.activeElement, banner(spa), 'focus moves to the banner');
      }
      cancelBtn(spa).click();
      assert.equal(await flow, null, `${message}: Cancel afterwards still reports cancelled`);
    }

    // An error can also name its field outright, whatever the wording.
    const flow = formModal({
      title: 'Create user', fields: USER_FIELDS,
      onSubmit: () => { throw Object.assign(new Error('Pick one first.'), { field: 'candidate_id' }); },
    });
    await flush(30);
    fillUser(spa);
    submitBtn(spa).click();
    await flush(20);
    assert.equal(fieldError(spa, 'candidate_id').textContent, 'Pick one first.');
    type(input(spa, 'candidate_id'), 'c1');
    assert.equal(fieldError(spa, 'candidate_id').hidden, true, 'changing the field clears its error');
    cancelBtn(spa).click();
    await flow;
  } finally { spa.teardown(); }
});

test('closing the dialog mid-save still reports a save that lands, and a failed one as a toast', { skip: SKIP }, async () => {
  const spa = await bootSpa();
  try {
    const { formModal } = await import('../public/js/ui.js');

    const landed = deferred();
    const flow = formModal({ title: 'Create user', fields: USER_FIELDS, onSubmit: () => landed.promise });
    await flush(30);
    fillUser(spa);
    submitBtn(spa).click();
    await flush(10);
    pressEscape(spa);
    await flush(10);
    assert.equal(dialog(spa), null, 'Escape still closes the dialog mid-save');
    assert.equal((await settledWithin(flow)).settled, false, 'not reported as cancelled while the save runs');
    landed.resolve({ id: 'u2' });
    assert.deepEqual(await flow, { id: 'u2' }, 'the caller still learns the save landed');

    const failed = deferred();
    const flow2 = formModal({ title: 'Create user', fields: USER_FIELDS, onSubmit: () => failed.promise });
    await flush(30);
    fillUser(spa);
    submitBtn(spa).click();
    await flush(10);
    pressEscape(spa);
    failed.reject(new Error('Username already exists.'));
    assert.equal(await flow2, null);
    assert.match(toasts(spa), /Username already exists\./, 'with no dialog left, the refusal is a toast');

    // A session that ended mid-save: the app is back on the sign-in page, so
    // the dialog closes instead of lingering over it.
    const flow3 = formModal({
      title: 'Create user', fields: USER_FIELDS,
      onSubmit: () => Promise.reject(Object.assign(new Error('Sign in required'), { status: 401 })),
    });
    await flush(30);
    fillUser(spa);
    submitBtn(spa).click();
    assert.equal(await flow3, null);
    assert.equal(dialog(spa), null);
  } finally { spa.teardown(); }
});

test('without onSubmit nothing changes: the values come back and the dialog closes at once', { skip: SKIP }, async () => {
  const spa = await bootSpa();
  try {
    const { formModal } = await import('../public/js/ui.js');
    const flow = formModal({ title: 'Create user', fields: USER_FIELDS });
    await flush(30);
    fillUser(spa);
    submitBtn(spa).click();
    const out = await flow;
    assert.equal(out.username, 'asha.menon');
    assert.equal(out.candidate_id, 'c1');
    assert.equal(dialog(spa), null);
  } finally { spa.teardown(); }
});

test('Users: a taken username keeps the form open with the message on Username; fixing it creates the user', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  await w.assessorUser('taken.name');
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.usersView(spa.view);
    spa.view.querySelector('#add-user').click();
    await flush(60);
    const form = dialog(spa);
    type(input(spa, 'username'), 'taken.name');
    type(input(spa, 'name'), 'Ravi Kulkarni');
    type(input(spa, 'password'), 'Assessor-pass-123');
    submitBtn(spa).click();
    await flush(200);

    assert.equal(dialog(spa), form, 'the same dialog is still open');
    assert.equal(fieldError(spa, 'username').textContent, 'Username already exists.');
    assert.equal(input(spa, 'name').value, 'Ravi Kulkarni');
    assert.equal(input(spa, 'password').value, 'Assessor-pass-123');
    assert.doesNotMatch(toasts(spa), /created/);

    type(input(spa, 'username'), 'ravi.kulkarni');
    assert.equal(fieldError(spa, 'username').hidden, true, 'typing clears the error');
    submitBtn(spa).click();
    await flush(250);

    assert.equal(dialog(spa), null, 'closes once the user is created');
    assert.match(toasts(spa), /User "ravi\.kulkarni" created/);
    assert.equal(spa.callsTo('/admin/users', 'POST').length, 2, 'one refused save, one that landed');
    assert.match(spa.view.textContent, /ravi\.kulkarni/, 'the list shows the new user');
    const users = await w.store.list('users');
    assert.equal(users.filter((u) => u.username === 'taken.name').length, 1);
    assert.equal(users.filter((u) => u.username === 'ravi.kulkarni').length, 1);
  } finally { spa.teardown(); }
});

test('Delete candidate: a wrong password can be retyped; a finalized report is refused in a banner', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { user: assessor, token: assessorToken } = await w.assessorUser('del.assessor');
  const plain = await w.candidateUser('plain.cand', { allocate: false, name: 'Plain Candidate' });
  const reported = await w.candidateUser('reported.cand', { name: 'Reported Candidate' });
  await w.walkAndSubmit(reported.token, reported.assessmentId);
  await w.assign(reported.assessmentId, assessor.id);
  await w.scoreAndFinalize(assessorToken, reported.assessmentId);

  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    const openDelete = async (cand) => {
      await admin.candidatesView(spa.view);
      spa.view.querySelector(`button[data-act="del"][data-id="${cand.id}"]`).click();
      await flush(40);
      submitBtn(spa).click(); // "Continue" in the confirmation
      await flush(40);
      assert.ok(input(spa, 'password'), 'the password dialog is open');
    };

    await openDelete(plain.cand);
    type(input(spa, 'password'), 'not-my-password');
    submitBtn(spa).click();
    await flush(250);
    assert.ok(dialog(spa), 'a wrong password keeps the dialog');
    assert.equal(fieldError(spa, 'password').textContent, 'Incorrect admin password — deletion cancelled.');
    assert.ok(await w.store.get('candidates', plain.cand.id), 'nothing deleted yet');
    type(input(spa, 'password'), ADMIN_PASSWORD);
    submitBtn(spa).click();
    await flush(300);
    assert.equal(dialog(spa), null);
    assert.match(toasts(spa), /Candidate "Plain Candidate" deleted/);
    assert.equal(await w.store.get('candidates', plain.cand.id), null);

    await openDelete(reported.cand);
    type(input(spa, 'password'), ADMIN_PASSWORD);
    submitBtn(spa).click();
    await flush(300);
    assert.ok(dialog(spa), 'the refusal keeps the dialog');
    assert.equal(banner(spa).hidden, false);
    assert.equal(banner(spa).textContent, 'This candidate has finalized assessment reports and cannot be deleted.');
    assert.notEqual(input(spa, 'password').getAttribute('aria-invalid'), 'true', 'the password was right: not marked');
    cancelBtn(spa).click();
    await flush(20);
    assert.ok(await w.store.get('candidates', reported.cand.id), 'the protected candidate remains');
  } finally { spa.teardown(); }
});

test('under the real stylesheet, empty error slots stay hidden and the banner shows only with a message', { skip: SKIP }, async () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  // In a browser, any class that sets `display` beats the hidden attribute,
  // whatever its specificity. .field-err is flex, so every form drew an empty
  // "!" badge under each field. jsdom only lets a MORE specific rule win, so it
  // sees part of that. The global rule is pinned here as well.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  const spa = await bootSpa();
  try {
    const style = spa.document.createElement('style');
    style.textContent = css;
    spa.document.head.appendChild(style);
    const { formModal } = await import('../public/js/ui.js');
    const flow = formModal({
      title: 'Create user', fields: USER_FIELDS,
      onSubmit: () => Promise.reject(new Error('The storage service is unavailable. Try again shortly.')),
    });
    await flush(30);
    const drawnWhileHidden = () => [...dialog(spa).querySelectorAll('[hidden]')]
      .filter((el) => spa.window.getComputedStyle(el).display !== 'none')
      .map((el) => el.id || el.className);
    assert.equal(dialog(spa).querySelectorAll('.field-err[hidden]').length, USER_FIELDS.length);
    assert.deepEqual(drawnWhileHidden(), [], 'no empty error badge is drawn');

    fillUser(spa);
    submitBtn(spa).click();
    await flush(20);
    assert.notEqual(spa.window.getComputedStyle(banner(spa)).display, 'none', 'the banner shows once it has a message');
    assert.deepEqual(drawnWhileHidden(), []);
    cancelBtn(spa).click();
    await flow;
  } finally { spa.teardown(); }
});
