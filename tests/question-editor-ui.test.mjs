/**
 * Question Editor Modal UI unit tests.
 *
 * Verifies:
 *  - Option labels and selections are retained when adding options in questionEditorModal
 *  - Option labels and selections are retained when deleting options in questionEditorModal
 *  - Switching question type retains typed options and syncs correctly
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM, SKIP } from './helpers/jsdom.mjs';

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function setupDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
    { url: 'http://localhost:3000/#/modules', pretendToBeVisual: true },
  );
  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HashChangeEvent: window.HashChangeEvent,
  });
  return dom;
}

function teardown(dom) {
  dom.window.close();
  for (const k of ['window', 'document', 'location', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'fetch']) delete globalThis[k];
}

function stubFetch() {
  return async (url) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Admin', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/admin/roles/')) {
      return json({
        role: { id: 'role-1', name: 'Resident Solutions Architect (RSA)', technology: 'Databricks' },
        competencies: [{ id: 'comp-1', name: 'Lakehouse Architecture', active: true }],
      });
    }
    if (url.includes('/admin/roles')) {
      return json({ roles: [{ id: 'role-1', name: 'Resident Solutions Architect (RSA)', technology: 'Databricks' }] });
    }
    if (url.includes('/admin/questions')) {
      return json({
        questions: [
          { id: 'q-mcq', type: 'mcq_single', prompt: 'A served MCQ?', competency_name: 'Lakehouse Architecture', points: 4, difficulty: 'intermediate', active: true, audio_required: false },
        ],
      });
    }
    if (url.includes('/admin/content/catalogue')) return json({ available: false });
    if (url.includes('/question-bank/modules')) {
      return json({ version: '1.2', blueprint: {}, groups: [], modules: [], bank_total: 0, family_total: 0, optional: { total: 0, modules: [] } });
    }
    if (url.includes('/question-bank/plan')) {
      return json({ blueprint: {}, bank_total: 0, optional_total: 0, ready: true, modules: [] });
    }
    return json({});
  };
}

async function renderModules() {
  globalThis.fetch = stubFetch();
  localStorage.setItem('ecod.token', 'test-token');
  const { state } = await import('../public/js/app.js');
  state.meta = {
    pipelineStages: [], assessmentStatuses: [], userRoles: [],
    questionTypes: [
      { key: 'mcq_single', label: 'Single Choice (MCQ)' },
      { key: 'mcq_multi', label: 'Multi-select (MCQ)' },
      { key: 'text', label: 'Open (Oral / Spoken)' },
    ],
    difficulties: ['foundation', 'intermediate', 'advanced'],
  };
  const admin = await import('../public/js/views/admin.js');
  const view = document.getElementById('view');
  await admin.modulesView(view);
  await flush(40);
  return view;
}

test('question editor preserves typed option text and selection when adding an option', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const addBtn = view.querySelector('#served-add');
    assert.ok(addBtn, 'Add question button exists');
    addBtn.click();
    await flush(60);

    const modal = document.querySelector('#modal-root .modal');
    assert.ok(modal, 'Modal is open');

    const opt0 = modal.querySelector('[data-opt-label="0"]');
    const opt1 = modal.querySelector('[data-opt-label="1"]');
    assert.ok(opt0 && opt1, 'Initial options exist');

    opt0.value = 'First Answer Option';
    opt0.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    opt1.value = 'Second Answer Option';
    opt1.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // Mark option 1 (b) as correct
    const radios = modal.querySelectorAll('input[name="qe-correct"]');
    radios[1].checked = true;
    radios[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // Click "Add option"
    const addOptBtn = modal.querySelector('#qe-add-opt');
    addOptBtn.click();
    await flush(40);

    // Verify option 0 and option 1 text still exist!
    const reOpt0 = modal.querySelector('[data-opt-label="0"]');
    const reOpt1 = modal.querySelector('[data-opt-label="1"]');
    const reOpt2 = modal.querySelector('[data-opt-label="2"]');

    assert.equal(reOpt0.value, 'First Answer Option', 'Option A text must not be wiped out');
    assert.equal(reOpt1.value, 'Second Answer Option', 'Option B text must not be wiped out');
    assert.ok(reOpt2, 'Option C was added');

    const reRadios = modal.querySelectorAll('input[name="qe-correct"]');
    assert.equal(reRadios[1].checked, true, 'Option B correct selection must be preserved');
  } finally {
    teardown(dom);
  }
});

test('question editor preserves remaining options and valid selection when deleting an option', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    view.querySelector('#served-add').click();
    await flush(60);

    const modal = document.querySelector('#modal-root .modal');

    // Add a 3rd option
    modal.querySelector('#qe-add-opt').click();
    await flush(30);

    modal.querySelector('[data-opt-label="0"]').value = 'Option A';
    modal.querySelector('[data-opt-label="0"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    modal.querySelector('[data-opt-label="1"]').value = 'Option B to delete';
    modal.querySelector('[data-opt-label="1"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    modal.querySelector('[data-opt-label="2"]').value = 'Option C';
    modal.querySelector('[data-opt-label="2"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // Select Option C as correct
    const radios = modal.querySelectorAll('input[name="qe-correct"]');
    radios[2].checked = true;
    radios[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // Delete Option B (index 1)
    const delButtons = modal.querySelectorAll('[data-opt-del]');
    delButtons[1].click();
    await flush(40);

    const remaining = [...modal.querySelectorAll('[data-opt-label]')];
    assert.equal(remaining.length, 2, 'Two options remain');
    assert.equal(remaining[0].value, 'Option A');
    assert.equal(remaining[1].value, 'Option C');

    const updatedRadios = modal.querySelectorAll('input[name="qe-correct"]');
    assert.equal(updatedRadios[1].checked, true, 'Option C remains selected as correct');
  } finally {
    teardown(dom);
  }
});

test('question editor preserves typed option text when switching to multi-select', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    view.querySelector('#served-add').click();
    await flush(60);

    const modal = document.querySelector('#modal-root .modal');

    modal.querySelector('[data-opt-label="0"]').value = 'Choice A';
    modal.querySelector('[data-opt-label="0"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    modal.querySelector('[data-opt-label="1"]').value = 'Choice B';
    modal.querySelector('[data-opt-label="1"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // Switch question type from mcq_single to mcq_multi
    const typeSelect = modal.querySelector('#qe-type');
    typeSelect.value = 'mcq_multi';
    typeSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush(40);

    assert.equal(modal.querySelector('[data-opt-label="0"]').value, 'Choice A', 'Choice A preserved on type change');
    assert.equal(modal.querySelector('[data-opt-label="1"]').value, 'Choice B', 'Choice B preserved on type change');

    const checkboxes = modal.querySelectorAll('input[name="qe-correct"]');
    assert.equal(checkboxes[0].type, 'checkbox', 'Correct inputs are now checkboxes');
  } finally {
    teardown(dom);
  }
});
