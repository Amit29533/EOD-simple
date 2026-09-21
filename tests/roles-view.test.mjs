import { test } from 'node:test';
import assert from 'node:assert/strict';
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

/**
 * Roles & frameworks and the Question Bank must surface a published track the
 * workspace does not have yet — and add it on request — instead of leaving the
 * admin to wonder why a track that is listed on one screen is missing from the
 * other.
 */

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function setupDom(hash = '#/roles') {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
    { url: `http://localhost:3000/${hash}`, pretendToBeVisual: true },
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

const RSA = { id: 'role-rsa', key: 'databricks-rsa', name: 'Resident Solutions Architect (RSA)', technology: 'Databricks', active: true, competency_count: 7, question_count: 115, assessment_count: 2 };
const AIBI = { id: 'role-aibi', key: 'databricks-ai-bi-genie', name: 'Senior Databricks AI/BI & Genie Consultant', technology: 'Databricks', active: true, competency_count: 10, question_count: 100, assessment_count: 0 };

const TRACKS_BEFORE = [
  { role_key: 'databricks-rsa', role_name: RSA.name, technology: 'Databricks', competency_total: 7, catalogue_total: 115, authoring_only: false, installed: true, active: true, role: { id: RSA.id, key: RSA.key, name: RSA.name, active: true }, bank_total: 115, missing: 0 },
  { role_key: 'databricks-ai-bi-genie', role_name: AIBI.name, technology: 'Databricks', competency_total: 10, catalogue_total: 100, authoring_only: false, installed: false, active: false, role: null, bank_total: 0, missing: 100 },
  { role_key: 'senior-consultant', role_name: 'Senior Consultant', technology: 'Databricks', competency_total: 7, catalogue_total: 0, authoring_only: true, installed: false, active: false, role: null, bank_total: 0, missing: 0 },
];

function stubFetch({ sent = [], installFails = false } = {}) {
  let installed = false;
  return async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const parse = () => { try { return JSON.parse(opts.body || '{}'); } catch { return {}; } };
    if (url.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Admin', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/admin/content/tracks') && (opts.method || 'GET') === 'POST') {
      sent.push({ url, body: parse() });
      if (installFails) return json({ error: 'The Senior Databricks AI/BI & Genie Consultant track is already in this workspace but deactivated. Reactivate it under Roles & frameworks instead of adding a second copy.' }, 409);
      installed = true;
      return json({ created: true, added: 100, repaired: 0, competencies_added: 10, bank_total: 100, role_id: AIBI.id, role: { id: AIBI.id, key: AIBI.key, name: AIBI.name, active: true } }, 201);
    }
    if (url.includes('/admin/content/tracks')) {
      return json({ tracks: installed
        ? TRACKS_BEFORE.map((t) => (t.role_key === AIBI.key ? { ...t, installed: true, active: true, role: { id: AIBI.id, key: AIBI.key, name: AIBI.name, active: true }, bank_total: 100, missing: 0 } : t))
        : TRACKS_BEFORE });
    }
    if (url.includes('/admin/roles')) return json({ roles: installed ? [RSA, AIBI] : [RSA] });
    if (url.includes('/admin/content/catalogue')) {
      const key = new URL(url, 'http://localhost').searchParams.get('role_key');
      if (key === AIBI.key && !installed) {
        return json({ available: false, catalogue_total: 100, role_key: AIBI.key, role_name: AIBI.name, competency_total: 10, installable: true, inactive_role: null });
      }
      return json({ available: false });
    }
    if (url.includes('/admin/questions')) return json({ questions: [] });
    if (url.includes('/question-bank/modules')) {
      return json({
        version: '1.1', role_key: AIBI.key, role_name: AIBI.name,
        blueprint: { technical_objective: 30, technical_open: 10, non_technical_open: 10, total: 50 },
        groups: [{ key: 'technical', name: 'Technical', order: 1 }],
        modules: [{ key: 'G01', name: 'Genie Space Design', group: 'technical', order: 11, technical: true, objective: 6, open: 4, optional: 0, families: [] }],
        bank_total: 100, family_total: 10, optional: { total: 0, modules: [] },
      });
    }
    if (url.includes('/question-bank/plan')) return json({ ready: true, modules: [] });
    return json({});
  };
}

