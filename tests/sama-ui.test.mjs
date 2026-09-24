/**
 * The Technology Risk Consultant - SAMA track on the actual screens.
 *
 * Unlike the stubbed view suites, these boot a jsdom whose `fetch` is bridged
 * to the real in-process API over a store that has the SAMA track installed,
 * so what the admin sees under Roles & frameworks, the Question Bank and the
 * allocation dialog — and what the candidate sees in the exam hall — is the
 * published SAMA content itself, not a hand-written payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM, SKIP } from './helpers/jsdom.mjs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { installCatalogue } from '../src/api/catalogue-service.mjs';
import { SAMA_ROLE, SAMA_COMPETENCIES } from '../src/content/sama-catalogue.mjs';
import { MODULES as SAMA_MODULES } from '../src/content/sama-question-bank.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';
import { EXAM_MCQ_SECONDS, EXAM_OPEN_REVIEW_SECONDS } from '../src/core/constants.mjs';

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;

/** A workspace with the SAMA track installed (the seed/install path), an admin, an assessor and a SAMA candidate. */
async function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-sama-ui-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);
  const installed = await installCatalogue(store, SAMA_ROLE.key);
  assert.equal(installed.created, true, JSON.stringify(installed));
  const role = installed.role;
  const mk = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mk({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mk({ username: 'assessor', name: 'Priya Nair', role: 'assessor', email: '', password: 'assessor-pass-x' });
  const candidate = await store.insert('candidates', { name: 'Faisal Al-Rashid', stage: 'assessment', target_role_id: role.id, email: 'faisal@example.com' });
  await mk({ username: 'faisal', name: 'Faisal Al-Rashid', role: 'candidate', email: '', candidate_id: candidate.id, password: 'cand-pass-x' });
  const login = async (username, password) =>
    (await app({ method: 'POST', path: '/auth/login', body: { username, password } })).body.token;
  return { store, app, role, assessor, candidate, login };
}

/** Bridge the browser's fetch('/api/...') to the in-process app. */
function bridge(app) {
  return async (url, opts = {}) => {
    const u = new URL(String(url), 'http://localhost:3000');
    const reqPath = u.pathname.replace(/^\/api/, '');
    const query = Object.fromEntries(u.searchParams.entries());
    let body;
    try { body = opts.body ? JSON.parse(opts.body) : undefined; } catch { body = undefined; }
    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const res = await app({ method: opts.method || 'GET', path: reqPath, body, query, headers });
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  };
}

function boot(app, { hash, token }) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
    <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
  </body></html>`, { url: `http://localhost:3000/${hash}`, pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const intervals = [];
  const globals = {
    window, document: window.document, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    setInterval: (fn, ms, ...a) => { const id = nodeSetInterval(fn, ms, ...a); intervals.push(id); return id; },
    clearInterval: (id) => { const i = intervals.indexOf(id); if (i >= 0) intervals.splice(i, 1); nodeClearInterval(id); },
    HashChangeEvent: window.HashChangeEvent,
    IntersectionObserver: window.IntersectionObserver,
    ResizeObserver: window.ResizeObserver,
    matchMedia: window.matchMedia,
    fetch: bridge(app),
  };
  const saved = new Map();
  for (const [k, v] of Object.entries(globals)) { saved.set(k, globalThis[k]); globalThis[k] = v; }
  window.localStorage.setItem('ecod.token', token);
  return {
    dom, window,
    teardown() {
      for (const id of intervals) nodeClearInterval(id);
      window.close();
      for (const [k, v] of saved) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    },
  };
}

/** Fresh module instances per test: the views cache state on the module. */
async function views() {
  const t = Date.now() + Math.random();
  const { state } = await import(`../public/js/app.js?t=${t}`);
  const bootRes = await fetch('/api/meta/bootstrap');
  state.meta = await bootRes.json();
  const admin = await import(`../public/js/views/admin.js?t=${t}`);
  const candidate = await import(`../public/js/views/candidate.js?t=${t}`);
  return { state, admin, candidate };
}

