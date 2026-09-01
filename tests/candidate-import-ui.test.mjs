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

function stubFetch(sent) {
  const dryReport = (b) => ({
    headers: ['name', 'email'], create_users: b.create_users,
    total: 3, accepted: 2, rejected: 1, duplicates: 0,
    dry_run: true, imported: 0, users_created: 0, credentials: [],
    errors: [{ line: 4, errors: ['Name is required.'], name: '' }],
    duplicate_rows: [],
    preview: [
      { line: 2, name: 'Asha Sharma', target_role: 'Resident Solutions Architect (RSA)', stage: 'intake', username: 'asha.sharma' },
      { line: 3, name: 'Bilal Khan', target_role: '', stage: 'role_mapping', username: 'bilal' },
    ],
  });
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const parse = () => { try { return JSON.parse(opts.body || '{}'); } catch { return {}; } };
    if (url.includes('/admin/candidates/import-template')) {
      return json({
        filename: 'ecod-candidates-import-template.csv', content_type: 'text/csv',
        columns: [{ key: 'Name', required: true }, { key: 'Email', required: false }],
        csv: 'Name,Email\nAsha Sharma,asha@example.com\n',
      });
    }
    if (url.includes('/admin/candidates/import')) {
      const b = parse();
      sent.push({ url, body: b });
      if (b.dry_run) return json(dryReport(b));
      return json({ ...dryReport({ ...b, create_users: b.create_users }), dry_run: false, imported: 2, users_created: 1,
        credentials: [{ username: 'asha.sharma', name: 'Asha Sharma', password: 'Onboard-2026!' }] });
    }
    if (url.includes('/auth/me')) return json({ user: { id: 'u-admin', username: 'admin', name: 'Admin User', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/admin/roles')) return json({ roles: [{ id: 'r1', name: 'Resident Solutions Architect (RSA)', active: true }] });
    if (url.includes('/admin/users')) return json({ users: [{ id: 'u-admin', username: 'admin', name: 'Admin User', role: 'admin', email: '', active: true }] });
    if (url.includes('/admin/candidates')) return json({ candidates: [] });
    return json({});
  };
}

async function renderView(viewFn) {
  localStorage.setItem('ecod.token', 'test-token');
  const { state } = await import('../public/js/app.js');
  state.meta = {
    pipelineStages: [{ key: 'intake', label: 'Candidate Intake' }, { key: 'role_mapped', label: 'Role Mapping' }],
    assessmentStatuses: [],
    questionTypes: [],
    userRoles: ['admin', 'assessor', 'candidate', 'validator', 'trainer'],
    difficulties: [],
  };
  state.user = null;
  state.candidate = null;
  const admin = await import('../public/js/views/admin.js');
  const view = document.getElementById('view');
  await admin[viewFn](view);
  return view;
}

/** Attach a fake file to the hidden input and fire change, like a real pick. */
function chooseFile(dom, selector, content, name = 'people.csv') {
  const input = document.querySelector(selector);
  const file = new dom.window.File([content], name, { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new dom.window.Event('change'));
}

test('candidates: import validates a spreadsheet as a dry run, then commits and shows credentials once', { skip: SKIP }, async () => {
  const dom = setupDom();
  const sent = [];
  try {
    stubFetch(sent);
    const view = await renderView('candidatesView');
    view.querySelector('#import-cands').click();
    await flush(60);

    const dialog = document.querySelector('#modal-root .modal');
    assert.ok(dialog, 'import dialog opened from the candidates screen');
    assert.ok(dialog.querySelector('#ic-users').checked, 'portal users are on by default');
    const importBtn = [...dialog.querySelectorAll('.m-foot .btn')].at(-1);
    assert.equal(importBtn.disabled, true, 'cannot import before a file is checked');

    chooseFile(dom, '#ic-file', 'name,email\nAsha Sharma,asha@example.com\n');
    await flush(120);

    assert.equal(sent.length, 1, 'one request after the file is chosen');
    assert.equal(sent[0].body.dry_run, true, 'the first request is a dry run');
    assert.equal(sent[0].body.create_users, true, 'portal-user creation is included');
    assert.equal(sent[0].body.csv, 'name,email\nAsha Sharma,asha@example.com\n');
    assert.match(dialog.textContent.replace(/\s+/g, ' '), /2 ready/);
    assert.match(dialog.textContent.replace(/\s+/g, ' '), /asha\.sharma/, 'resolved username previewed');
    assert.match(dialog.textContent.replace(/\s+/g, ' '), /Name is required\./, 'rejected rows explain themselves');
    assert.equal(importBtn.disabled, false, 'import unlocks once rows are valid');

    // Toggling users off re-runs the check so the report stays honest.
    dialog.querySelector('#ic-users').checked = false;
    dialog.querySelector('#ic-users').dispatchEvent(new dom.window.Event('change'));
    await flush(120);
    assert.equal(sent[1].body.create_users, false, 'the re-check carries the new toggle');

    dialog.querySelector('#ic-users').checked = true;
    dialog.querySelector('#ic-users').dispatchEvent(new dom.window.Event('change'));
    await flush(120);

    importBtn.click();
    await flush(120);
    const commit = sent.filter((r) => !r.body.dry_run);
    assert.equal(commit.length, 1, 'the commit is one later request');
    assert.equal(commit[0].body.create_users, true);

    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /2 imported/);
    assert.match(text, /1 user created/);
    assert.match(text, /Onboard-2026!/, 'plaintext credentials are shown once');
    assert.ok(dialog.querySelector('#ic-dl-creds'), 'credentials can be downloaded');
    assert.equal(importBtn.textContent, 'Done');
  } finally { teardown(dom); }
});

test('users & access offers the same bulk import and the template link', { skip: SKIP }, async () => {
  const dom = setupDom();
  const sent = [];
  try {
    stubFetch(sent);
    const view = await renderView('usersView');
    view.querySelector('#import-users').click();
    await flush(60);

    const dialog = document.querySelector('#modal-root .modal');
    assert.ok(dialog, 'import dialog opened from the users screen');
    assert.match(dialog.querySelector('.m-head h3').textContent, /Import candidates/);

    let downloaded = null;
    const origCreate = globalThis.URL.createObjectURL;
    const origRevoke = globalThis.URL.revokeObjectURL;
    const origClick = dom.window.HTMLAnchorElement.prototype.click;
    globalThis.URL.createObjectURL = () => 'blob:test';
    globalThis.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
    try {
      dialog.querySelector('#ic-template').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await flush(120);
      assert.equal(downloaded, 'ecod-candidates-import-template.csv', 'template CSV downloads');
    } finally {
      globalThis.URL.createObjectURL = origCreate;
      globalThis.URL.revokeObjectURL = origRevoke;
      dom.window.HTMLAnchorElement.prototype.click = origClick;
    }
  } finally { teardown(dom); }
});
