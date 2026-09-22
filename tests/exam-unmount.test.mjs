/**
 * The exam session must not outlive the exam view (jsdom, stubbed API).
 *
 * `runExamSession` pins document-level copy/cut/paste/contextmenu/selectstart/
 * keydown blockers, a `window.open` override and a 250 ms countdown. They were
 * only released when the exam itself repainted and found the hash changed —
 * so anything that swapped #view from the outside kept them alive:
 *
 *  - a session drop mid-exam (admin deactivates the candidate, resets their
 *    password, the token expires): the 401 handler mounted the sign-in form
 *    and the form inherited the lockdown — paste, right-click, text selection
 *    and Ctrl+V blocked, "Pasting into the secure exam is not permitted" over
 *    the password field, and every attempt fired a token-less integrity
 *    beacon;
 *  - Back to the journey page kept the same blockers there, and Forward
 *    mounted a second session on top of the first: one copy attempt was logged
 *    twice and two clocks raced the same lock.
 *
 * app.js now announces every view swap (`VIEW_UNMOUNT_EVENT`) and the session
 * tears down on it. Both tests drive the real app.js router, so they share one
 * document (the router binds `onhashchange` to the window it booted on) and
 * run in order: navigation first, then the session drop.
 *
 * jsdom is an optionalDependency: without it the suite reports skips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM, SKIP } from './helpers/jsdom.mjs';

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;

const QUESTION = {
  id: 'q2', competency_id: 'c1', type: 'mcq_single', order: 1, points: 4,
  prompt: 'Which layer serves the business?', help_text: '', difficulty: 'intermediate',
  options: [{ id: 'a', label: 'Bronze' }, { id: 'b', label: 'Gold' }], audio_required: false,
};
const payload = () => ({
  assessment: { id: 'asm1', status: 'in_progress', started_at: null, submitted_at: null, role: { name: 'RSA', description: '' } },
  exam: {
    index: 1, total: 3, phase: 'answer', remaining_ms: 24_000, server_now: new Date().toISOString(),
    budgets: { review_ms: 60_000, answer_ms: 120_000 }, integrity: {}, complete: false,
  },
  current_question: QUESTION, current_answer: null,
  competency: { id: 'c1', name: 'Lakehouse Architecture', category: 'technical', description: '', order: 1 },
  questions: [QUESTION], competencies: [], answers: {},
});
const META = {
  questionTypes: [{ key: 'mcq_single', label: 'Multiple choice (single answer)' }],
  assessmentStatuses: [{ key: 'in_progress', label: 'In progress' }],
  pipelineStages: [{ key: 'assessment', label: 'Assessment' }],
  userRoles: ['candidate'], difficulties: [], modules: [], families: [], moduleGroups: [],
  moduleTestStructure: {}, maxAssessmentQuestions: 50,
};
const ME = { user: { username: 'cand', role: 'candidate' }, candidate: { id: 'c1', name: 'Cand', stage: 'assessment' } };

let h = null;

/** Boots the real app.js against a jsdom whose fetch serves a mid-exam paper. */
async function boot() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
    <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
  </body></html>`, { url: 'http://localhost:3000/#/assessments/asm1/quiz', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const calls = [];
  const intervals = [];
  const harness = { sessionDead: false };
  const globals = {
    window, document: window.document, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    // Every interval is tracked so teardown can stop them; the exam's clock is
    // the 250 ms one (jsdom's own requestAnimationFrame shim also uses
    // setInterval, at 60 Hz, for the sign-in page's count-up animation).
    setInterval: (fn, ms, ...a) => { const id = nodeSetInterval(fn, ms, ...a); intervals.push({ id, ms }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); nodeClearInterval(id); },
    HashChangeEvent: window.HashChangeEvent, Event: window.Event,
    IntersectionObserver: window.IntersectionObserver, ResizeObserver: window.ResizeObserver, matchMedia: window.matchMedia,
    fetch: async (url, opts = {}) => {
      const path = String(url);
      const method = opts.method || 'GET';
      const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      calls.push({ method, path, auth: opts.headers?.authorization, body: opts.body ? JSON.parse(opts.body) : null });
      if (path.includes('/meta/bootstrap')) return json(META);
      if (harness.sessionDead) return json({ error: 'Session expired' }, 401);
      if (path.includes('/auth/me')) return json(ME);
      if (/\/candidate\/assessments$/.test(path)) return json({ candidate: ME.candidate, assessments: [] });
      if (method === 'GET') return json(payload());
      return json({ ok: true, ...payload() });
    },
  };
  for (const [k, v] of Object.entries(globals)) globalThis[k] = v;
  window.localStorage.setItem('ecod.token', 'tok');
  window.sessionStorage.setItem('ecod.exam.ack.asm1', '1');
  const originalOpen = window.open;
  await import('../public/js/app.js');
  const view = window.document.getElementById('view');
  const text = () => (view.textContent || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 40 && !/Question\s*2\s*of\s*3/.test(text()); i += 1) await flush(50);
  assert.match(text(), /Question\s*2\s*of\s*3/, 'the exam must be on screen before the scenario starts');
  const beacons = () => calls.filter((c) => c.path.includes('/integrity')).map((c) => c.body?.event);
  const examClocks = () => intervals.filter((t) => t.ms === 250).length;
  /** Dispatches a cancelable event and reports whether the exam blocked it. */
  const blocked = (type, target = window.document.body, init = {}) => {
    const ev = type === 'keydown'
      ? new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      : new window.Event(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  return {
    dom, window, view, text, calls, harness, beacons, examClocks, blocked, originalOpen,
    teardown() {
      dom.window.close();
      intervals.forEach((t) => nodeClearInterval(t.id));
      for (const k of ['fetch', 'setInterval', 'clearInterval']) delete globalThis[k];
    },
  };
}

test('leaving the hall releases the lockdown, and coming back mounts exactly one session', { skip: SKIP }, async () => {
  h = await boot();
  const { window, beacons, examClocks, blocked } = h;
  assert.equal(examClocks(), 1, 'one countdown runs while the exam is up');
  assert.equal(blocked('contextmenu'), true, 'sanity: the exam blocks right-click while it is on screen');

  // Browser Back → the journey page.
  window.location.hash = '#/journey';
  for (let i = 0; i < 40 && !/journey|assessment/i.test(h.text()); i += 1) await flush(50);
  await flush(150);
  assert.equal(beacons().filter((e) => e === 'exam_exit').length, 1, 'leaving the hall is still logged exactly once');
  assert.equal(examClocks(), 0, 'the exam clock must stop when the exam view is gone');
  assert.equal(blocked('contextmenu'), false, 'right-click must work on the journey page');
  assert.equal(blocked('paste'), false, 'paste must work on the journey page');
  assert.equal(blocked('selectstart'), false, 'text selection must work on the journey page');
  assert.equal(window.open, h.originalOpen, 'window.open must be restored once the exam view is gone');
  const beforeToast = window.document.getElementById('toast-root').textContent;
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  await flush(50);
  assert.equal(window.document.getElementById('toast-root').textContent, beforeToast, 'no exam toasts on the journey page');

  // Browser Forward → back into the exam.
  window.location.hash = '#/assessments/asm1/quiz';
  for (let i = 0; i < 40 && !/Question\s*2\s*of\s*3/.test(h.text()); i += 1) await flush(50);
  await flush(150);
  assert.equal(examClocks(), 1, 'returning to the exam must run exactly one countdown, not one per visit');
  const before = beacons().length;
  window.document.dispatchEvent(new window.Event('copy', { bubbles: true, cancelable: true }));
  await flush(200);
  assert.deepEqual(beacons().slice(before), ['copy'], 'one copy attempt must be logged once, not once per mounted session');
});

test('a session drop mid-exam releases the lockdown before the sign-in form mounts', { skip: SKIP }, async () => {
  assert.ok(h, 'runs after the navigation scenario on the same document');
  const { window, view, calls, harness, beacons, examClocks, blocked } = h;
  assert.match(h.text(), /Question\s*2\s*of\s*3/, 'the exam is on screen');

  // The session is revoked server-side; the next round trip — an integrity
  // beacon from a cut attempt (a fresh event type: beacons are throttled per
  // type for 1.2 s and the previous test just sent a copy) — comes back 401
  // and the app mounts sign-in.
  harness.sessionDead = true;
  window.document.dispatchEvent(new window.Event('cut', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 40 && !view.querySelector('input[type=password]'); i += 1) await flush(50);
  await flush(150);
  const pw = view.querySelector('input[type=password]');
  assert.ok(pw, 'the sign-in form is on screen after the 401');
  assert.equal(window.localStorage.getItem('ecod.token'), null, 'the dead token is dropped');
  assert.equal(window.location.hash, '#/assessments/asm1/quiz', 'the hash still points at the exam — the old hash check alone would not have released anything');

  harness.sessionDead = false;
  const sent = calls.length;
  assert.equal(examClocks(), 0, 'the exam clock must not keep ticking behind the sign-in form');
  assert.equal(blocked('paste', pw), false, 'pasting into the password field must work');
  assert.equal(blocked('keydown', pw, { key: 'v', ctrlKey: true }), false, 'Ctrl+V into the password field must work');
  assert.equal(blocked('keydown', pw, { key: 'a', ctrlKey: true }), false, 'Ctrl+A in the password field must work');
  assert.equal(blocked('contextmenu'), false, 'right-click must work on the sign-in form');
  assert.equal(blocked('selectstart'), false, 'text selection must work on the sign-in form');
  assert.equal(window.open, h.originalOpen, 'window.open must be restored');
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  await flush(200);
  const toasts = window.document.getElementById('toast-root').textContent;
  assert.doesNotMatch(toasts, /Pasting into the secure exam|Tab switch recorded/, 'no exam toasts on the sign-in form');
  assert.equal(calls.length - sent, 0, 'no token-less integrity beacons from the sign-in form');
  assert.equal(beacons().filter((e) => e === 'exam_exit').length, 1, 'a session drop is not a candidate leaving the hall');
  h.teardown();
});
