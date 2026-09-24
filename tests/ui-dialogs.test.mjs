/**
 * Dialogs answer exactly once, whichever way they are closed.
 *
 * "Allocate assessment" and the question editor wrap `modal()` in their own
 * promise. Only their Cancel button resolved it: Esc, a click on the backdrop
 * and ✕ closed the dialog and left the promise pending for good, unlike
 * formModal and confirmModal, which report "cancelled". Both dialogs also
 * closed BEFORE settling their result, so the obvious fix (resolve null on
 * close) would have turned every Allocate and Save into a silent no-op; the
 * second half of each test guards that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

const settledWithin = (promise, ms = 400) => Promise.race([
  promise.then((value) => ({ settled: true, value })),
  new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
]);

const DISMISSALS = {
  Esc: (spa) => spa.document.dispatchEvent(new spa.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  backdrop: (spa) => {
    const backdrop = spa.document.querySelector('#modal-root .backdrop');
    backdrop.dispatchEvent(new spa.window.MouseEvent('mousedown', { bubbles: true }));
  },
  '✕': (spa) => spa.document.querySelector('#modal-root [data-x]').click(),
};

test('allocate dialog: Esc, the backdrop and ✕ each end the flow and allocate nothing', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  await w.assessorUser('dialog.assessor');
  const { cand } = await w.candidateUser('dialog.cand', { allocate: false });
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    for (const [how, dismiss] of Object.entries(DISMISSALS)) {
      const flow = admin.allocateAssessorModal(cand);
      await flush(80);
      assert.ok(spa.document.querySelector('#modal-root .modal'), `${how}: the dialog opened`);
      dismiss(spa);
      await flush(20);
      assert.equal(spa.document.querySelector('#modal-root .modal'), null, `${how}: the dialog closed`);
      const outcome = await settledWithin(flow);
      assert.equal(outcome.settled, true, `${how}: the allocate flow finished instead of waiting forever`);
    }
    assert.equal(spa.callsTo('/admin/assessments', 'POST').length, 0, 'nothing was allocated');
    assert.equal((await w.store.list('assessments', { candidate_id: cand.id })).length, 0);
  } finally { spa.teardown(); }
});

test('allocate dialog: Allocate still allocates, with the assessor chosen in the dialog', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  await w.assessorUser('first.assessor');
  const { user: second } = await w.assessorUser('second.assessor');
  const { cand } = await w.candidateUser('alloc.cand', { allocate: false });
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    const flow = admin.allocateAssessorModal(cand);
    await flush(120);
    type(spa.document.querySelector('#al-assessor'), second.id);
    spa.document.querySelector('#modal-root .m-foot .btn:last-child').click();
    const outcome = await settledWithin(flow, 2000);
    assert.equal(outcome.settled, true);
    const papers = await w.store.list('assessments', { candidate_id: cand.id });
    assert.equal(papers.length, 1, 'the paper was allocated');
    assert.equal(papers[0].assessor_id, second.id, 'to the assessor picked in the dialog');
  } finally { spa.teardown(); }
});

test('question editor: Esc, the backdrop and ✕ resolve null; Save resolves the question', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const competencies = await w.store.list('competencies');
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    for (const [how, dismiss] of Object.entries(DISMISSALS)) {
      const editor = admin.questionEditorModal(null, competencies);
      await flush(40);
      dismiss(spa);
      const outcome = await settledWithin(editor);
      assert.deepEqual(outcome, { settled: true, value: null }, `${how}: the editor reports "cancelled"`);
    }

    const editor = admin.questionEditorModal(null, competencies);
    await flush(40);
    const root = spa.document.querySelector('#modal-root');
    type(root.querySelector('#qe-type'), 'text');
    await flush(20);
    type(root.querySelector('#qe-prompt'), 'Walk us through a migration you led.');
    type(root.querySelector('#qe-rubric'), 'Names the risks and the rollback.');
    root.querySelector('.m-foot .btn:last-child').click();
    const saved = await settledWithin(editor);
    assert.equal(saved.settled, true);
    assert.ok(saved.value, 'Save resolves the question, not null');
    assert.equal(saved.value.prompt, 'Walk us through a migration you led.');
    assert.equal(saved.value.type, 'text');
  } finally { spa.teardown(); }
});

test('question editor on the Modules screen: Save still creates the question on the server', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const role = (await w.store.list('roles'))[0];
  const before = (await w.store.list('questions', { role_id: role.id })).length;
  const spa = await bootSpa({ hash: `#/modules?role=${role.id}`, backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.modulesView(spa.view);
    await flush(60);
    const add = spa.view.querySelector('#served-add');
    assert.ok(add, 'the Modules screen offers Add question');
    add.click();
    await flush(120);
    const root = spa.document.querySelector('#modal-root');
    type(root.querySelector('#qe-type'), 'text');
    await flush(20);
    type(root.querySelector('#qe-prompt'), 'Describe a cost optimisation you delivered.');
    type(root.querySelector('#qe-rubric'), 'Quantifies the saving.');
    root.querySelector('.m-foot .btn:last-child').click();
    await flush(250);
    const after = await w.store.list('questions', { role_id: role.id });
    assert.equal(after.length, before + 1, 'the question was saved');
    assert.ok(after.some((q) => q.prompt === 'Describe a cost optimisation you delivered.'));
  } finally { spa.teardown(); }
});
