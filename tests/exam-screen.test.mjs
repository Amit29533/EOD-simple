/**
 * Exam screen render test (jsdom, stubbed API).
 *
 * The timer regression this pins: `question_started_at` reached the client as
 * an ISO string, but the view parsed it with `Date.parse(x || 0) || now`, so a
 * fresh question arrived with `remaining_ms: 0` and the countdown painted
 * 00:00 — the candidate was shown an expired clock on question one. These
 * tests drive the real `quizView` and assert the screen a candidate actually
 * sees: a running clock, the right option count, and an expiry path that
 * advances instead of stranding the question.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
// Node's own timer fns, captured before any test swaps globals.
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;

const QUESTION = {
  id: 'q2', competency_id: 'c1', type: 'mcq_single', order: 1, points: 4,
  prompt: 'A client wants medallion tables on Unity Catalog. Which layout is correct?',
  help_text: '', difficulty: 'intermediate', options: [
    { id: 'a', label: 'Bronze, silver and gold in one schema' },
    { id: 'b', label: 'One catalog per layer' },
    { id: 'c', label: 'Bronze raw, silver curated, gold served' },
    { id: 'd', label: 'Gold first, bronze on demand' },
  ],
  correct_option_ids: ['c'], audio_required: false,
};

function payload({ remaining = 24_000, index = 1, total = 3, complete = false, phase = 'answer' } = {}) {
  return {
    assessment: { id: 'asm1', status: 'in_progress', started_at: null, submitted_at: null, role: { name: 'RSA', description: '' } },
    exam: {
      index, total, phase, remaining_ms: remaining, server_now: new Date().toISOString(),
      budgets: { review_ms: 60_000, answer_ms: 120_000 }, integrity: {}, complete,
    },
    current_question: QUESTION,
    current_answer: null,
    competency: { id: 'c1', name: 'Lakehouse Architecture', category: 'technical', description: '', order: 1 },
    questions: [QUESTION],
    competencies: [],
    answers: {},
  };
}

const META = {
  questionTypes: [{ key: 'mcq_single', label: 'Multiple choice (single answer)' }],
  assessmentStatuses: [{ key: 'in_progress', label: 'In progress' }],
  pipelineStages: [{ key: 'assessment', label: 'Assessment' }],
  userRoles: ['candidate'], difficulties: [], modules: [], families: [], moduleGroups: [],
  moduleTestStructure: {}, maxAssessmentQuestions: 50,
};

/**
 * Boots a jsdom whose fetch replays `pages` in order and records every call.
 * The route hash matches the exam so that app.js's own boot render paints the
 * same screen instead of racing a second renderer into `#view`.
 */
function setup({ pages = [payload()], token = 'tok' } = {}) {
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
  let page = 0;
  const globals = {
    window, document: window.document, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    // The exam's 250ms countdown interval is created with the bare global, so it
    // has to be tracked here and cleared on teardown; otherwise it outlives the
    // DOM and keeps painting a dead document.
    setInterval: (fn, ms, ...a) => { const id = nodeSetInterval(fn, ms, ...a); intervals.push(id); return id; },
    clearInterval: (id) => { const i = intervals.indexOf(id); if (i >= 0) intervals.splice(i, 1); nodeClearInterval(id); },
    HashChangeEvent: window.HashChangeEvent,
    IntersectionObserver: window.IntersectionObserver,
    ResizeObserver: window.ResizeObserver,
    matchMedia: window.matchMedia,
    fetch: async (url, opts = {}) => {
      const path = String(url);
      const method = opts.method || 'GET';
      const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      const current = () => pages[Math.min(page, pages.length - 1)];
      if (path.includes('/meta/bootstrap')) return json(META);
      if (path.includes('/auth/me')) return json({ user: { username: 'cand', role: 'candidate' }, candidate: { id: 'c1', name: 'Cand', stage: 'assessment' } });
      if (/\/candidate\/assessments$/.test(path)) return json({ candidate: { id: 'c1', name: 'Cand', stage: 'assessment' }, assessments: [] });
      if (method === 'POST' && path.includes('/next')) { calls.push({ method, path, body: JSON.parse(opts.body || '{}') }); page += 1; return json(current()); }
      if (method === 'POST' && path.includes('/phase')) { calls.push({ method, path, body: JSON.parse(opts.body || '{}') }); return json(current()); }
      if (method === 'GET') { calls.push({ method, path }); return json(current()); }
      calls.push({ method, path, body: JSON.parse(opts.body || '{}') });
      return json({ ok: true, ...current() });
    },
  };
  const saved = new Map();
  for (const [k, v] of Object.entries(globals)) { saved.set(k, globalThis[k]); globalThis[k] = v; }
  window.localStorage.setItem('ecod.token', token);
  // The rules gate is remembered per browser session; pre-acknowledge it so the
  // render goes straight to the paper, like a candidate mid-exam.
  window.sessionStorage.setItem('ecod.exam.ack.asm1', '1');
  return {
    dom, window, calls,
    async teardown() {
      // Leave the DOM globals in place (app.js's router may still be finishing a
      // render and must not find `document` undefined) and only hand the timer
      // and fetch globals back to Node.
      dom.window.close();
      intervals.forEach((id) => nodeClearInterval(id));
      for (const k of ['fetch', 'setInterval', 'clearInterval']) globalThis[k] = saved.get(k);
    },
  };
}

