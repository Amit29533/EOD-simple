/**
 * The exam hall's draft autosave and the honest clock after a failed lock.
 *
 * The server's lock route refuses an answer that lands more than the grace
 * (5 s) after the question's window and falls back to "the draft saved in
 * time" (`PUT …/answers`) — a contract the API suite pins. The browser never
 * sent such a draft: with the 20 s request timeout and the 30 s MCQ window, a
 * lock lost to a cold function, a 503 or a dropped connection was retried
 * ~21-25 s later, arrived hard-expired, and the answer the candidate gave in
 * time was discarded as a blank with a `time_expired` flag against them. On
 * top of that, the countdown was cleared for the lock and never restarted, so
 * it froze at the moment of the press while the server clock ran on.
 *
 * Client half (jsdom, stubbed API): drafts go out on every change, ride with
 * the lock when still pending, are never re-sent in a loop, and stop at
 * unmount; a failed lock puts the clock back and expiry re-sends the lock; a
 * recording the server already holds is kept (`audio_keep`), not re-uploaded.
 *
 * Server half (real app, JSON store): `audio_keep` keeps the recording the
 * same candidate uploaded for that question — through note edits, cleared
 * notes and the lock — and cannot plant evidence when nothing is stored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { JSDOM, SKIP } from './helpers/jsdom.mjs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';
import { buildTextAnswer } from '../public/js/exam-audio.js';

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;

/* ------------------------------- unit: payload ------------------------------- */

test('buildTextAnswer: a recording the server already holds is referenced, not re-sent', () => {
  const kept = buildTextAnswer({ text: '', transcript: '', audioKept: true });
  assert.equal(kept.audio_keep, true);
  assert.equal(kept.audio_b64, undefined);
  assert.equal(kept.source, 'audio', 'the kept recording is still the spoken answer');
  const withNotes = buildTextAnswer({ text: 'notes', transcript: '', audioKept: true });
  assert.equal(withNotes.audio_keep, true, 'typed notes ride along without dropping the recording');
  assert.equal(withNotes.text, 'notes');
  // A clip in hand always wins over the kept one (a re-recording replaces it).
  const fresh = buildTextAnswer({ text: '', transcript: '', audioB64: 'AAAA', audioMime: 'audio/webm', audioKept: true });
  assert.equal(fresh.audio_b64, 'AAAA');
  assert.equal(fresh.audio_keep, undefined);
  // Nothing kept, nothing recorded: the plain typed answer, unchanged.
  const typed = buildTextAnswer({ text: 'typed', transcript: '' });
  assert.equal(typed.audio_keep, undefined);
  assert.equal(typed.source, 'typed');
});

/* ------------------------------- client (jsdom) ------------------------------- */

const MCQ = {
  id: 'q2', competency_id: 'c1', type: 'mcq_single', order: 1, points: 4,
  prompt: 'A client wants medallion tables on Unity Catalog. Which layout is correct?',
  help_text: '', difficulty: 'intermediate', options: [
    { id: 'a', label: 'Bronze, silver and gold in one schema' },
    { id: 'b', label: 'One catalog per layer' },
    { id: 'c', label: 'Bronze raw, silver curated, gold served' },
  ],
  correct_option_ids: ['c'], audio_required: false,
};
const OPEN = {
  id: 'q7', competency_id: 'c1', type: 'text', order: 2, points: 6,
  prompt: 'Describe how you would roll out Unity Catalog to an existing workspace.',
  help_text: '', difficulty: 'advanced', options: [], correct_option_ids: [], audio_required: true,
};

function payload({ remaining = 24_000, index = 1, total = 3, complete = false, phase = 'answer', question = MCQ, answer = null } = {}) {
  return {
    assessment: { id: 'asm1', status: 'in_progress', started_at: null, submitted_at: null, role: { name: 'RSA', description: '' } },
    exam: {
      index, total, phase, remaining_ms: remaining, server_now: new Date().toISOString(),
      budgets: question.type === 'text' ? { review_ms: 60_000, answer_ms: 120_000 } : { review_ms: 0, answer_ms: 30_000 },
      integrity: {}, complete,
    },
    current_question: question,
    current_answer: answer,
    competency: { id: 'c1', name: 'Lakehouse Architecture', category: 'technical', description: '', order: 1 },
    questions: [question],
    competencies: [],
    answers: answer === null ? {} : { [question.id]: answer },
  };
}