test('Roles & frameworks shows the SAMA track as installed, with its competencies and questions', { skip: SKIP }, async () => {
  const w = await world();
  const b = boot(w.app, { hash: '#/roles', token: await w.login('admin', 'admin-pass-x') });
  try {
    const { admin } = await views();
    const view = document.getElementById('view');
    await admin.rolesView(view);
    await flush(80);

    const rows = [...view.querySelectorAll('.table-card tbody tr')];
    const sama = rows.find((r) => /Technology Risk Consultant - SAMA/.test(r.textContent));
    assert.ok(sama, 'the SAMA role is listed in the roles table');
    assert.match(sama.textContent, /Technology Risk/);
    const cells = [...sama.querySelectorAll('td')].map((td) => td.textContent.trim());
    assert.ok(cells.includes('10'), `competency count in ${JSON.stringify(cells)}`);
    assert.ok(cells.includes('100'), `question count in ${JSON.stringify(cells)}`);

    const card = view.querySelector('#published-tracks');
    assert.ok(card, 'the Published tracks card renders');
    assert.match(card.textContent, /Technology Risk Consultant - SAMA/);
    assert.match(card.textContent, /1 of 4 installed/, 'SAMA is one of four published tracks');
    assert.ok(card.querySelector(`a[href="#/roles/${w.role.id}"]`), 'the installed SAMA track links to its configuration');
    const installButtons = [...card.querySelectorAll('[data-install-track]')].map((x) => x.dataset.installTrack);
    assert.ok(!installButtons.includes(SAMA_ROLE.key), 'no install button for an installed track');
    assert.deepEqual(installButtons.sort(), ['databricks-ai-bi-genie', 'databricks-rsa', 'senior-consultant']);

    // The role detail page shows all ten competencies with their weights.
    location.hash = `#/roles/${w.role.id}`;
    await admin.roleDetailView(view, { id: w.role.id });
    await flush(80);
    const text = view.textContent.replace(/\s+/g, ' ');
    for (const c of SAMA_COMPETENCIES) assert.match(text, new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `competency ${c.name}`);
    assert.match(text, /Technology Risk Consultant - SAMA/);
  } finally { b.teardown(); }
});

test('Roles & frameworks offers "Add to workspace" for SAMA when it is not installed, and installs it', { skip: SKIP }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-sama-ui-install-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);
  await store.insert('users', { username: 'admin', name: 'Admin', role: 'admin', email: '', password_hash: hashPassword('admin-pass-x'), active: true });
  const token = (await app({ method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'admin-pass-x' } })).body.token;
  const b = boot(app, { hash: '#/roles', token });
  try {
    const { admin } = await views();
    const view = document.getElementById('view');
    await admin.rolesView(view);
    await flush(80);
    const card = view.querySelector('#published-tracks');
    assert.match(card.textContent, /0 of 4 installed/);
    const btn = card.querySelector(`[data-install-track="${SAMA_ROLE.key}"]`);
    assert.ok(btn, 'SAMA has an Add to workspace button');
    assert.match(btn.textContent, /Add to workspace/);
    const row = btn.closest('tr');
    assert.match(row.textContent, /10 competencies/);
    assert.match(row.textContent, /100 published questions/);

    btn.click();
    await flush(200);
    const roles = await store.list('roles');
    assert.equal(roles.length, 1);
    assert.equal(roles[0].key, SAMA_ROLE.key);
    assert.equal((await store.list('questions', { role_id: roles[0].id })).length, 100);
    assert.equal((await store.list('competencies', { role_id: roles[0].id })).length, 10);
    assert.equal((await store.list('frameworks', { role_id: roles[0].id })).length, 1);
    // The screen re-rendered: the track is now installed and in the roles table.
    const after = document.getElementById('view');
    assert.match(after.querySelector('#published-tracks').textContent, /1 of 4 installed/);
    assert.equal(after.querySelector(`[data-install-track="${SAMA_ROLE.key}"]`), null);
    assert.ok([...after.querySelectorAll('.table-card tbody tr')].some((r) => /Technology Risk Consultant - SAMA/.test(r.textContent)));
  } finally { b.teardown(); }
});

