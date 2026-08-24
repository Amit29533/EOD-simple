/**
 * Sign-in view + theme manager tests.
 *
 * These run the real browser modules (public/js/views/login.js, public/js/theme.js)
 * inside jsdom, so the assertions cover the markup, the theme switch, the password
 * toggle, the demo quick-fill and both submit paths — not a re-implementation.
 * jsdom is an optionalDependency: when it is not installed the suite reports skips
 * instead of failing, keeping `npm test` dependency-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const SHELL_HTML = `<!doctype html><html><head><meta name="theme-color" content="#eef6f7"></head>
  <body><div id="sidebar"></div><div id="topbar"></div><main id="view"></main><div id="toast-root"></div></body></html>`;

/** Boot a jsdom window with the globals the browser modules expect. */
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
  for (const k of ['window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch']) {
    delete globalThis[k];
  }
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Mount the login view with a stubbed /api/auth/login. */
async function mount({ status = 200, body = { token: 'tok', user: { name: 'Rohit Verma', role: 'candidate' } } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body || '{}') });
    return { ok: status < 400, status, json: async () => body };
  };
  const { loginView } = await import('../public/js/views/login.js');
  const view = document.getElementById('view');
  const signedIn = [];
  loginView(view, (res) => signedIn.push(res));
  await flush(); // entrance rAF
  return { wrap: view.querySelector('.auth-stage'), calls, signedIn };
}

test('theme.js applies, persists and resolves the colour theme', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const theme = await import('../public/js/theme.js');
    assert.equal(document.documentElement.dataset.theme, undefined, 'nothing set before applyTheme()');

    theme.applyTheme('dark');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.documentElement.dataset.themePref, 'dark');
    assert.equal(document.documentElement.style.colorScheme, 'dark');
    assert.equal(document.querySelector('meta[name="theme-color"]').getAttribute('content'), '#060f17');

    theme.setThemePref('light');
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(localStorage.getItem('anthroprime-eod-theme'), 'light', 'preference persisted');
    assert.equal(document.querySelector('meta[name="theme-color"]').getAttribute('content'), '#eef6f7');

    theme.applyTheme('auto');
    assert.ok(['light', 'dark'].includes(document.documentElement.dataset.theme), 'auto resolves to a concrete theme');
    assert.equal(theme.toggleTheme(), theme.resolvedTheme('auto') === 'dark' ? 'light' : 'dark');
    assert.equal(theme.themePref(), theme.resolvedTheme() === 'dark' ? 'dark' : 'light');
  } finally { teardownDom(dom); }
});

test('login view renders the Anthroprime EOD brand and sign-in form', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap } = await mount();
    assert.ok(wrap, 'auth stage mounted');
    assert.ok(wrap.classList.contains('is-ready'), 'entrance state applied');
    assert.equal(wrap.querySelector('.auth-wordmark strong').textContent, 'Anthroprime');
    assert.equal(wrap.querySelector('.auth-wordmark em').textContent, 'EOD');
    assert.match(wrap.querySelector('.story-title').textContent, /Turn capability into/);
    assert.ok(wrap.querySelector('.rotator').querySelectorAll('.rot-word').length === 3, 'rotating headline words');
    assert.ok(wrap.querySelector('#login-form'), 'form present');
    assert.ok(wrap.querySelector('#login-form').elements.username, 'username field present');
    assert.ok(wrap.querySelector('#password-input'), 'password field present');
    assert.equal(document.getElementById('sidebar').innerHTML, '', 'sidebar cleared while signed out');
    assert.equal(document.getElementById('topbar').innerHTML, '', 'topbar cleared while signed out');
  } finally { teardownDom(dom); }
});

test('theme switch flips the document theme and its own state', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap } = await mount();
    const sw = wrap.querySelector('.theme-switch');
    const dark = sw.querySelector('[data-theme-opt="dark"]');
    const light = sw.querySelector('[data-theme-opt="light"]');

    dark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.documentElement.dataset.themePref, 'dark');
    assert.equal(dark.getAttribute('aria-checked'), 'true');
    assert.equal(light.getAttribute('aria-checked'), 'false');
    assert.equal(sw.dataset.active, '2', 'thumb moved to the dark slot');
    assert.equal(localStorage.getItem('anthroprime-eod-theme'), 'dark');

    light.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(sw.dataset.active, '1');

    // arrow keys move the selection too
    sw.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.documentElement.dataset.themePref, 'dark');
  } finally { teardownDom(dom); }
});

