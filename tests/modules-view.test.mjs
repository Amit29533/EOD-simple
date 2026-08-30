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

const GROUPS = [
  { key: 'technical', name: 'Technical', order: 1, description: 'Platform depth.' },
  { key: 'consulting', name: 'Consulting & Client Skills', order: 2, description: 'Discovery.' },
];
const MODULES = [
  { key: 'T01', name: 'Databricks Architecture', group: 'technical', order: 11, technical: true, objective: 10, open: 9, optional: 15,
    families: [
      { id: 'T01:advanced-technical-judgment', key: 'advanced-technical-judgment', name: 'Advanced Technical Judgment', role: 'objective', objective: 10, open: 0, optional: 0 },
      { id: 'T01:modern-databricks-architecture', key: 'modern-databricks-architecture', name: 'Modern Databricks Architecture', role: 'open', objective: 0, open: 3, optional: 15 },
    ] },
  { key: 'C01', name: 'Discovery & Requirement Structuring', group: 'consulting', order: 21, technical: false, objective: 10, open: 4, optional: 0,
    families: [
      { id: 'C01:advanced-consulting-judgment', key: 'advanced-consulting-judgment', name: 'Advanced Consulting Judgment', role: 'objective', objective: 10, open: 0, optional: 0 },
    ] },
];
const BLUEPRINT = { technical_objective: 30, technical_open: 10, non_technical_open: 10, total: 50 };

function stubFetch({ ready = true, sent = [], createFails = null, importReport = null } = {}) {
  return async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const parse = () => { try { return JSON.parse(opts.body || '{}'); } catch { return {}; } };
    if (url.includes('/question-bank/questions') && (opts.method || 'GET') === 'POST') {
      sent.push({ url, body: parse() });
      if (createFails) return json({ error: 'This question is not valid.', errors: createFails }, 422);
      const b = parse();
      return json({ question: { id: 'RSA-T01-A001', module: b.module, family: b.family, type: b.type } }, 201);
    }
    if (url.includes('/question-bank/import')) {
      const b = parse();
      sent.push({ url, body: b });
      return json(importReport || {
        headers: ['module', 'type', 'prompt'], total: 3, accepted: 2, rejected: 1, duplicates: 0,
        dry_run: !!b.dry_run, imported: b.dry_run ? 0 : 2,
        errors: [{ line: 4, errors: ['Module is required.'], prompt: 'orphan row' }],
        duplicate_rows: [],
        preview: [{ line: 2, module: 'T01', family: 'Advanced Technical Judgment', type: 'objective', prompt: 'An imported question?' }],
      });
    }
    if (url.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Admin', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/question-bank/modules')) {
      return json({
        version: '1.2', blueprint: BLUEPRINT, groups: GROUPS, modules: MODULES,
        bank_total: 348, family_total: 63, optional: { total: 115, modules: [] },
      });
    }
    if (url.includes('/question-bank/plan')) {
      return json({
        blueprint: BLUEPRINT, bank_total: 348, optional_total: 115, ready,
        modules: MODULES.map((m) => ({ module: m.key, sufficient: ready })),
      });
    }
    if (url.includes('/question-bank/families/')) {
      return json({
        family: { id: 'T01:advanced-technical-judgment', key: 'advanced-technical-judgment',
          name: 'Advanced Technical Judgment', module: 'T01', role: 'objective', objective: 10, open: 0 },
        questions: [
          { id: 'RSA-T01-011', type: 'objective', prompt: 'A judgment question in this family?', optional: false, needs_option_review: false },
        ],
      });
    }
    if (url.includes('/question-bank/preview') && (opts.method || 'GET') === 'POST') {
      return json({
        counts: { ...BLUEPRINT, from_optional: 0 },
        blueprint: BLUEPRINT,
        warnings: [],
        sections: [],
        questions: [
          { id: 'RSA-F01-002', module: 'F01', family_id: 'F01:customer-solutioning', family: 'Customer Solutioning', type: 'open', prompt: 'An open F01 question?', optional: false },
          { id: 'RSA-T01-011', module: 'T01', family_id: 'T01:advanced-technical-judgment', family: 'Advanced Technical Judgment', type: 'objective', prompt: 'A technical objective question?', optional: false },
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

test('modules view lists modules at the top level', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const cards = [...view.querySelectorAll('.module-card')];
    assert.equal(cards.length, 2, 'one card per module');
    assert.deepEqual(cards.map((c) => c.dataset.module), ['T01', 'C01']);
    assert.deepEqual(
      cards.map((c) => c.querySelector('.module-key').textContent),
      ['T01', 'C01'],
    );
  } finally { teardown(dom); }
});

test('each module expands to the families inside it', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const t01 = view.querySelector('[data-module="T01"]');
    const rows = [...t01.querySelectorAll('.family-table tbody tr')];
    assert.equal(rows.length, 2, 'T01 shows both of its families');
    const text = t01.textContent.replace(/\s+/g, ' ');
    assert.match(text, /Advanced Technical Judgment/);
    assert.match(text, /Modern Databricks Architecture/);
  } finally { teardown(dom); }
});

