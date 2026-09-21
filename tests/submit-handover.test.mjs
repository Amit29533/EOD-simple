/**
 * End-of-exam submit handover tests.
 *
 * The final "Lock & submit" used to leave the candidate staring at a frozen
 * exam screen for the whole /next + /submit + journey-reload sequence (easily
 * 5-15s on a cold serverless function), with re-clicks silently swallowed and
 * a failed submit navigating away as if nothing was wrong. These pin the
 * retrying submitExam() and both handover outcomes of finalizeExam().
 *
 * All scenarios run sequentially inside one test on one shared DOM with a
 * single fetch router: node:test may schedule sibling tests concurrently, and
 * a per-test window/fetch swap under a still-polling sibling is exactly the
 * cross-test interference this suite must not have.
 *
 * jsdom is an optionalDependency: without it the suite reports skips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const SHELL_HTML = `<!doctype html><html><head><meta name="theme-color" content="#eef6f7"></head>
  <body><div id="sidebar"></div><div id="topbar"></div><main id="view"></main><div id="toast-root"></div><div id="modal-root"></div></body></html>`;

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('submit handover: retrying submit + both finalizeExam outcomes', { skip: SKIP }, async (t) => {
  const dom = new JSDOM(SHELL_HTML, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;
  t.after(() => {
    dom.window.close();
    for (const k of ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
      delete globalThis[k];
    }
  });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

  // One fetch router for the whole suite; each scenario installs its handler.
  // app.js self-boots on first import, so a default handler must exist first.
  const calls = [];
  let handler = () => ({ status: 404, body: {} });
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url).replace(/^.*\/api/, '/api'));
    if (String(url).includes('/meta/bootstrap')) {
      return { ok: true, status: 200, json: async () => ({ pipelineStages: [], assessmentStatuses: [], readinessLevels: [] }) };
    }
    const out = handler(String(url), opts.body ? JSON.parse(opts.body) : undefined);
    if (out.pending) {
      // A server that never answers — a serverless invocation killed mid-write,
      // a proxy holding the connection open. The only way out is the caller's
      // own deadline, so honor the abort signal exactly like a real fetch.
      return new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        if (opts.signal?.aborted) abort();
        else opts.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    return { ok: out.status < 400, status: out.status, json: async () => out.body ?? {} };
  };

  /** Clean slate between scenarios. */
  const reset = () => {
    calls.length = 0;
    document.getElementById('view').innerHTML = '';
    document.getElementById('toast-root').innerHTML = '';
    if (window.location.hash) window.location.hash = '';
  };
  const submits = () => calls.filter((c) => c.includes('/submit'));
  const hash = () => window.location.hash.replace(/^#/, '');

  const { submitExam, finalizeExam } = await import('../public/js/views/candidate.js');

  await t.test('submitExam retries transient 5xx failures and succeeds', async () => {
    reset();
    handler = () => ({ status: 500, body: { error: 'boom' } });
    // Third attempt succeeds via a one-shot override.
    let n = 0;
    const prev = handler;
    handler = (url, body) => (++n >= 3 ? { status: 200, body: { status: 'submitted' } } : prev(url, body));
    const out = await submitExam('a1', { attempts: 3, backoffMs: 1 });
    assert.equal(out.status, 'submitted');
    assert.equal(submits().length, 3, 'succeeded on the third attempt');
  });

  await t.test('submitExam treats 409 (already submitted) as success without retrying', async () => {
    reset();
    handler = () => ({ status: 409, body: { error: 'already submitted' } });
    const out = await submitExam('a1', { attempts: 3, backoffMs: 1 });
    assert.equal(out.status, 'submitted');
    assert.equal(out.already, true);
    assert.equal(submits().length, 1, 'no retry after 409');
  });

  await t.test('submitExam throws immediately on non-retryable 4xx', async () => {
    reset();
    handler = () => ({ status: 422, body: { error: 'nope' } });
    await assert.rejects(() => submitExam('a1', { attempts: 3, backoffMs: 1 }));
    assert.equal(submits().length, 1, 'a 422 must not be retried');
  });

  await t.test('submitExam exhausts its attempts on persistent 500s and throws', async () => {
    reset();
    handler = () => ({ status: 500, body: { error: 'boom' } });
    await assert.rejects(() => submitExam('a1', { attempts: 3, backoffMs: 1 }));
    assert.equal(submits().length, 3, 'retried exactly attempts-1 times');
  });

  await t.test('finalizeExam shows the handover panel immediately, then lands on journey', async () => {
    reset();
    handler = () => ({ status: 200, body: { status: 'submitted' }, delayMs: 60 });
    const done = finalizeExam('a1', { attempts: 1 });
    await flush(10);
    assert.ok(document.querySelector('.submit-handover'), 'handover panel replaces the exam screen at once');
    assert.match(document.querySelector('.submit-handover').textContent, /Submitting your assessment/);
    for (let i = 0; i < 60 && hash() !== '/journey'; i++) await flush(25);
    assert.equal(hash(), '/journey', 'navigates to My Journey after submit');
    assert.ok(document.getElementById('toast-root').textContent.includes('Assessment submitted'), 'success toast');
    await done;
  });

  await t.test('finalizeExam stays on a retry screen when submit keeps failing', async () => {
    reset();
    handler = () => ({ status: 500, body: { error: 'boom' } });
    await finalizeExam('a1', { attempts: 2, backoffMs: 1 });
    assert.notEqual(hash(), '/journey', 'does NOT navigate away on failure');
    const retry = document.querySelector('#submit-retry');
    assert.ok(retry, 'explicit retry affordance');
    assert.match(document.getElementById('view').textContent, /couldn't submit your assessment/);
    assert.ok(document.querySelector('a[href="#/journey"]'), 'escape hatch to My Journey');
  });

  await t.test('a submit that never answers times out onto the retry screen, never a dead spinner', async () => {
    // The reported freeze: the submit POST is never answered (a serverless
    // function killed mid-write, a stalled proxy), the browser's fetch has no
    // deadline, and the candidate is left on "Submitting your assessment…"
    // forever — no error, no retry, nothing to click. Each attempt now carries
    // a deadline, so the panel always resolves into either the journey or the
    // retry screen.
    reset();
    handler = () => ({ pending: true });
    await finalizeExam('a1', { attempts: 2, backoffMs: 1, timeoutMs: 40 });
    assert.doesNotMatch(document.getElementById('view').textContent, /Submitting your assessment/,
      'the handover spinner must not be left behind');
    assert.match(document.getElementById('view').textContent, /couldn't submit your assessment/);
    assert.ok(document.querySelector('#submit-retry'), 'the candidate can try again');
    assert.equal(submits().length, 2, 'each attempt carries its own deadline');
    assert.notEqual(hash(), '/journey', 'a hung submit must not pretend the paper was delivered');
  });

  await t.test('the handover says it is still working when a submit drags on', async () => {
    reset();
    handler = () => ({ status: 200, body: { status: 'submitted' }, delayMs: 200 });
    const done = finalizeExam('a1', { attempts: 1, slowHintMs: 40 });
    await flush(10);
    assert.ok(document.querySelector('.submit-handover'), 'the panel is up while the submit is in flight');
    assert.equal(document.querySelector('#submit-slow').hidden, true, 'silent while the submit is on schedule');
    await flush(90);
    assert.equal(document.querySelector('#submit-slow').hidden, false, 'reassures once the submit drags on');
    for (let i = 0; i < 40 && hash() !== '/journey'; i++) await flush(25);
    assert.equal(hash(), '/journey', 'a slow-but-successful submit still lands on My Journey');
    await done;
  });
});
