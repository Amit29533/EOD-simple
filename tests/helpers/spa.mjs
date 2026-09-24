/**
 * jsdom harness for the SPA point-of-view suites (pov-ui-*.test.mjs).
 *
 * Boots the real single-page app shell in jsdom with a stubbed `fetch`: a
 * test supplies a `routes(method, path, body, query)` function that answers
 * API calls the way the server would, and gets back a record of every call.
 * The views are imported from public/js, exactly as the browser loads them.
 *
 * Import the view modules only AFTER `bootSpa()`: app.js reads `location`
 * and paints `#view` at import time. Each pov-ui file runs in its own process
 * under `node --test`, so every file starts from fresh module state; within a
 * file, app.js boots once and later tests reuse the module with a new DOM.
 */
import { JSDOM } from './jsdom.mjs';

const GLOBALS = [
  'window', 'document', 'location', 'localStorage', 'sessionStorage', 'Blob', 'FileReader',
  'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'Event', 'KeyboardEvent',
  'MouseEvent', 'fetch', 'confirm', 'alert', 'IntersectionObserver', 'ResizeObserver', 'matchMedia',
];

export const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

export const META = {
  pipelineStages: [
    { key: 'intake', label: 'Intake' }, { key: 'assessment', label: 'Assessment' },
    { key: 'gap_mapping', label: 'Gap mapping' },
  ],
  assessmentStatuses: [
    { key: 'assigned', label: 'Assigned' }, { key: 'in_progress', label: 'In progress' },
    { key: 'submitted', label: 'Submitted' }, { key: 'scored', label: 'Scored' },
  ],
  userRoles: ['admin', 'assessor', 'candidate'],
  questionTypes: [
    { key: 'mcq_single', label: 'Multiple choice (single answer)' },
    { key: 'text', label: 'Open / scenario response' },
  ],
  difficulties: ['foundation', 'intermediate', 'advanced'],
  modules: [], families: [], moduleGroups: [], moduleTestStructure: {}, maxAssessmentQuestions: 50,
};

/**
 * @param {object} opts
 * @param {string} [opts.hash]   initial route, e.g. '#/assessments'
 * @param {object} opts.user     the signed-in user (`/auth/me`)
 * @param {object} [opts.candidate]  the linked candidate for a candidate user
 * @param {(method: string, path: string, body: any, query: URLSearchParams) => any} [opts.routes]
 *   returns `{ status, body }`, a plain body (200), or undefined (falls through to `{}`)
 * @param {boolean} [opts.stubTimers]  replace setInterval with a no-op (exam screens)
 * @param {{ app: Function, token: string }} [opts.backend]
 *   the real in-process API (`createApp`) and a real session token: every
 *   request, `/auth/me` and `/meta/bootstrap` included, is forwarded to it
 *   with that token, so the views run against the actual server. `user`,
 *   `candidate` and `routes` are then ignored.
 */
export async function bootSpa({ hash = '#/', user, candidate = null, routes = () => undefined, backend = null, stubTimers = false } = {}) {
  // The exam's countdown is a live interval: left running it keeps the test
  // process alive after the file is done. `stubTimers` swaps setInterval for
  // a no-op for the life of this DOM (timeouts stay real).
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  if (stubTimers) {
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
  }
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
    <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
  </body></html>`, { url: `http://localhost:3000/${hash}`, pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};

  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const full = new URL(String(url), 'http://localhost:3000');
    const path = full.pathname.replace(/^\/api/, '');
    let body;
    try { body = opts.body ? JSON.parse(opts.body) : undefined; } catch { body = opts.body; }
    calls.push({ method, path, body, query: Object.fromEntries(full.searchParams) });
    if (backend) {
      const r = await backend.app({
        method, path, query: Object.fromEntries(full.searchParams),
        headers: { authorization: `Bearer ${backend.token}` }, body,
      });
      return json(r.body, r.status);
    }
    if (path === '/meta/bootstrap') return json(META);
    if (path === '/auth/me') return json({ user, candidate });
    const out = await routes(method, path, body, full.searchParams);
    if (out && typeof out === 'object' && 'status' in out && 'body' in out) return json(out.body, out.status);
    return json(out === undefined ? {} : out);
  };

  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: window.navigator });
  Object.assign(globalThis, {
    window, document: window.document, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Blob: window.Blob, FileReader: window.FileReader,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HashChangeEvent: window.HashChangeEvent, Event: window.Event,
    KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent,
    fetch, confirm: () => true, alert: () => {},
    // The views reach for these as bare globals, as a browser allows.
    IntersectionObserver: window.IntersectionObserver, ResizeObserver: window.ResizeObserver,
    matchMedia: window.matchMedia,
  });
  window.fetch = fetch;
  window.confirm = () => true;

  // app.js boots on import and renders the current route. With no session
  // token yet it settles on the static sign-in screen, which fetches nothing,
  // so no boot render can land on `#view` after the test paints its view.
  // The token and the signed-in state are set once the boot is done.
  const app = await import('../../public/js/app.js');
  await flush(20);
  // The test drives the views itself. app.js binds its router to the window
  // it booted on, which is only the first DOM of a file; detaching it keeps
  // every test in a file alike, and stops a hash change (the exam's handover
  // to '#/journey', say) from rendering a second view behind the test.
  window.onhashchange = null;
  window.localStorage.setItem('ecod.token', backend ? 'backend-session' : 'test-token');
  if (backend) {
    const auth = { authorization: `Bearer ${backend.token}` };
    const meRes = await backend.app({ method: 'GET', path: '/auth/me', query: {}, headers: auth });
    const metaRes = await backend.app({ method: 'GET', path: '/meta/bootstrap', query: {}, headers: {} });
    app.state.user = meRes.body.user;
    app.state.candidate = meRes.body.candidate;
    app.state.meta = metaRes.body;
  } else {
    app.state.user = user;
    app.state.candidate = candidate;
    app.state.meta = META;
  }
  await flush(50); // let the boot render settle before the test paints

  const view = window.document.getElementById('view');
  return {
    dom, window, document: window.document, view, calls, app,
    /** Calls to `path` (exact string or RegExp), optionally by method. */
    callsTo: (path, method) => calls.filter((c) => (path instanceof RegExp ? path.test(c.path) : c.path === path)
      && (!method || c.method === method)),
    text: () => view.textContent.replace(/\s+/g, ' ').trim(),
    teardown() {
      window.close();
      for (const k of GLOBALS) delete globalThis[k];
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

/** Sets an input's value and fires the events a user's typing would. */
export function type(el, value) {
  el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
}
