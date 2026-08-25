/**
 * Allocation modal test: drives the real admin allocation dialog in jsdom to
 * prove an admin can cap an assessment at X questions, see the weighted split
 * preview, and that the chosen count reaches the API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const ROLE = { id: 'role-1', name: 'RSA', question_count: 21, active: true };
const COMPS = [
  { competency_id: 'c1', name: 'Architecture', weight: 60 },
  { competency_id: 'c2', name: 'Advisory', weight: 40 },
];

function setupDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="sidebar"></div><div id="topbar"></div><main id="view"></main>
       <div id="modal-root"></div><div id="toast-root"></div></body></html>`,
    { url: 'http://localhost:3000/', pretendToBeVisual: true },
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

/** Stub API: roles/users plus the question-plan endpoint the modal polls. */
function stubFetch(posted) {
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('/admin/roles/') && url.includes('/question-plan')) {
      const limit = Number(new URL(url, 'http://x').searchParams.get('limit')) || 21;
      const n = Math.min(limit, 21);
      const c1 = Math.round(n * 0.6);
      return json({ role: { id: ROLE.id, name: ROLE.name }, total: n, bank_total: 21, points: n * 4,
        per_competency: [{ ...COMPS[0], count: c1 }, { ...COMPS[1], count: n - c1 }] });
    }
    if (url.includes('/admin/roles')) return json({ roles: [ROLE] });
    if (url.includes('/admin/users')) return json({ users: [{ id: 'u1', name: 'Priya Nair', role: 'assessor', active: true }] });
    if (url.includes('/admin/assessments') && opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: 'a1' }) };
    }
    return json({});
  };
}

async function openModal() {
  const admin = await import(`../public/js/views/admin.js?t=${Date.now()}`);
  const state = (await import(`../public/js/app.js?t=${Date.now()}`)).state;
  state.meta = { pipelineStages: [], assessmentStatuses: [], questionTypes: [], userRoles: [], difficulties: [] };
  const done = admin.allocateAssessorModal({ id: 'cand-1', name: 'Rohit Verma' });
  await flush(80);
  return { done, modal: document.querySelector('.modal') };
}

test('allocation modal: defaults to the full bank and previews the split', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    stubFetch([]);
    const { modal } = await openModal();
    assert.ok(modal, 'modal opened');
    assert.match(modal.querySelector('.m-head h3').textContent, /Allocate assessment · Rohit Verma/);

    // full bank is the default choice
    const full = modal.querySelector('.scope-opt[data-scope="all"] input');
    assert.equal(full.checked, true, 'full bank selected by default');
    assert.equal(modal.querySelector('#al-count-row').hidden, true, 'count input hidden until needed');

    const preview = modal.querySelector('#al-preview');
    assert.match(preview.textContent, /21 questions/, 'previews the full bank');
    assert.equal(preview.querySelectorAll('.alloc-split-row').length, 2, 'one row per competency');
  } finally { teardown(dom); }
});

test('allocation modal: choosing a limit previews X and posts question_count', { skip: SKIP }, async () => {
  const dom = setupDom();
  const posted = [];
  try {
    stubFetch(posted);
    const { done, modal } = await openModal();

    // switch to "limit to a set number"
    const limitRadio = modal.querySelector('.scope-opt[data-scope="limit"] input');
    limitRadio.checked = true;
    limitRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush(60);
    assert.equal(modal.querySelector('#al-count-row').hidden, false, 'count input revealed');

    // presets are offered and clicking one fills the count
    const preset = modal.querySelector('[data-preset="10"]');
    assert.ok(preset, 'a preset for 10 questions is offered');
    preset.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(80);

    assert.equal(modal.querySelector('#al-count').value, '10');
    const preview = modal.querySelector('#al-preview');
    assert.match(preview.textContent, /10 questions/, 'preview follows the chosen count');
    assert.match(preview.textContent, /of 21 in the bank/, 'still shows the bank size');
    assert.match(preview.textContent, /Weighted subset/, 'flags that this is a subset');
    const counts = [...preview.querySelectorAll('.alloc-split-count')].map((el) => Number(el.textContent));
    assert.equal(counts.reduce((a, b) => a + b, 0), 10, 'split adds up to the chosen count');
    assert.ok(counts[0] > counts[1], 'heavier competency receives more questions');

    // submit
    modal.querySelector('.m-foot .btn:last-child').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await done;
    await flush(60);

    assert.equal(posted.length, 1, 'allocation posted once');
    assert.equal(posted[0].question_count, 10, 'chosen count sent to the API');
    assert.equal(posted[0].candidate_id, 'cand-1');
    assert.equal(posted[0].role_id, ROLE.id);
    assert.equal(posted[0].assessor_id, 'u1');
  } finally { teardown(dom); }
});

test('allocation modal: full-bank submit sends no question_count', { skip: SKIP }, async () => {
  const dom = setupDom();
  const posted = [];
  try {
    stubFetch(posted);
    const { done, modal } = await openModal();
    modal.querySelector('.m-foot .btn:last-child').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await done;
    await flush(60);
    assert.equal(posted.length, 1);
    assert.ok(!('question_count' in posted[0]), 'no cap is sent when the full bank is chosen');
  } finally { teardown(dom); }
});

test('allocation modal: an invalid count is rejected before any request', { skip: SKIP }, async () => {
  const dom = setupDom();
  const posted = [];
  try {
    stubFetch(posted);
    const { modal } = await openModal();
    const limitRadio = modal.querySelector('.scope-opt[data-scope="limit"] input');
    limitRadio.checked = true;
    limitRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush(50);

    const count = modal.querySelector('#al-count');
    count.value = '0';
    count.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush(360);

    modal.querySelector('.m-foot .btn:last-child').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(60);

    assert.equal(posted.length, 0, 'nothing was allocated');
    assert.ok(document.querySelector('.modal'), 'the dialog stays open so the admin can correct it');
    assert.match(document.getElementById('toast-root').textContent, /whole number/i, 'the problem is explained');
  } finally { teardown(dom); }
});
