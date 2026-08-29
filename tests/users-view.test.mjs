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

function stubFetch() {
  const calls = { posts: [], patches: [] };
  const users = [
    { id: 'u-admin', username: 'admin', name: 'Admin User', role: 'admin', email: 'admin@example.com', active: true },
    { id: 'u-assessor', username: 'assessor', name: 'Assessor User', role: 'assessor', email: 'assessor@example.com', active: true },
    { id: 'u-candidate', username: 'candidate', name: 'Candidate User', role: 'candidate', email: 'candidate@example.com', active: true, candidate_id: 'c1', candidate_name: 'Candidate One' },
  ];
  const candidates = [{ id: 'c1', name: 'Candidate One' }, { id: 'c2', name: 'Candidate Two' }];
  globalThis.fetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes('/auth/me')) return json({ user: { id: 'u-admin', username: 'admin', name: 'Admin User', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/meta/bootstrap')) return json({ pipelineStages: [], assessmentStatuses: [], questionTypes: [], userRoles: ['admin', 'assessor', 'candidate', 'validator', 'trainer'], difficulties: [] });
    if (url.includes('/admin/users') && opts.method === 'PATCH') { calls.patches.push(JSON.parse(opts.body)); return json({ ok: true }); }
    if (url.includes('/admin/users') && opts.method === 'POST') { calls.posts.push(JSON.parse(opts.body)); return json({ id: 'new-user' }, 201); }
    if (url.includes('/admin/users')) return json({ users });
    if (url.includes('/admin/candidates')) return json({ candidates });
    if (url.includes('/admin/dashboard')) return json({ counts: { candidates: 0, enterprise_ready: 0, active_assessments: 0, avg_score: null }, by_stage: {}, by_status: {}, recent_activity: [] });
    return json({});
  };
  return calls;
}

async function renderUsersView() {
  localStorage.setItem('ecod.token', 'test-token');
  const { state } = await import('../public/js/app.js');
  state.meta = {
    pipelineStages: [],
    assessmentStatuses: [],
    questionTypes: [],
    userRoles: ['admin', 'assessor', 'candidate', 'validator', 'trainer'],
    difficulties: [],
  };
  state.user = null;
  state.candidate = null;
  const admin = await import('../public/js/views/admin.js');
  const view = document.getElementById('view');
  await admin.usersView(view);
  return view;
}

test('users view: editing staff accounts does not show a misleading candidate-link field', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    stubFetch();
    const view = await renderUsersView();
    view.querySelector('[data-edit="u-assessor"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(80);
    const modal = document.querySelector('.modal');
    assert.ok(modal, 'edit modal opened');
    assert.match(modal.textContent, /Edit @assessor/);
    assert.equal(modal.querySelector('[name="candidate_id"]'), null, 'non-candidate edit form does not offer a candidate link the server will ignore');
  } finally { teardown(dom); }
});

test('users view: editing candidate accounts keeps the linked-candidate field required', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    stubFetch();
    const view = await renderUsersView();
    view.querySelector('[data-edit="u-candidate"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(80);
    const link = document.querySelector('.modal [name="candidate_id"]');
    assert.ok(link, 'candidate edit form includes the link');
    assert.equal(link.required, true, 'candidate link cannot be cleared in the UI');
    assert.equal(link.value, 'c1');
  } finally { teardown(dom); }
});

test('users view: creating a candidate user requires choosing the linked candidate before posting', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const calls = stubFetch();
    const view = await renderUsersView();
    view.querySelector('#add-user').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(80);

    const modal = document.querySelector('.modal');
    modal.querySelector('[name="username"]').value = 'new.candidate';
    modal.querySelector('[name="name"]').value = 'New Candidate';
    modal.querySelector('[name="password"]').value = 'candidate-pass-123';
    modal.querySelector('[name="role"]').value = 'candidate';
    modal.querySelector('[name="role"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    modal.querySelector('.m-foot .btn:last-child').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(120);

    assert.equal(calls.posts.length, 0, 'invalid candidate account is not posted');
    assert.match(document.getElementById('toast-root').textContent, /linked candidate/i);
    const reopened = document.querySelector('.modal');
    assert.ok(reopened, 'form remains available for correction');
    assert.equal(reopened.querySelector('[name="role"]').value, 'candidate', 'previous role choice is preserved');
  } finally { teardown(dom); }
});