async function render(viewName, overrides) {
  globalThis.fetch = stubFetch(overrides);
  localStorage.setItem('ecod.token', 'test-token');
  const { state } = await import('../public/js/app.js');
  state.meta = {
    pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [],
    defaultModuleBankRoleKey: 'databricks-rsa',
    moduleBanks: [
      { role_key: 'databricks-rsa', role_name: RSA.name, version: '1.4' },
      { role_key: 'databricks-ai-bi-genie', role_name: AIBI.name, version: '1.1' },
    ],
  };
  const admin = await import('../public/js/views/admin.js');
  const view = document.getElementById('view');
  await admin[viewName](view);
  await flush(20);
  return view;
}

test('Roles & frameworks lists the published tracks the workspace is missing', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await render('rolesView');
    const card = view.querySelector('#published-tracks');
    assert.ok(card, 'the published-tracks card renders');
    assert.match(card.textContent, /Published tracks/);
    assert.match(card.textContent, /1 of 3 installed/);
    // Installed track: no install button, a Configure link.
    assert.match(card.textContent, /Resident Solutions Architect/);
    assert.ok(card.querySelector(`a[href="#/roles/${RSA.id}"]`), 'the installed track links to its configuration');
    // Missing tracks: an install button each, addressed by role key.
    const buttons = [...card.querySelectorAll('[data-install-track]')];
    assert.deepEqual(buttons.map((b) => b.dataset.installTrack), ['databricks-ai-bi-genie', 'senior-consultant']);
    assert.ok(buttons.every((b) => /Add to workspace/.test(b.textContent)));
    assert.match(card.textContent, /100 published questions/);
    assert.match(card.textContent, /no published questions yet/, 'the authoring-only track says so');
    // The roles table itself still only holds what the workspace has.
    assert.equal(view.querySelectorAll('.table-card tbody tr').length, 1);
  } finally { teardown(dom); }
});

test('adding a published track posts its key and the track joins the roles table', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = await render('rolesView', { sent });
    const btn = view.querySelector('[data-install-track="databricks-ai-bi-genie"]');
    btn.click();
    await flush(60);
    assert.equal(sent.length, 1, 'one install request');
    assert.ok(sent[0].url.endsWith('/admin/content/tracks'));
    assert.deepEqual(sent[0].body, { role_key: 'databricks-ai-bi-genie' });

    const rows = [...view.querySelectorAll('.table-card tbody tr')];
    assert.equal(rows.length, 2, 'the roles table re-rendered with the new track');
    assert.match(rows[1].textContent, /Senior Databricks AI\/BI & Genie Consultant/);
    assert.match(rows[1].textContent, /100/);
    const card = view.querySelector('#published-tracks');
    assert.match(card.textContent, /2 of 3 installed/);
    assert.deepEqual([...card.querySelectorAll('[data-install-track]')].map((b) => b.dataset.installTrack), ['senior-consultant']);
    const toast = document.querySelector('#toast-root');
    assert.match(toast.textContent, /added/i);
  } finally { teardown(dom); }
});

test('a refused install is reported and the screen recovers', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = await render('rolesView', { sent, installFails: true });
    view.querySelector('[data-install-track="databricks-ai-bi-genie"]').click();
    await flush(60);
    assert.equal(sent.length, 1);
    assert.match(document.querySelector('#toast-root').textContent, /deactivated/);
    const btn = view.querySelector('[data-install-track="databricks-ai-bi-genie"]');
    assert.ok(btn && !btn.disabled, 'the button is usable again after the re-render');
  } finally { teardown(dom); }
});

test('the Question bank offers to add a browsed track that is not in the workspace', { skip: SKIP }, async () => {
  const dom = setupDom('#/modules?bank=databricks-ai-bi-genie');
  try {
    const sent = [];
    const view = await render('modulesView', { sent });
    // The selector stays on the browsed bank instead of snapping back to RSA.
    assert.equal(view.querySelector('#mv-bank').value, 'databricks-ai-bi-genie');
    const strip = view.querySelector('#track-install');
    assert.ok(strip, 'the install strip renders for an uninstalled published track');
    assert.match(strip.textContent, /is not in this workspace yet/);
    assert.match(strip.textContent, /10 competencies/);
    assert.match(strip.textContent, /100 published questions/);

    strip.querySelector('#track-install-btn').click();
    await flush(60);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { role_key: 'databricks-ai-bi-genie' });
    assert.equal(location.hash, `#/modules?role=${AIBI.id}`, 'the screen is re-addressed by the new role');
  } finally { teardown(dom); }
});

test('the Question bank shows no install strip for an installed track', { skip: SKIP }, async () => {
  const dom = setupDom('#/modules');
  try {
    const view = await render('modulesView');
    assert.equal(view.querySelector('#track-install'), null);
    assert.equal(view.querySelector('#track-inactive'), null);
  } finally { teardown(dom); }
});
