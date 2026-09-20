/**
 * Regression tests for the sign-out blank-screen bug.
 *
 * `.view-enter` (the route-change fade-in) used to stay on #view forever —
 * its `both` fill kept a transform applied, which made #view the containing
 * block for the fixed sign-in overlay (.auth-stage lives inside #view).
 * After sign-out or session expiry the login screen collapsed into a ~106px
 * strip and the page had to be reloaded. These pin the two halves of the fix:
 * animateView() must retire the class, and loginView() must never mount
 * under a stale one.
 *
 * jsdom is an optionalDependency: without it the suite reports skips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const SHELL_HTML = `<!doctype html><html><head><meta name="theme-color" content="#eef6f7"></head>
  <body><div id="sidebar"></div><div id="topbar"></div><main id="view"></main><div id="toast-root"></div></body></html>`;

function setupDom() {
  const dom = new JSDOM(SHELL_HTML, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  if (!globalThis.performance) globalThis.performance = window.performance;
  return dom;
}

function teardownDom(dom) {
  dom.window.close();
  for (const k of ['window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    delete globalThis[k];
  }
}

test('animateView removes .view-enter after the entrance animation', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = document.getElementById('view');
    const { animateView } = await import('../public/js/motion.js');

    animateView(view);
    assert.ok(view.classList.contains('view-enter'), 'class applied while animating');

    // jsdom fires no CSS animation events, so this exercises the fallback
    // timer path (700ms) — the same cleanup runs on animationend in browsers.
    await new Promise((r) => setTimeout(r, 850));
    assert.ok(!view.classList.contains('view-enter'), 'class retired after the animation window');
    assert.equal(view._endViewEnter, null, 'cleanup handle cleared');
  } finally { teardownDom(dom); }
});

test('animateView re-renders do not stack stale cleanup handlers', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const view = document.getElementById('view');
    const { animateView } = await import('../public/js/motion.js');

    animateView(view);
    const first = view._endViewEnter;
    animateView(view); // e.g. queued rerender lands mid-animation
    assert.notEqual(view._endViewEnter, first, 'superseded handle replaced');
    assert.ok(view.classList.contains('view-enter'), 'still animating after re-trigger');

    await new Promise((r) => setTimeout(r, 850));
    assert.ok(!view.classList.contains('view-enter'), 'exactly the live handler retires the class');
  } finally { teardownDom(dom); }
});

test('loginView strips a stale .view-enter before mounting the overlay', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    // Mount-time dependency of login.js: static fetch for module load is not
    // needed, but a fetch stub keeps any accidental network call harmless.
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const { loginView } = await import('../public/js/views/login.js');
    const view = document.getElementById('view');
    view.classList.add('view-enter'); // e.g. 401 landed mid entrance animation

    const wrap = loginView(view, () => {});
    assert.ok(wrap?.classList.contains('auth-stage') && wrap.parentElement === view,
      'sign-in overlay mounted');
    assert.ok(!view.classList.contains('view-enter'),
      'overlay never mounts under a transform-bearing container');
  } finally { teardownDom(dom); }
});
