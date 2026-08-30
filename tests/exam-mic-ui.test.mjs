/**
 * Exam answer-screen UI test (jsdom).
 *
 * The reported bug: the microphone control was rendered only for questions the
 * stored row happened to flag, so the standard open questions late in the paper
 * (typically 7-10 of a 10-question allocation) showed a bare text box. These
 * tests drive the real `quizView` against a stubbed API and assert that an open
 * question always gets the recorder, that the recording is what unlocks
 * "Lock & continue", and that a browser without capture support is never
 * stranded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A standard (non-spoken) open question, answer phase, mid-paper. */
function openQuestionPayload({ phase = 'answer', audio_required = true } = {}) {
  const q = {
    id: 'q7', competency_id: 'comp1', type: 'text', order: 6, points: 6,
    prompt: 'A streaming pipeline has grown from one million to one hundred million events a day. Redesign it.',
    help_text: '', options: [], difficulty: 'advanced', pin_first: false, audio_required,
  };
  return {
    assessment: { id: 'asm1', status: 'in_progress', started_at: null, submitted_at: null, role: { name: 'RSA', description: '' } },
    exam: {
      index: 6, total: 10, phase, remaining_ms: 118_000, server_now: new Date().toISOString(),
      budgets: { review_ms: 60_000, answer_ms: 120_000 }, integrity: {}, complete: false,
    },
    current_question: q,
    current_answer: null,
    competency: null,
    questions: [q],
    competencies: [],
    answers: {},
  };
}

function fakeRecorder(window) {
  // Emits a tiny real blob on stop(), i.e. a captured answer that fits storage.
  class FakeMediaRecorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(stream, opts) {
      FakeMediaRecorder.created.push({ stream, opts });
      this.state = 'inactive';
      this.mimeType = (opts && opts.mimeType) || 'audio/webm';
    }
    start() {
      this.state = 'recording';
      FakeMediaRecorder.started += 1;
    }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: new window.Blob(['abcd'], { type: 'audio/webm' }) });
      if (this.onstop) this.onstop();
    }
  }
  FakeMediaRecorder.created = [];
  FakeMediaRecorder.started = 0;
  return FakeMediaRecorder;
}

async function setupDom({ payload, capture = true }) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="sidebar"></div><div id="topbar"></div><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
    { url: 'http://localhost:3000/#/assessments/asm1/quiz', pretendToBeVisual: true },
  );
  const { window } = dom;
  const calls = { next: [], phase: [], integrity: [], submit: [] };
  if (capture) {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    window.MediaRecorder = fakeRecorder(window);
  }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = String(url).replace(/^\/api/, '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (path.includes('/meta/bootstrap')) return json({ pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] });
    if (path.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Rohit', role: 'candidate', email: '' }, candidate: { id: 'c1' } });
    if (path === '/candidate/assessments/asm1' && method === 'GET') return json(payload());
    if (path.endsWith('/phase')) { calls.phase.push(body); return json({ phase: 'answer', remaining_ms: 120_000 }); }
    if (path.endsWith('/next')) { calls.next.push(body); return json({ complete: false, index: payload().exam.index + 1, total: 10 }); }
    if (path.endsWith('/submit')) { calls.submit.push(body); return json({ status: 'submitted' }); }
    if (path.endsWith('/integrity')) { calls.integrity.push(body); return json({ integrity: {}, events: [] }); }
    return json({});
  };

  // Node's global `navigator` is getter-only; the exam code reaches for the bare
  // global, so it has to be redefined rather than assigned.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: window.navigator });
  // The session ticker is a live interval; stub it so the exam can be inspected
  // (and the test process can exit) without a running countdown.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};

  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Blob: window.Blob,
    FileReader: window.FileReader,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HashChangeEvent: window.HashChangeEvent,
  });
  window.localStorage.setItem('ecod.token', 'test-token');
  window.sessionStorage.setItem('ecod.exam.ack.asm1', '1'); // skip the rules gate

  const app = await import('../public/js/app.js');
  app.state.user = { id: 'u1', name: 'Rohit', role: 'candidate', email: '' };
  app.state.meta = {
    pipelineStages: [],
    assessmentStatuses: [],
    questionTypes: [{ key: 'text', label: 'Open / scenario response' }],
    difficulties: ['advanced'],
  };
  return { dom, window, calls, restoreTicker: () => { globalThis.setInterval = realSetInterval; } };
}