const META = {
  questionTypes: [{ key: 'mcq_single', label: 'Multiple choice (single answer)' }, { key: 'text', label: 'Open / scenario response' }],
  assessmentStatuses: [{ key: 'in_progress', label: 'In progress' }],
  pipelineStages: [{ key: 'assessment', label: 'Assessment' }],
  userRoles: ['candidate'], difficulties: [], modules: [], families: [], moduleGroups: [],
  moduleTestStructure: {}, maxAssessmentQuestions: 50,
};

function fakeRecorder(window) {
  class FakeMediaRecorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(stream, opts) { this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: new window.Blob(['abcd'], { type: 'audio/webm' }) });
      if (this.onstop) this.onstop();
    }
  }
  return FakeMediaRecorder;
}

/**
 * A jsdom whose fetch replays `pages` in order and records every call. The
 * draft route answers like the real one (`accepted_question_ids`) unless
 * `draftReply` overrides it; `nextError` fails the lock until cleared.
 */
function setup({ pages = [payload()], nextError = null, draftReply = null, mic = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
    <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
  </body></html>`, { url: 'http://localhost:3000/#/assessments/asm1/quiz', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (mic) {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    window.MediaRecorder = fakeRecorder(window);
  }
  const calls = [];
  const intervals = [];
  let page = 0;
  const harness = { nextError, draftReply };
  const globals = {
    window, document: window.document, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Blob: window.Blob, FileReader: window.FileReader,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
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
      if (method === 'POST' && path.includes('/next')) {
        calls.push({ method, path, body: JSON.parse(opts.body || '{}') });
        if (harness.nextError) return json({ error: 'lock failed' }, harness.nextError);
        page += 1;
        return json(current());
      }
      if (method === 'PUT' && path.includes('/answers')) {
        const body = JSON.parse(opts.body || '{}');
        calls.push({ method, path, body });
        if (harness.draftReply) return json(harness.draftReply);
        return json({ ok: true, saved_at: new Date().toISOString(), accepted_question_ids: Object.keys(body.answers || {}), ignored_question_ids: [] });
      }
      if (method === 'POST' && path.includes('/phase')) { calls.push({ method, path, body: JSON.parse(opts.body || '{}') }); return json(current()); }
      if (method === 'GET') { calls.push({ method, path }); return json(current()); }
      calls.push({ method, path, body: JSON.parse(opts.body || '{}') });
      return json({ ok: true, ...current() });
    },
  };
  const saved = new Map();
  for (const [k, v] of Object.entries(globals)) { saved.set(k, globalThis[k]); globalThis[k] = v; }
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (mic) Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: window.navigator });
  window.localStorage.setItem('ecod.token', 'tok');
  window.sessionStorage.setItem('ecod.exam.ack.asm1', '1');
  const drafts = () => calls.filter((c) => c.method === 'PUT' && c.path.includes('/answers'));
  const locks = () => calls.filter((c) => c.method === 'POST' && c.path.includes('/next'));
  return {
    dom, window, calls, harness, drafts, locks,
    /** Leaves the hall the way the router does, so timers are released. */
    unmount() { window.document.dispatchEvent(new window.Event('ecod:view-unmount')); },
    async teardown() {
      dom.window.close();
      intervals.forEach((id) => nodeClearInterval(id));
      for (const k of ['fetch', 'setInterval', 'clearInterval', 'Blob', 'FileReader']) globalThis[k] = saved.get(k);
      if (mic) {
        if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
        else delete globalThis.navigator;
      }
    },
  };
}

const textOf = (view) => (view.textContent || '').replace(/\s+/g, ' ').trim();

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

test('a chosen option is autosaved as a draft while the clock runs; an unchanged one is not re-sent', { skip: SKIP }, async () => {
  const h = setup();
  try {
    const view = await paint(h);
    const inputs = view.querySelectorAll('.opt input');
    inputs[0].click();
    await flush(700);
    assert.equal(h.drafts().length, 1, 'the selection must reach the server as a draft');
    assert.deepEqual(h.drafts()[0].body, { answers: { q2: 'a' } });
    assert.match(h.drafts()[0].path, /\/candidate\/assessments\/asm1\/answers$/);

    inputs[1].click();
    await flush(700);
    assert.equal(h.drafts().length, 2, 'a changed selection is saved again');
    assert.deepEqual(h.drafts()[1].body.answers, { q2: 'b' });

    // Re-selecting what the server already has costs nothing.
    inputs[1].click();
    inputs[1].dispatchEvent(new h.window.Event('change'));
    await flush(700);
    assert.equal(h.drafts().length, 2, 'an unchanged answer is not re-sent');
    h.unmount();
  } finally { await h.teardown(); }
});

test('a draft the server merely ignores is sent once — never in a loop', { skip: SKIP }, async () => {
  // A reply without `accepted_question_ids` (an older API, or a draft ignored
  // because the window had closed) must not trigger endless re-sends.
  const h = setup({ draftReply: { ok: true } });
  try {
    const view = await paint(h);
    view.querySelector('.opt input').click();
    await flush(1500);
    assert.equal(h.drafts().length, 1, `an ignored draft must be sent exactly once (got ${h.drafts().length})`);
    h.unmount();
  } finally { await h.teardown(); }
});

test('a pending draft rides with the lock; a lost lock keeps the clock running and is re-sent when the window closes', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload({ remaining: 1800 }), payload({ index: 2, remaining: 24_000 })], nextError: 503 });
  try {
    const view = await paint(h);
    view.querySelector('.opt input').click();
    view.querySelector('#exam-next').click(); // before the debounce fired
    await flush(200);
    assert.equal(h.drafts().length, 1, 'the unsent draft must be flushed alongside the lock');
    assert.deepEqual(h.drafts()[0].body.answers, { q2: 'a' });
    assert.equal(h.locks().length, 1);
    const btn = view.querySelector('#exam-next');
    assert.ok(btn && !btn.disabled, 'the button is re-armed after the failed lock');
    const shownAfterFailure = view.querySelector('#exam-timer').textContent;

    // Server healthy again: the clock ran on, expiry fired the lock again, and
    // the next question is on screen.
    h.harness.nextError = null;
    await flush(2600);
    assert.ok(h.locks().length >= 2, `expiry must re-send the lock (locks: ${h.locks().length})`);
    assert.equal(h.locks().at(-1).body.answer, 'a', 'the retry still carries the answer');
    assert.match(textOf(view), /Question\s*3\s*of\s*3/, 'the paper moved on once the lock landed');
    assert.notEqual(view.querySelector('#exam-timer').textContent, shownAfterFailure, 'the countdown did not stay frozen');
    h.unmount();
  } finally { await h.teardown(); }
});

test('a lock that keeps failing after the window is retried on a backoff, not on every tick', { skip: SKIP }, async () => {
  const h = setup({ pages: [payload({ remaining: 300 })], nextError: 503 });
  try {
    const view = await paint(h);
    view.querySelector('.opt input').click();
    await flush(2500); // expiry → lock fails → one retry after the 4 s backoff at most
    const n = h.locks().length;
    assert.ok(n >= 1 && n <= 2, `a dead server must not be hammered (locks in 2.5 s: ${n})`);
    assert.match(textOf(view), /medallion tables/, 'the question stays on screen');
    h.unmount();
    const after = h.locks().length;
    await flush(300);
    assert.equal(h.locks().length, after, 'leaving the hall stops the retries');
  } finally { await h.teardown(); }
});

test('leaving the hall cancels a pending draft', { skip: SKIP }, async () => {
  const h = setup();
  try {
    const view = await paint(h);
    view.querySelector('.opt input').click();
    h.unmount();
    await flush(800);
    assert.equal(h.drafts().length, 0, 'no draft may be sent for a view that was left');
  } finally { await h.teardown(); }
});

test('a recording the server already holds is the spoken answer after a reload, and the lock keeps it', { skip: SKIP }, async () => {
  const restored = { text: '', transcript: '', source: 'audio', audio_ref: 'rec-1', audio_mime: 'audio/webm' };
  const h = setup({ pages: [payload({ question: OPEN, index: 2, answer: restored, remaining: 90_000 }), payload({ index: 3, complete: true })] });
  try {
    const view = await paint(h);
    assert.match(textOf(view), /Recorded answer restored/, 'the candidate is told their recording is safe');
    const btn = view.querySelector('#exam-next');
    assert.ok(btn && !btn.disabled, 'the restored recording counts as the answer');
    btn.click();
    await flush(300);
    const lock = h.locks()[0];
    assert.ok(lock, 'the lock was sent');
    assert.equal(lock.body.answer.audio_keep, true, 'the lock keeps the stored recording');
    assert.equal(lock.body.answer.audio_b64, undefined, 'nothing is re-uploaded');
    assert.equal(lock.body.answer.source, 'audio');
  } finally { await h.teardown(); }
});

test('a recording goes to the server when it stops; note edits and the lock then keep it instead of re-uploading', { skip: SKIP }, async () => {
  const h = setup({ mic: true, pages: [payload({ question: OPEN, index: 2, remaining: 90_000 }), payload({ index: 3, complete: true })] });
  try {
    const view = await paint(h);
    const recBtn = view.querySelector('#rec-btn');
    assert.ok(recBtn, 'the recorder is offered');
    recBtn.click(); // start
    await flush(120);
    recBtn.click(); // stop → clip ready
    for (let i = 0; i < 40 && h.drafts().length < 1; i += 1) await flush(50);
    assert.equal(h.drafts().length, 1, 'the clip is saved as soon as the recording stops');
    const first = h.drafts()[0].body.answers.q7;
    assert.ok(first.audio_b64, 'the first draft carries the clip');
    assert.equal(first.audio_keep, undefined);

    const ta = view.querySelector('#exam-ta');
    ta.value = 'supporting notes';
    ta.dispatchEvent(new h.window.Event('input'));
    await flush(1900);
    assert.equal(h.drafts().length, 2, 'note edits are autosaved');
    const second = h.drafts()[1].body.answers.q7;
    assert.equal(second.audio_b64, undefined, 'the clip is not uploaded again');
    assert.equal(second.audio_keep, true, 'the draft keeps the stored clip');
    assert.equal(second.text, 'supporting notes');

    view.querySelector('#exam-next').click();
    await flush(300);
    const lock = h.locks()[0];
    assert.ok(lock, 'the lock was sent');
    assert.equal(lock.body.answer.audio_keep, true, 'the lock keeps the clip the draft uploaded');
    assert.equal(lock.body.answer.audio_b64, undefined);
    assert.equal(lock.body.answer.text, 'supporting notes');
  } finally { await h.teardown(); }
});

test('locking while still recording sends the clip with the lock (nothing saved yet to keep)', { skip: SKIP }, async () => {
  const h = setup({ mic: true, pages: [payload({ question: OPEN, index: 2, remaining: 90_000 }), payload({ index: 3, complete: true })] });
  try {
    const view = await paint(h);
    view.querySelector('#rec-btn').click(); // start
    // The lock unlocks once the recorder has been live for 400 ms (the ticker
    // re-checks every 250 ms): wait for that rather than a fixed pause.
    const btn = view.querySelector('#exam-next');
    for (let i = 0; i < 40 && btn.disabled; i += 1) await flush(50);
    assert.equal(btn.disabled, false, 'a live recording unlocks the button');
    btn.click();
    for (let i = 0; i < 40 && h.locks().length < 1; i += 1) await flush(50);
    const lock = h.locks()[0];
    assert.ok(lock, 'the lock was sent');
    assert.ok(lock.body.answer.audio_b64, 'the clip travels with the lock');
    assert.equal(lock.body.answer.audio_keep, undefined);
  } finally { await h.teardown(); }
});

/* ------------------------------- server (API) ------------------------------- */

const CORRECT = 'b';
// A 4-byte "clip": small, valid base64.
const CLIP = Buffer.from('abcd').toString('base64');

async function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-autosave-'));
  const store = createJsonStore(path.join(tmp, 'db.json'));
  const app = await createApp(store);
  const role = await store.insert('roles', { key: 'draft', name: 'Draft Track', technology: 'X', description: '', active: true });
  const comp = await store.insert('competencies', {
    role_id: role.id, key: 'core', name: 'Core', category: 'technical', weight: 100, target_level: 3, order: 1, active: true,
  });
  const q = (overrides) => store.insert('questions', {
    role_id: role.id, competency_id: comp.id, type: 'mcq_single', help_text: '', difficulty: 'intermediate',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: [CORRECT],
    points: 4, rubric: '', order: 0, active: true, ...overrides,
  });
  await q({ prompt: 'Objective question: pick B.', order: 0 });
  await q({ type: 'text', points: 6, order: 1, prompt: 'Describe the rollout plan for the platform.', rubric: 'R', options: [], correct_option_ids: [] });
  await store.insert('frameworks', { role_id: role.id, name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG, active: true });
  const mkUser = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mkUser({ username: 'admin', name: 'Admin', role: 'admin', email: '', password: 'admin-pass-x' });
  const assessor = await mkUser({ username: 'assessor', name: 'Assessor', role: 'assessor', email: '', password: 'a-pass-x' });
  const candidate = await store.insert('candidates', { name: 'Candidate', stage: 'assessment', target_role_id: role.id });
  await mkUser({ username: 'candidate', name: 'Candidate', role: 'candidate', email: '', candidate_id: candidate.id, password: 'c-pass-x' });
  const call = (method, p, { token, body } = {}) => app({ method, path: p, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async (username, password) => (await call('POST', '/auth/login', { body: { username, password } })).body.token;
  const admin = await login('admin', 'admin-pass-x');
  const cand = await login('candidate', 'c-pass-x');
  const alloc = await call('POST', '/admin/assessments', { token: admin, body: { candidate_id: candidate.id, role_id: role.id, assessor_id: assessor.id } });
  assert.equal(alloc.status, 201, JSON.stringify(alloc.body));
  const id = alloc.body.id;
  const paper = sortedQuestions(alloc.body.snapshot_json);
  const w = {
    store, id, paper, cand,
    exam: () => call('GET', `/candidate/assessments/${id}`, { token: cand }).then((r) => r.body),
    put: (answers) => call('PUT', `/candidate/assessments/${id}/answers`, { token: cand, body: { answers } }),
    next: (question_id, answer = null) => call('POST', `/candidate/assessments/${id}/next`, { token: cand, body: { question_id, answer } }),
    phase: () => call('POST', `/candidate/assessments/${id}/phase`, { token: cand, body: { phase: 'answer' } }),
    row: async (qid) => (await store.list('responses', { assessment_id: id })).find((r) => r.question_id === qid),
    recordings: (qid) => store.list('recordings', { assessment_id: id, question_id: qid }),
    /** Step onto the open question, in its answer phase. */
    async toOpen() {
      let d = await w.exam();
      while (d.current_question && d.current_question.type !== 'text') {
        assert.equal((await w.next(d.current_question.id, CORRECT)).status, 200);
        d = await w.exam();
      }
      if (d.exam.phase === 'review') { await w.phase(); d = await w.exam(); }
      return d.current_question;
    },
  };
  return w;
}

test('audio_keep: a draft keeps the recording it uploaded through note edits, cleared notes and the lock', async () => {
  const w = await makeWorld();
  const open = await w.toOpen();

  const first = await w.put({ [open.id]: { text: '', transcript: '', source: 'audio', audio_b64: CLIP, audio_mime: 'audio/webm' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.accepted_question_ids, [open.id]);
  let row = await w.row(open.id);
  assert.ok(row.answer.audio_ref, 'the clip is stored and referenced');
  assert.equal(row.answer.audio_missing, undefined);
  const ref = row.answer.audio_ref;
  assert.equal((await w.recordings(open.id)).length, 1);

  // Notes typed after the recording: no clip in the request, the stored one kept.
  const edit = await w.put({ [open.id]: { text: 'supporting notes', transcript: '', source: 'audio', audio_keep: true } });
  assert.equal(edit.status, 200);
  row = await w.row(open.id);
  assert.equal(row.answer.text, 'supporting notes');
  assert.equal(row.answer.audio_ref, ref, 'the same recording is still referenced');
  assert.equal(row.answer.audio_missing, undefined, 'a kept recording is spoken evidence');
  assert.equal((await w.recordings(open.id)).length, 1, 'the recording row survives the text-only draft');

  // Notes cleared again: still an answer (the recording), not a wipe.
  const cleared = await w.put({ [open.id]: { text: '', transcript: '', source: 'audio', audio_keep: true } });
  assert.equal(cleared.status, 200);
  row = await w.row(open.id);
  assert.ok(row, 'the row is not removed while a recording is kept');
  assert.equal(row.answer.audio_ref, ref);
  assert.equal((await w.recordings(open.id)).length, 1);

  // The lock, without the clip: the recording is what gets locked.
  const lock = await w.next(open.id, { text: 'final notes', transcript: '', source: 'audio', audio_keep: true });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  row = await w.row(open.id);
  assert.equal(row.locked, true);
  assert.equal(row.answer.text, 'final notes');
  assert.equal(row.answer.audio_ref, ref, 'the locked answer keeps the recording');
  assert.equal(row.answer.audio_missing, undefined);
  assert.equal((await w.recordings(open.id)).length, 1);
  const a = await w.store.get('assessments', w.id);
  assert.equal(a.quiz_state.integrity?.spoken_answer_missing || 0, 0, 'no missing-recording count for a kept recording');
  assert.ok(!(a.quiz_state.events || []).some((e) => e.event === 'spoken_answer_missing'), 'and no exam-trail event');
});

test('audio_keep cannot plant evidence: with nothing stored the answer is flagged like any typed-only one', async () => {
  const w = await makeWorld();
  const open = await w.toOpen();

  const draft = await w.put({ [open.id]: { text: 'typed only', transcript: '', source: 'typed', audio_keep: true } });
  assert.equal(draft.status, 200);
  let row = await w.row(open.id);
  assert.equal(row.answer.audio_ref, undefined, 'nothing to keep, nothing referenced');
  assert.equal(row.answer.audio_missing, true, 'flagged exactly as before');
  assert.equal((await w.recordings(open.id)).length, 0);

  // A forged reference is dropped too, keep or no keep.
  const forged = await w.put({ [open.id]: { text: 'typed only', transcript: '', source: 'audio', audio_ref: 'rec-forged', audio_keep: true } });
  assert.equal(forged.status, 200);
  row = await w.row(open.id);
  assert.equal(row.answer.audio_ref, undefined);
  assert.equal(row.answer.audio_missing, true);

  const lock = await w.next(open.id, { text: 'typed only', transcript: '', source: 'typed', audio_keep: true });
  assert.equal(lock.status, 200);
  row = await w.row(open.id);
  assert.equal(row.locked, true);
  assert.equal(row.answer.audio_missing, true);
  const a = await w.store.get('assessments', w.id);
  assert.equal(a.quiz_state.integrity.spoken_answer_missing, 1, 'the proctoring counter still sees it');
  assert.ok((a.quiz_state.events || []).some((e) => e.event === 'spoken_answer_missing' && e.question_id === open.id), 'and the exam trail is still written');
});

test('a new clip replaces the kept one; a draft without clip or keep drops it (the posted answer is the answer)', async () => {
  const w = await makeWorld();
  const open = await w.toOpen();
  await w.put({ [open.id]: { text: '', transcript: '', source: 'audio', audio_b64: CLIP, audio_mime: 'audio/webm' } });
  const before = (await w.row(open.id)).answer.audio_ref;

  const again = Buffer.from('efgh').toString('base64');
  await w.put({ [open.id]: { text: '', transcript: '', source: 'audio', audio_b64: again, audio_mime: 'audio/webm', audio_keep: true } });
  const [rec] = await w.recordings(open.id);
  assert.equal((await w.recordings(open.id)).length, 1, 'one recording per question');
  assert.equal(rec.audio.b64, again, 'the new clip replaced the old one');
  assert.equal((await w.row(open.id)).answer.audio_ref, before, 'replaced in place');

  await w.put({ [open.id]: { text: 'typed instead', transcript: '', source: 'typed' } });
  assert.equal((await w.recordings(open.id)).length, 0, 'no clip and no keep: the recording is dropped');
  assert.equal((await w.row(open.id)).answer.audio_missing, true);
});
