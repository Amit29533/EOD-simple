import { test } from 'node:test';
import assert from 'node:assert/strict';
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

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

const FAMILIES = [
  { key: 'mandatory', name: 'Mandatory', order: 0, description: 'Always served.' },
  { key: 'technical', name: 'Technical', order: 1, description: 'Platform depth.' },
  { key: 'consulting', name: 'Consulting & Client Skills', order: 2, description: 'Discovery.' },
];
const MODULES = [
  { key: 'M00', name: 'Mandatory Common Question', family: 'mandatory', order: 0, mandatory: true, technical: false, objective: 0, open: 0, optional: 0 },
  { key: 'T01', name: 'Databricks Architecture', family: 'technical', order: 11, mandatory: false, technical: true, objective: 10, open: 9, optional: 15 },
  { key: 'C01', name: 'Discovery & Requirement Structuring', family: 'consulting', order: 21, mandatory: false, technical: false, objective: 10, open: 4, optional: 0 },
];
const BLUEPRINT = { mandatory: 1, technical_objective: 30, technical_open: 10, non_technical_open: 10, total: 51 };

function stubFetch({ ready = true } = {}) {
  return async (url, opts = {}) => {
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Admin', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/question-bank/modules')) {
      return json({
        version: '1.2', blueprint: BLUEPRINT, families: FAMILIES, modules: MODULES,
        bank_total: 348, optional: { total: 115, modules: [] },
      });
    }
    if (url.includes('/question-bank/plan')) {
      return json({
        blueprint: BLUEPRINT, bank_total: 348, optional_total: 115, ready,
        modules: MODULES.map((m) => ({ module: m.key, sufficient: ready })),
      });
    }
    if (url.includes('/question-bank/preview') && (opts.method || 'GET') === 'POST') {
      return json({
        counts: { ...BLUEPRINT, from_optional: 0 },
        blueprint: BLUEPRINT,
        warnings: [],
        sections: [],
        questions: [
          { id: 'RSA-F01-002', module: 'F01', family: 'x', type: 'open', prompt: 'The mandatory common question?', mandatory: true, optional: false },
          { id: 'RSA-T01-011', module: 'T01', family: 'y', type: 'objective', prompt: 'A technical objective question?', mandatory: false, optional: false },
        ],
      });
    }
    return json({});
  };
}

async function renderModules(overrides) {
  globalThis.fetch = stubFetch(overrides);
  localStorage.setItem('ecod.token', 'test-token');
  const { state } = await import('../public/js/app.js');
  state.meta = {
    pipelineStages: [], assessmentStatuses: [], userRoles: [],
    questionTypes: [], difficulties: [],
  };
  const admin = await import('../public/js/views/admin.js');
  const view = document.getElementById('view');
  await admin.modulesView(view);
  await flush(20);
  return view;
}

test('modules view groups every module under its family', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const families = [...view.querySelectorAll('.module-family')];
    assert.equal(families.length, 3, 'one card per family that has modules');
    const headings = families.map((f) => f.querySelector('h2').textContent);
    assert.deepEqual(headings, ['Mandatory', 'Technical', 'Consulting & Client Skills']);
  } finally { teardown(dom); }
});

test('modules view states the 51-question blueprint', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const strip = view.querySelector('.blueprint-strip');
    assert.ok(strip, 'blueprint strip rendered');
    const text = strip.textContent.replace(/\s+/g, ' ');
    assert.match(text, /Every generated test contains 51 questions/);
    assert.match(text, /30 technical objective/);
    assert.match(text, /10 non-technical open/);
  } finally { teardown(dom); }
});

test('each module shows what it contributes to a paper', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const text = view.textContent.replace(/\s+/g, ' ');
    assert.match(text, /3 objective \+ 1 open/, 'technical quota shown');
    assert.match(text, /Always served/, 'mandatory module marked');
    assert.ok(view.querySelector('.chip-mandatory'), 'mandatory chip present');
  } finally { teardown(dom); }
});

test('the optional pool is surfaced but marked as fallback', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const text = view.textContent.replace(/\s+/g, ' ');
    assert.match(text, /115 questions/);
    assert.match(text, /never served while a module can fill its quota/);
    assert.ok(view.querySelector('.chip-optional'), 'optional chip present');
  } finally { teardown(dom); }
});

test('a short module is flagged instead of silently shown as ready', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules({ ready: false });
    assert.match(view.textContent, /Some modules are short/);
  } finally { teardown(dom); }
});

test('previewing a test opens a dialog listing the generated paper', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    view.querySelector('#mv-preview').click();
    await flush(60);

    const dialog = document.querySelector('#modal-root .modal');
    assert.ok(dialog, 'preview dialog opened');
    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /Sample generated test/);
    assert.match(text, /51 questions/);
    assert.match(text, /The mandatory common question\?/);
    assert.ok(dialog.querySelector('.chip-mandatory'), 'mandatory item is tagged in the paper');
  } finally { teardown(dom); }
});