test('families are shown with their module-scoped id', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const ids = [...view.querySelectorAll('.family-table .mono')].map((n) => n.textContent);
    assert.ok(ids.includes('T01:advanced-technical-judgment'), ids.join(','));
    assert.ok(ids.every((id) => id.includes(':')), 'every family id is module-scoped');
  } finally { teardown(dom); }
});

test('opening a family lists the questions a new one would join', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    view.querySelector('[data-family="T01:advanced-technical-judgment"]').click();
    await flush(60);
    const dialog = document.querySelector('#modal-root .modal');
    assert.ok(dialog, 'family dialog opened');
    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /T01 . Advanced Technical Judgment/);
    assert.match(text, /joins this family in module T01 only/);
    assert.match(text, /A judgment question in this family\?/);
  } finally { teardown(dom); }
});

test('modules view states the 50-question blueprint', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const strip = view.querySelector('.blueprint-strip');
    assert.ok(strip, 'blueprint strip rendered');
    const text = strip.textContent.replace(/\s+/g, ' ');
    assert.match(text, /Every generated test contains 50 questions/);
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
    assert.match(text, /Consulting & Client Skills · serves 1 open/, 'non-technical quota shown');
    assert.doesNotMatch(text, /Always served, first/, 'no mandatory module remains');
  } finally { teardown(dom); }
});

test('the optional pool is surfaced but marked as fallback', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const text = view.textContent.replace(/\s+/g, ' ');
    assert.match(text, /115 questions/);
    assert.match(text, /Never served while a family can fill its module's quota/);
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
    assert.match(text, /50 questions/);
    assert.ok(!dialog.querySelector('.chip-mandatory'), 'nothing is tagged mandatory any more');
  } finally { teardown(dom); }
});

/* ---------------------- adding a single question ---------------------- */

const openAddForm = async (view) => {
  view.querySelector('#mv-add').click();
  await flush(60);
  return document.querySelector('#modal-root .modal');
};

test('the add-question form offers every module in paper order', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const dialog = await openAddForm(view);
    assert.ok(dialog, 'add dialog opened');
    const opts = [...dialog.querySelectorAll('#aq-module option')].map((o) => o.value).filter(Boolean);
    assert.deepEqual(opts, ['T01', 'C01'], 'modules listed in blueprint order');
  } finally { teardown(dom); }
});

test('choosing a module narrows the family suggestions to that module', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const dialog = await openAddForm(view);
    const select = dialog.querySelector('#aq-module');
    select.value = 'T01';
    select.dispatchEvent(new dom.window.Event('change'));
    await flush(20);
    const names = [...dialog.querySelectorAll('#aq-family-list option')].map((o) => o.value);
    assert.deepEqual(names, ['Advanced Technical Judgment', 'Modern Databricks Architecture']);

    select.value = 'C01';
    select.dispatchEvent(new dom.window.Event('change'));
    await flush(20);
    const c01 = [...dialog.querySelectorAll('#aq-family-list option')].map((o) => o.value);
    assert.deepEqual(c01, ['Advanced Consulting Judgment'], 'suggestions follow the module');
    assert.match(dialog.querySelector('#aq-family-hint').textContent, /new family/);
  } finally { teardown(dom); }
});

test('the form shows options for objective and a rubric for open', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const dialog = await openAddForm(view);
    assert.equal(dialog.querySelector('#aq-objective').hidden, false, 'objective fields shown by default');
    assert.equal(dialog.querySelector('#aq-open').hidden, true, 'rubric hidden by default');
    assert.equal(dialog.querySelectorAll('#aq-options .opt-row').length, 4, 'four option rows');

    const type = dialog.querySelector('#aq-type');
    type.value = 'open';
    type.dispatchEvent(new dom.window.Event('change'));
    await flush(20);
    assert.equal(dialog.querySelector('#aq-objective').hidden, true, 'options hidden for an open question');
    assert.equal(dialog.querySelector('#aq-open').hidden, false, 'rubric shown for an open question');
  } finally { teardown(dom); }
});