function teardown(ctx) {
  ctx.restoreTicker();
  ctx.dom.window.close();
  for (const k of ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'Blob', 'FileReader', 'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'fetch']) {
    delete globalThis[k];
  }
}

test('an open question renders the mandatory microphone beside the optional text box', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.ok(view.querySelector('#rec-btn'), 'the record control is rendered for a standard open question');
    assert.equal(view.querySelector('#rec-label').textContent.trim(), 'Record answer');
    assert.ok(view.querySelector('.exam-answer').classList.contains('has-audio'), 'the answer box uses the mic layout');
    assert.match(view.querySelector('#rec-state').textContent, /Required/i);
    assert.match(view.querySelector('#exam-ta').placeholder, /Optional notes/i, 'the text box is the optional channel');
    assert.match(view.innerHTML, /Recorded answer required/, 'the question is labelled as microphone-required');
    assert.match(view.innerHTML, /Recording window · 2 min/);
  } finally {
    teardown(ctx);
  }
});

test('the lock button stays disabled until the candidate has actually spoken', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    const next = view.querySelector('#exam-next');
    const ta = view.querySelector('#exam-ta');
    assert.equal(next.disabled, true, 'a typed-only answer cannot lock an open question');
    ta.value = 'Typed notes without a recording.';
    ta.oninput();
    assert.equal(next.disabled, true, 'typing does not satisfy the microphone requirement');
    assert.match(next.title, /Record your spoken answer/);

    view.querySelector('#rec-btn').click();
    await flush(80);
    assert.equal(ctx.window.MediaRecorder.started, 1, 'record was started through the browser recorder');
    assert.equal(ctx.window.MediaRecorder.created.at(-1).opts.audioBitsPerSecond > 0, true, 'a speech-sized recording profile is requested');

    view.querySelector('#rec-btn').click(); // stop -> the clip is captured
    await flush(80);
    assert.match(view.querySelector('#rec-state').textContent, /Audio saved/i);
    assert.equal(next.disabled, false, 'a captured recording unlocks the exam');

    next.click();
    await flush(80);
    const sent = ctx.calls.next[ctx.calls.next.length - 1];
    assert.ok(sent.answer.audio_b64, 'the recording is what gets submitted');
    assert.equal(sent.answer.text, 'Typed notes without a recording.', 'the optional notes travel with it');
  } finally {
    teardown(ctx);
  }
});

test('the review window tells the candidate to record and offers a microphone pre-check', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload({ phase: 'review' }) });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.ok(view.querySelector('#mic-check'), 'the candidate can grant microphone access before the timer starts');
    assert.match(view.querySelector('.exam-review').textContent, /record your spoken answer/i);
    assert.match(view.querySelector('.exam-review').textContent, /microphone is required/i);
    view.querySelector('#mic-check').click();
    await flush(40);
    assert.match(view.querySelector('#mic-check-state').textContent, /Microphone ready/i);

    const next = view.querySelector('#exam-next');
    assert.match(next.textContent, /Start answering/);
    next.click();
    await flush(60);
    assert.equal(ctx.calls.phase.at(-1)?.phase, 'answer', 'the review window hands over to the answer phase');
  } finally {
    teardown(ctx);
  }
});

test('a browser that cannot capture audio is never hard-locked by the requirement', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), capture: false });
  try {
    assert.equal(ctx.window.MediaRecorder, undefined, 'this browser has no recorder');
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.match(view.querySelector('.exam-mic-note').textContent, /cannot capture microphone audio/i);
    const ta = view.querySelector('#exam-ta');
    ta.value = 'Fallback typed answer for a browser without microphone support.';
    ta.oninput();
    const next = view.querySelector('#exam-next');
    assert.equal(next.disabled, false, 'the candidate can still submit instead of timing out');
    next.click();
    await flush(60);
    const sent = ctx.calls.next.at(-1);
    assert.match(sent.answer.text, /Fallback typed answer/, 'the answer is preserved, not discarded');
  } finally {
    teardown(ctx);
  }
});
