/**
 * Front-end regressions from the project audit, run against the real modules
 * in jsdom with a stubbed fetch:
 *
 *  1. boot() must not sign the user out when restoring the session fails for
 *     any reason other than a 401 (a blip at page load used to wipe the token).
 *  2. The assessor scoring screen must survive a paper whose questions are not
 *     all claimed by a snapshot competency (it used to die on the first
 *     missing score input and render nothing scorable).
 *
 * One DOM and one fetch router for the whole file: app.js self-boots on first
 * import and node:test may interleave sibling tests, so the scenarios run
 * sequentially inside a single test. jsdom is optional; without it this skips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const SHELL_HTML = `<!doctype html><html><head><meta name="theme-color" content="#eef6f7"></head>
  <body><div id="sidebar"></div><div id="nav-scrim"></div><div id="topbar"></div><main id="view"></main>
  <div id="toast-root"></div><div id="modal-root"></div></body></html>`;

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('ui resilience: session restore and the assessor scoring screen', { skip: SKIP }, async (t) => {
  const dom = new JSDOM(SHELL_HTML, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;
  t.after(() => {
    dom.window.close();
    for (const k of ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch']) {
      delete globalThis[k];
    }
  });
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });

  const calls = [];
  let handler = () => ({ status: 404, body: {} });
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^.*\/api/, '/api');
    calls.push(path);
    if (path.includes('/meta/bootstrap')) {
      return { ok: true, status: 200, json: async () => ({ pipelineStages: [], assessmentStatuses: [], readinessLevels: [] }) };
    }
    const out = handler(path, opts.body ? JSON.parse(opts.body) : undefined, opts);
    return { ok: out.status < 400, status: out.status, json: async () => out.body ?? {} };
  };

  // A saved session whose /auth/me fails with a 503 while the page loads.
  localStorage.setItem('ecod.token', 'saved-token');
  handler = (path) => (path.includes('/auth/me') ? { status: 503, body: { error: 'warming up' } } : { status: 404, body: {} });
  const app = await import('../public/js/app.js');
  await flush(80);

  await t.test('a non-401 failure restoring the session keeps the token and offers a retry', async () => {
    assert.equal(localStorage.getItem('ecod.token'), 'saved-token', 'the token survives a server error');
    const view = document.getElementById('view');
    assert.match(view.textContent, /Could not restore your session/);
    assert.ok(view.querySelector('#boot-retry'), 'retry button rendered');
    assert.ok(!view.querySelector('.auth-stage'), 'not bounced to the sign-in form');

    // Retry once the server is back: the saved session signs straight in.
    handler = (path) => {
      if (path.includes('/auth/me')) return { status: 200, body: { user: { id: 'u1', name: 'Priya', role: 'assessor', email: '' }, candidate: null } };
      if (path.includes('/assessor/assessments')) return { status: 200, body: { assessments: [] } };
      return { status: 404, body: {} };
    };
    view.querySelector('#boot-retry').click();
    await flush(120);
    assert.equal(app.state.user?.name, 'Priya', 'signed in from the saved token');
    assert.equal(localStorage.getItem('ecod.token'), 'saved-token');
  });

  await t.test('a 401 while restoring the session still signs the user out', async () => {
    app.state.user = null;
    handler = (path) => (path.includes('/auth/me') ? { status: 401, body: { error: 'expired' } } : { status: 404, body: {} });
    // boot() is not exported; drive it the way the retry button does.
    localStorage.setItem('ecod.token', 'stale-token');
    const { me } = await import('../public/js/api.js');
    await assert.rejects(() => me());
    assert.equal(localStorage.getItem('ecod.token'), null, 'api() drops the token on 401');
  });

  await t.test('the scoring screen renders (and wires) questions no snapshot competency claims', async () => {
    app.state.user = { id: 'u1', name: 'Priya', role: 'assessor', email: '' };
    app.state.meta = { pipelineStages: [], assessmentStatuses: [], readinessLevels: [] };
    const puts = [];
    handler = (path, body, opts) => {
      if (path.includes('/assessor/assessments/a1/scores')) { puts.push(body); return { status: 200, body: { ok: true } }; }
      if (path.includes('/assessor/assessments/a1')) {
        return {
          status: 200,
          body: {
            assessment: { id: 'a1', status: 'submitted', submitted_at: '2026-09-20T10:00:00.000Z', role: { name: 'RSA' } },
            candidate: { name: 'Rohit', current_title: 'SDE', years_experience: 5 },
            competencies: [{ id: 'c1', name: 'Architecture', weight: 100, target_level: 4 }],
            questions: [
              { id: 'q1', competency_id: 'c1', type: 'text', prompt: 'Grouped open question', points: 5, difficulty: 'intermediate', audio_required: true },
              { id: 'q2', competency_id: 'c-gone', type: 'text', prompt: 'Orphaned open question', points: 5, difficulty: 'intermediate', audio_required: true },
              { id: 'q3', competency_id: 'c-gone', type: 'mcq_single', prompt: 'Orphaned choice', points: 4, difficulty: 'foundation', options: [{ id: 'a', label: 'A' }], correct_option_ids: ['a'] },
            ],
            responses: [
              { question_id: 'q1', answer: { text: 'one', transcript: 'one', source: 'audio' } },
              { question_id: 'q2', answer: { text: 'two', transcript: 'two', source: 'audio' } },
              { question_id: 'q3', answer: 'a', auto_score: 4 },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    };
    const { assessmentView } = await import('../public/js/views/assessor.js');
    const view = document.getElementById('view');
    await assessmentView(view, { id: 'a1' });
    assert.match(view.textContent, /Grouped open question/);
    assert.match(view.textContent, /Orphaned open question/, 'the orphan is shown, not dropped');
    assert.match(view.textContent, /Other questions/, 'under its own fallback section');
    assert.match(view.querySelector('#score-progress').textContent, /0\/2 open questions scored/);
    const input = view.querySelector('#score-q2');
    assert.ok(input, 'the orphan gets a score input');
    input.value = '4';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(30);
    assert.equal(puts.length, 1, 'scoring the orphan saves');
    assert.deepEqual(puts[0].scores[0], { question_id: 'q2', score: 4, comment: '' });
    assert.match(view.querySelector('#score-progress').textContent, /1\/2 open questions scored/);
  });
});