test('option rows can be added and removed, never below two', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    const dialog = await openAddForm(view);
    const rows = () => [...dialog.querySelectorAll('#aq-options .opt-row')];

    dialog.querySelector('#aq-add-opt').click();
    await flush(10);
    assert.equal(rows().length, 5);
    assert.deepEqual(rows().map((r) => r.dataset.opt), ['A', 'B', 'C', 'D', 'E']);

    // Remove the second row; the rest must renumber so letters stay contiguous.
    rows()[1].querySelector('.opt-del').click();
    await flush(10);
    assert.deepEqual(rows().map((r) => r.dataset.opt), ['A', 'B', 'C', 'D']);
    assert.deepEqual(
      rows().map((r) => r.querySelector('.opt-letter').textContent),
      ['A', 'B', 'C', 'D'],
    );

    while (rows().length > 2) { rows().at(-1).querySelector('.opt-del').click(); await flush(5); }
    assert.equal(rows().length, 2);
    assert.ok(rows().every((r) => r.querySelector('.opt-del').disabled), 'cannot go below two options');
  } finally { teardown(dom); }
});

test('submitting posts the question the author actually filled in', { skip: SKIP }, async () => {
  const dom = setupDom();
  const sent = [];
  try {
    const view = await renderModules({ sent });
    const dialog = await openAddForm(view);
    dialog.querySelector('#aq-module').value = 'T01';
    dialog.querySelector('#aq-module').dispatchEvent(new dom.window.Event('change'));
    await flush(10);
    dialog.querySelector('#aq-family').value = 'Advanced Technical Judgment';
    dialog.querySelector('#aq-prompt').value = '  Which Unity Catalog object bounds cross-workspace sharing?  ';
    const texts = [...dialog.querySelectorAll('#aq-options .opt-text')];
    ['The cluster', 'The metastore', 'The notebook', 'The job'].forEach((t, i) => { texts[i].value = t; });
    dialog.querySelectorAll('#aq-options input[type=radio]')[1].checked = true;
    dialog.querySelector('#aq-tags').value = 'governance, unity-catalog';

    [...dialog.querySelectorAll('.m-foot .btn')].at(-1).click();
    await flush(80);

    const post = sent.find((r) => r.url.includes('/question-bank/questions'));
    assert.ok(post, 'the question was posted');
    assert.equal(post.body.module, 'T01');
    assert.equal(post.body.family, 'Advanced Technical Judgment');
    assert.equal(post.body.type, 'objective');
    assert.equal(post.body.prompt, 'Which Unity Catalog object bounds cross-workspace sharing?', 'prompt is trimmed');
    assert.equal(post.body.options.length, 4, 'blank options are dropped, filled ones kept');
    assert.deepEqual(post.body.options[1], { id: 'b', label: 'The metastore' });
    assert.deepEqual(post.body.correct_option_ids, ['b'], 'the selected option is the correct one');
  } finally { teardown(dom); }
});

test('a rejected question reports the reason against the offending field', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules({
      createFails: ['Unknown module "ZZ9".', 'An open question needs a rubric (expected evidence) for the assessor.'],
    });
    const dialog = await openAddForm(view);
    const type = dialog.querySelector('#aq-type');
    type.value = 'open';
    type.dispatchEvent(new dom.window.Event('change'));
    await flush(20);
    dialog.querySelector('#aq-prompt').value = 'A prompt long enough to pass the client.';
    [...dialog.querySelectorAll('.m-foot .btn')].at(-1).click();
    await flush(80);

    assert.ok(document.querySelector('#modal-root .modal'), 'the form stays open so the author can fix it');
    const moduleErr = dialog.querySelector('#aq-err-module');
    assert.equal(moduleErr.hidden, false, 'module error is shown');
    assert.match(moduleErr.textContent, /Unknown module/);
    // "An open question needs a rubric" mentions a question too; it must still
    // land on the rubric rather than the prompt.
    const rubricErr = dialog.querySelector('#aq-err-rubric');
    assert.equal(rubricErr.hidden, false, 'rubric error is shown');
    assert.match(rubricErr.textContent, /rubric/);
    assert.equal(dialog.querySelector('#aq-err-prompt').hidden, true, 'the prompt is not blamed');
  } finally { teardown(dom); }
});