const textOf = (view) => (view.textContent || '').replace(/\s+/g, ' ').trim();

/** Paints the exam through the real view and waits for the question frame. */
async function paint(h) {
  const { state } = await import('../public/js/app.js');
  state.user = { username: 'cand', role: 'candidate' };
  state.meta = META;
  const { quizView } = await import('../public/js/views/candidate.js');
  const view = h.window.document.getElementById('view');
  await quizView(view, { id: 'asm1' });
  for (let i = 0; i < 30 && !/Question\s*\d/.test(textOf(view)); i += 1) await flush(50);
  return view;
}

test('the live exam screen shows a running clock, the question, and its options', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload()] });
  try {
    const view = await paint(h);
    const timer = view.querySelector('#exam-timer');
    assert.ok(timer, 'a countdown element must exist');
    const shown = timer.textContent.trim();
    assert.match(shown, /\d/, `the clock must show a real countdown, got ${JSON.stringify(shown)}`);
    assert.doesNotMatch(shown, /^00:00$|^0s$/, 'a question with 24s left must never be painted as expired');
    assert.match(textOf(view), /Question\s*2\s*of\s*3/, 'the progress label must show the position in the paper');
    assert.ok(textOf(view).includes('medallion tables'), 'the prompt must be on screen');
    assert.equal(view.querySelectorAll('.opt').length, QUESTION.options.length, 'every option must be rendered');
    assert.ok(view.querySelector('#exam-next'), 'the lock/continue control must exist');
    assert.doesNotMatch(textOf(view), /undefined|\[object Object\]|\bNaN\b/, 'the exam screen must not leak raw values');
    assert.doesNotMatch(textOf(view), /Something went wrong/, 'the exam screen must not hit the error boundary');
  } finally { await h.teardown(); }
});

test('locking an answer saves it, advances once, and ignores a double click', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload(), payload({ index: 2 })] });
  const countNext = () => h.calls.filter((c) => c.method === 'POST' && c.path.includes('/next')).length;
  try {
    const view = await paint(h);
    view.querySelector('.opt').click();
    await flush(60);
    view.querySelector('#exam-next').click();
    await flush(300);

    const paths = h.calls.map((c) => `${c.method} ${c.path.replace('/api', '')}`);
    assert.equal(countNext(), 1, `locking must advance the paper exactly once (${paths.join(' | ')})`);
    // Locking a question IS the save: the chosen option rides with /next.
    const next = h.calls.filter((c) => c.method === 'POST' && c.path.includes('/next'))[0];
    assert.equal(next.body.answer, QUESTION.options[0].id, 'the advance must carry the selected option');
    assert.match(textOf(view), /Question\s*3\s*of\s*3/, 'the next question must be painted after the advance');

    // Two clicks in the same tick must be one advance, or a candidate skips a
    // question they never saw.
    const btn = view.querySelector('#exam-next');
    const before = countNext();
    btn.click();
    btn.click();
    await flush(300);
    assert.equal(countNext(), before + 1, 'a double-clicked Lock must not skip a question');
  } finally { await h.teardown(); }
});

test('an expired question turns the clock urgent and force-advances', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload({ remaining: 400 }), payload({ index: 2, remaining: 30_000 })] });
  try {
    const view = await paint(h);
    await flush(1600);
    const advanced = h.calls.filter((c) => c.method === 'POST' && c.path.includes('/next'));
    assert.ok(advanced.length >= 1, `time expiry must trigger an advance (calls: ${h.calls.map((c) => c.method + ' ' + c.path.split('/').pop()).join(',')})`);
    assert.doesNotMatch(textOf(view), /Something went wrong/, 'expiry must not land the candidate on the error boundary');
  } finally { await h.teardown(); }
});

test('an almost-expired question is flagged urgent to the candidate', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload({ remaining: 6000 })] });
  try {
    const view = await paint(h);
    await flush(400);
    const clock = view.querySelector('.exam-clock');
    assert.ok(clock, 'the clock container must exist');
    assert.ok(clock.classList.contains('urgent'), 'under 8s left must visibly flag the clock as urgent');
  } finally { await h.teardown(); }
});

test('a finished paper submits itself and leaves the exam hall', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload({ index: 2, total: 3, complete: true })] });
  try {
    const view = h.window.document.getElementById('view');
    const { state } = await import('../public/js/app.js');
    state.user = { username: 'cand', role: 'candidate' };
    state.meta = META;
    const { quizView } = await import('../public/js/views/candidate.js');
    await quizView(view, { id: 'asm1' });
    await flush(400);
    const submits = h.calls.filter((c) => c.method === 'POST' && c.path.includes('/submit'));
    assert.equal(submits.length, 1, `a completed paper must auto-submit exactly once (calls: ${h.calls.map((c) => c.method + ' ' + c.path.split('/').pop()).join(',')})`);
    assert.match(String(h.window.location.hash), /#\/journey/, 'the candidate must be moved off the exam screen');
  } finally { await h.teardown(); }
});