test('Question Bank lists the SAMA bank in the track selector and renders its ten modules', { skip: SKIP }, async () => {
  const w = await world();
  const b = boot(w.app, { hash: `#/modules?bank=${SAMA_ROLE.key}`, token: await w.login('admin', 'admin-pass-x') });
  try {
    const { admin } = await views();
    const view = document.getElementById('view');
    await admin.modulesView(view);
    await flush(120);

    const select = view.querySelector('#mv-bank');
    assert.ok(select, 'the track selector renders');
    const options = [...select.querySelectorAll('option')].map((o) => [o.value, o.textContent]);
    assert.ok(options.some(([v, t]) => v === SAMA_ROLE.key && /Technology Risk Consultant - SAMA/.test(t)), JSON.stringify(options));
    assert.equal(select.value, SAMA_ROLE.key, 'the browsed bank stays selected');
    assert.equal(view.querySelector('#track-install'), null, 'no install strip: the track is in the workspace');

    const cards = [...view.querySelectorAll('.module-card')];
    assert.deepEqual(cards.map((c) => c.dataset.module), SAMA_MODULES.map((m) => m.key));
    const text = view.textContent.replace(/\s+/g, ' ');
    for (const m of SAMA_MODULES) assert.match(text, new RegExp(m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `module ${m.key}`);
    assert.match(text, /34/, 'the 34-question blueprint is stated');
    const ids = [...view.querySelectorAll('.family-table .mono')].map((n) => n.textContent);
    assert.ok(ids.includes('R01:sama-csf-saudi-regulatory-assessment'), ids.join(','));
    assert.ok(ids.includes('C01:banking-reporting-client-management'));
  } finally { b.teardown(); }
});

test('the allocation dialog offers the SAMA track and previews a weighted split across its ten competencies', { skip: SKIP }, async () => {
  const w = await world();
  const b = boot(w.app, { hash: '#/candidates', token: await w.login('admin', 'admin-pass-x') });
  try {
    const { admin } = await views();
    const done = admin.allocateAssessorModal({ id: w.candidate.id, name: w.candidate.name, target_role_id: w.role.id });
    await flush(150);
    const modal = document.querySelector('.modal');
    assert.ok(modal, 'dialog opened');
    assert.match(modal.querySelector('.m-head h3').textContent, /Allocate assessment · Faisal Al-Rashid/);
    const roleSel = modal.querySelector('#al-role');
    assert.equal(roleSel.value, w.role.id, 'the candidate\'s SAMA target track is preselected');
    assert.match(roleSel.selectedOptions[0].textContent, /Technology Risk Consultant - SAMA · 100 questions/);

    const preview = modal.querySelector('#al-preview');
    assert.match(preview.textContent, /100 questions/, 'full bank previewed');
    assert.equal(preview.querySelectorAll('.alloc-split-row').length, 10, 'one row per SAMA competency');

    // Limit to 20: the split still covers every competency and adds up.
    const limit = modal.querySelector('.scope-opt[data-scope="limit"] input');
    limit.checked = true;
    limit.dispatchEvent(new b.window.Event('change', { bubbles: true }));
    await flush(60);
    modal.querySelector('[data-preset="20"]').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
    await flush(150);
    const counts = [...modal.querySelectorAll('.alloc-split-count')].map((el) => Number(el.textContent));
    assert.equal(counts.length, 10);
    assert.equal(counts.reduce((a, n) => a + n, 0), 20);
    assert.ok(counts.every((n) => n >= 1), 'every competency gets at least one question');

    modal.querySelector('.m-foot .btn:last-child').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
    await done;
    await flush(150);
    // The dialog posted the allocation itself: a 20-question SAMA paper now
    // exists for the candidate, assigned to the assessor, frozen as a snapshot.
    const allocated = await w.store.list('assessments', { candidate_id: w.candidate.id });
    assert.equal(allocated.length, 1);
    assert.equal(allocated[0].role_id, w.role.id);
    assert.equal(allocated[0].assessor_id, w.assessor.id);
    assert.equal(allocated[0].status, 'assigned');
    assert.equal(allocated[0].snapshot_json.questions.length, 20);
    assert.equal(allocated[0].snapshot_json.role.key, SAMA_ROLE.key);
    assert.equal(new Set(allocated[0].snapshot_json.questions.map((q) => q.competency_id)).size, 10, 'all ten competencies on the paper');
    assert.match(document.getElementById('toast-root').textContent, /Assessment allocated · 20 questions|✓/);
  } finally { b.teardown(); }
});

test('the exam hall serves a SAMA paper with the timers and controls the candidate expects', { skip: SKIP }, async () => {
  const w = await world();
  const adminTok = await w.login('admin', 'admin-pass-x');
  const alloc = await w.app({
    method: 'POST', path: '/admin/assessments', headers: { authorization: `Bearer ${adminTok}` },
    body: { candidate_id: w.candidate.id, role_id: w.role.id, assessor_id: w.assessor.id, question_count: 10 },
  });
  assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
  const aid = alloc.body.id;
  const paper = sortedQuestions(alloc.body.snapshot_json);

  const b = boot(w.app, { hash: `#/assessments/${aid}/quiz`, token: await w.login('faisal', 'cand-pass-x') });
  try {
    const { candidate } = await views();
    const view = document.getElementById('view');

    // My Journey lists the SAMA assessment.
    await candidate.portalView(view);
    await flush(100);
    assert.match(view.textContent, /Technology Risk Consultant - SAMA/);

    // The exam hall: rules gate acknowledged like a candidate who pressed Start.
    b.window.sessionStorage.setItem(`ecod.exam.ack.${aid}`, '1');
    await candidate.quizView(view, { id: aid });
    await flush(200);

    const first = paper[0];
    const text = view.textContent.replace(/\s+/g, ' ');
    assert.ok(text.includes(first.prompt.slice(0, 60)), 'the first SAMA question is on screen');
    const clock = view.querySelector('#exam-clock');
    assert.ok(clock, 'a countdown is shown');
    const shown = clock.textContent.replace(/\s+/g, ' ').trim();
    assert.match(shown, /Time left/);
    // "30s" or "1:00" / "0:58" style — normalise to seconds.
    const m = shown.match(/(\d+):(\d\d)|(\d+)s/);
    assert.ok(m, `a readable countdown, got "${shown}"`);
    const seconds = m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
    if (first.type === 'text') {
      assert.ok(seconds <= EXAM_OPEN_REVIEW_SECONDS && seconds >= EXAM_OPEN_REVIEW_SECONDS - 5, `review window on the clock, got ${shown}`);
      assert.ok(/review|read/i.test(text), 'the review phase is explained');
      assert.ok(view.querySelector('[data-record], .exam-record, button[id*="rec"], [class*="record"]'), 'the record control is present for a spoken answer');
    } else {
      assert.ok(seconds <= EXAM_MCQ_SECONDS && seconds >= EXAM_MCQ_SECONDS - 5, `MCQ window on the clock, got ${shown}`);
      const opts = [...view.querySelectorAll('input[type="radio"]')];
      assert.equal(opts.length, 4, 'four options rendered');
      for (const o of first.options) assert.ok(text.includes(o.label.slice(0, 40)), 'every option label is on screen');
      assert.ok(!text.includes('Correct answer'), 'the key is not on screen');
    }
    assert.match(text, /Question 1 of 10/, 'the progress reads Question 1 of 10');
    assert.match(text, /Lock & continue/, 'the lock control is offered');
    assert.match(text, /Answers lock when time expires/, 'the timer rule is stated');
    assert.ok(!/rubric/i.test(view.innerHTML) || !/Expected evidence:/.test(text), 'no rubric on the candidate screen');
  } finally { b.teardown(); }
});
