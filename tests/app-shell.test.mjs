/**
 * App shell test: runs the real public/js/app.js in jsdom to prove the signed-in
 * chrome carries the Anthroprime ECOD brand and a working light/dark toggle.
 * The API is stubbed: bootstrap succeeds, every other call fails with 500 so the
 * route view lands in its own error state while the shell stays mounted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('signed-in shell: Anthroprime ECOD brand + theme toggle that persists', { skip: SKIP }, async () => {
  const dom = new JSDOM(
    `<!doctype html><html><head><meta name="theme-color" content="#eef6f7"></head><body>
       <div id="sidebar"></div><div id="nav-scrim"></div>
       <div id="topbar"></div><main id="view"></main>
       <div id="modal-root"></div><div id="toast-root"></div></body></html>`,
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
  });
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('/meta/bootstrap')) {
        return { ok: true, status: 200, json: async () => ({ pipelineStages: [], assessmentStatuses: [], readinessLevels: [] }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: 'stubbed' }) };
    };

    const app = await import('../public/js/app.js');
    await flush(60);
    assert.ok(document.querySelector('.auth-stage'), 'signed out → sign-in view');
    assert.equal(document.getElementById('sidebar').innerHTML, '', 'no shell while signed out');

    app.state.user = { name: 'Test Admin', role: 'admin', email: 'admin@anthroprime.com' };
    window.location.hash = '#/dashboard';
    await flush(80);

    const sidebar = document.getElementById('sidebar');
    assert.match(sidebar.innerHTML, /<strong>Anthroprime<\/strong>/, 'sidebar wordmark');
    assert.match(sidebar.innerHTML, /ECOD · Capability OS/, 'sidebar tagline');
    assert.match(sidebar.querySelector('.logo').getAttribute('aria-label'), /Anthroprime ECOD home/);

    const topbar = document.getElementById('topbar');
    assert.match(topbar.innerHTML, /Anthroprime ECOD/, 'topbar eyebrow');

    const btn = topbar.querySelector('#theme-toggle');
    assert.ok(btn, 'theme toggle rendered in the topbar');
    const before = document.documentElement.dataset.theme;
    const expected = before === 'dark' ? 'light' : 'dark';
    assert.match(btn.getAttribute('aria-label'), new RegExp(`Switch to ${expected} mode`), 'label offers the other theme');

    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(document.documentElement.dataset.theme, expected, 'theme flipped');
    assert.equal(localStorage.getItem('anthroprime-ecod-theme'), expected, 'choice persisted for the next visit');
    assert.match(btn.getAttribute('aria-label'), new RegExp(`Switch to ${before} mode`), 'label follows the new state');
  } finally {
    dom.window.close();
    for (const k of ['window', 'document', 'location', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch']) delete globalThis[k];
  }
});