test('an error about a hidden field is surfaced as a message, not swallowed', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    // The form is on "objective", so the rubric input is collapsed. An inline
    // error there would be invisible, so it has to reach the author some other way.
    const view = await renderModules({
      createFails: ['An open question needs a rubric (expected evidence) for the assessor.'],
    });
    const dialog = await openAddForm(view);
    dialog.querySelector('#aq-prompt').value = 'A prompt long enough to pass the client.';
    [...dialog.querySelectorAll('.m-foot .btn')].at(-1).click();
    await flush(80);

    assert.equal(dialog.querySelector('#aq-err-rubric').hidden, true, 'no error hidden inside a collapsed section');
    assert.match(document.getElementById('toast-root').textContent, /needs a rubric/, 'reported instead');
  } finally { teardown(dom); }
});

/* --------------------------- Excel import ---------------------------- */

test('import checks the file before anything is written', { skip: SKIP }, async () => {
  const dom = setupDom();
  const sent = [];
  try {
    const view = await renderModules({ sent });
    view.querySelector('#mv-import').click();
    await flush(60);
    const dialog = document.querySelector('#modal-root .modal');
    assert.ok(dialog, 'import dialog opened');

    const importBtn = [...dialog.querySelectorAll('.m-foot .btn')].at(-1);
    assert.equal(importBtn.disabled, true, 'cannot import before a file is checked');

    const file = new dom.window.File(['module,type,prompt\n'], 'questions.csv', { type: 'text/csv' });
    Object.defineProperty(dialog.querySelector('#iq-file'), 'files', { value: [file] });
    dialog.querySelector('#iq-file').dispatchEvent(new dom.window.Event('change'));
    await flush(120);

    const dry = sent.filter((r) => r.url.includes('/import'));
    assert.equal(dry.length, 1, 'exactly one request so far');
    assert.equal(dry[0].body.dry_run, true, 'the first request is a dry run');
    assert.equal(dry[0].body.csv, 'module,type,prompt\n', 'a .csv is sent as text');
    assert.equal(dry[0].body.filename, 'questions.csv');

    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /2 ready/);
    assert.match(text, /1 rejected/);
    assert.match(text, /An imported question\?/, 'accepted rows are previewed');
    assert.match(text, /Module is required\./, 'the rejected row explains itself');
    assert.equal(importBtn.disabled, false, 'import unlocks once rows are valid');

    importBtn.click();
    await flush(120);
    const real = sent.filter((r) => r.url.includes('/import'));
    assert.equal(real.length, 2, 'the commit is a second request');
    assert.equal(real[1].body.dry_run, false, 'the commit is not a dry run');
  } finally { teardown(dom); }
});

test('a file with nothing usable cannot be imported', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules({
      importReport: {
        headers: ['a'], total: 2, accepted: 0, rejected: 0, duplicates: 2, dry_run: true, imported: 0,
        errors: [], preview: [],
        duplicate_rows: [{ line: 2, prompt: 'Already in the bank?' }, { line: 3, prompt: 'This one too?' }],
      },
    });
    view.querySelector('#mv-import').click();
    await flush(60);
    const dialog = document.querySelector('#modal-root .modal');
    const file = new dom.window.File(['x'], 'dupes.csv', { type: 'text/csv' });
    Object.defineProperty(dialog.querySelector('#iq-file'), 'files', { value: [file] });
    dialog.querySelector('#iq-file').dispatchEvent(new dom.window.Event('change'));
    await flush(120);

    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /2 duplicate/);
    assert.match(text, /Nothing can be imported from this file yet/);
    assert.equal([...dialog.querySelectorAll('.m-foot .btn')].at(-1).disabled, true);
  } finally { teardown(dom); }
});

test('a module can be added to directly from its card', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = await renderModules();
    view.querySelector('[data-add-module="C01"]').click();
    await flush(60);
    const dialog = document.querySelector('#modal-root .modal');
    assert.ok(dialog, 'add dialog opened from the module card');
    assert.equal(dialog.querySelector('#aq-module').value, 'C01', 'the module is pre-selected');
  } finally { teardown(dom); }
});