test('password field: reveal toggle and Caps Lock hint', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap } = await mount();
    const pw = wrap.querySelector('#password-input');
    const toggle = wrap.querySelector('#toggle-password');
    assert.equal(pw.type, 'password');

    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(pw.type, 'text');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), 'Hide password');
    // while the password is visible the button offers the "hide" icon
    assert.equal(toggle.querySelector('.pt-icon-eye').hidden, true);
    assert.equal(toggle.querySelector('.pt-icon-eye-off').hidden, false);

    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(pw.type, 'password');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.querySelector('.pt-icon-eye').hidden, false);
    assert.equal(toggle.querySelector('.pt-icon-eye-off').hidden, true);

    const caps = wrap.querySelector('#caps-hint');
    assert.equal(caps.hidden, true, 'hint hidden by default');
    const keyEvent = (key, capsOn) => {
      const ev = new dom.window.KeyboardEvent('keyup', { key, bubbles: true });
      Object.defineProperty(ev, 'getModifierState', { value: (m) => m === 'CapsLock' && capsOn });
      return ev;
    };
    pw.dispatchEvent(keyEvent('A', true));
    assert.equal(caps.hidden, false, 'hint shown while Caps Lock is on');
    pw.dispatchEvent(keyEvent('a', false));
    assert.equal(caps.hidden, true, 'hint hidden once Caps Lock is off');
  } finally { teardownDom(dom); }
});

test('typing marks a field filled and clears a stale error', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap } = await mount();
    const form = wrap.querySelector('#login-form');
    const user = form.elements.username;
    assert.equal(user.closest('.login-field').classList.contains('filled'), false);
    user.value = 'rohit.verma';
    user.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(user.closest('.login-field').classList.contains('filled'), true);

    // an error shown by a failed attempt is dismissed as soon as the user types
    wrap.querySelector('#login-err').innerHTML = '<div class="login-err">stale</div>';
    user.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(wrap.querySelector('#login-err').innerHTML, '');
  } finally { teardownDom(dom); }
});

test('demo quick-fill loads an account into the form', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap } = await mount();
    const row = wrap.querySelector('.demo-row[data-demo-user="admin"]');
    assert.ok(row, 'admin demo row present');
    row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const form = wrap.querySelector('#login-form');
    assert.equal(form.elements.username.value, 'admin');
    assert.equal(wrap.querySelector('#password-input').value, 'ECOD-admin-2026');
    assert.equal(row.classList.contains('picked'), true);
    assert.equal(wrap.querySelector('.demo-fold').open, false, 'demo list collapses after picking');
  } finally { teardownDom(dom); }
});

test('submit is blocked client-side when fields are empty', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap, calls } = await mount();
    const form = wrap.querySelector('#login-form');
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(calls.length, 0, 'no request sent');
    assert.match(wrap.querySelector('#login-err').textContent, /Enter your username/);

    form.elements.username.value = 'admin';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(calls.length, 0, 'still no request without a password');
    assert.match(wrap.querySelector('#login-err').textContent, /Enter your password/);
  } finally { teardownDom(dom); }
});

test('failed sign-in shows the API error and re-arms the button', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap, calls } = await mount({ status: 401, body: { error: 'Invalid username or password' } });
    const form = wrap.querySelector('#login-form');
    form.elements.username.value = 'admin';
    wrap.querySelector('#password-input').value = 'nope';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { username: 'admin', password: 'nope' });
    assert.match(wrap.querySelector('#login-err').textContent, /Invalid username or password/);
    const btn = wrap.querySelector('button[type=submit]');
    assert.equal(btn.disabled, false, 'button re-enabled');
    assert.match(btn.querySelector('.btn-label').textContent, /Sign in to Anthroprime EOD/);
    assert.equal(wrap.isConnected, true, 'still on the login page');
  } finally { teardownDom(dom); }
});

test('successful sign-in hands the session back to the app', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap, calls, signedIn } = await mount();
    const form = wrap.querySelector('#login-form');
    form.elements.username.value = 'rohit.verma';
    wrap.querySelector('#password-input').value = 'ECOD-candidate-2026';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(30);

    const btn = wrap.querySelector('button[type=submit]');
    assert.equal(btn.classList.contains('is-success'), true, 'success state shown');
    assert.match(btn.querySelector('.btn-label').textContent, /Welcome, Rohit Verma/);

    await flush(500); // exit animation, then the handover
    assert.equal(calls.length, 1);
    assert.equal(signedIn.length, 1);
    assert.equal(signedIn[0].token, 'tok');
    assert.equal(wrap.isConnected, false, 'login stage removed after handover');
  } finally { teardownDom(dom); }
});

test('username is trimmed and whitespace is not sent as a credential', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap, calls } = await mount({ status: 401, body: { error: 'Invalid username or password' } });
    const form = wrap.querySelector('#login-form');
    form.elements.username.value = '   admin   ';
    wrap.querySelector('#password-input').value = 'x';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.deepEqual(calls[0].body, { username: 'admin', password: 'x' });
  } finally { teardownDom(dom); }
});

test('readiness stats count up to their target values', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    const { wrap } = await mount();
    const ring = wrap.querySelector('[data-count="86"]');
    const chip = wrap.querySelector('[data-count="24"]');
    assert.ok(ring && chip, 'stat placeholders present');
    await flush(1800); // count-up runs for 1400ms of frames
    assert.equal(ring.textContent, '86', 'readiness ring settled on 86');
    assert.equal(chip.textContent, '24%', 'chip settled on 24%');
  } finally { teardownDom(dom); }
});
