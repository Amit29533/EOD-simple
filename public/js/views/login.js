import { login } from '../api.js';
import { esc } from '../ui.js';
import { themePref, setThemePref, onThemeChange } from '../theme.js';
import { logoSvg } from '../logo.js';

/* ---------------------------------------------------------------- icons */
const ICON = {
  monitor: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2.4"></rect><path d="M9 20h6M12 16.5V20"></path></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"></path></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4z"></path></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4"></circle><path d="M5 19.5c.6-3.6 3.2-5.5 7-5.5s6.4 1.9 7 5.5"></path></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.8" y="10.4" width="14.4" height="9.6" rx="2.6"></rect><path d="M8.2 10.4V8a3.8 3.8 0 0 1 7.6 0v2.4M12 14.2v2.2"></path></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.9"></circle></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5l15.5 15M9.6 6.4A9.6 9.6 0 0 1 12 6.1c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 4M6.6 8.2A16.6 16.6 0 0 0 2.5 12s3.5 6 9.5 6a9.4 9.4 0 0 0 3.4-.6"></path><path d="M10 10a2.9 2.9 0 0 0 4 4"></path></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5"></path></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.8 9.6 17.4 19 7.6"></path></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 5 6v5.6c0 4.2 2.9 7.6 7 9.2 4.1-1.6 7-5 7-9.2V6z"></path><path d="m9.2 12 2 2 3.6-3.9"></path></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4 13.7 9l5.6 1.7-5.6 1.7L12 18l-1.7-5.6L4.7 10.7 10.3 9z"></path></svg>',
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.4 2.8 5.6 13.4h5l-1 7.8 7.8-10.6h-5z"></path></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"></circle><circle cx="12" cy="12" r="4.2"></circle><circle cx="12" cy="12" r="1"></circle></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.6 21 19.4H3z"></path><path d="M12 10v4M12 16.6v.6"></path></svg>',
  keyboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.6" y="6" width="18.8" height="12" rx="2.4"></rect><path d="M6.4 9.6h.6M9.6 9.6h.6M12.8 9.6h.6M16 9.6h.6M6.4 12.8h.6M9.6 12.8h.6M12.8 12.8h.6M16 12.8h.6M8.4 15.6h7.2"></path></svg>',
};

const THEME_OPTIONS = [
  { value: 'auto', label: 'Match system', icon: ICON.monitor },
  { value: 'light', label: 'Light', icon: ICON.sun },
  { value: 'dark', label: 'Dark', icon: ICON.moon },
];

const DEMO_ACCOUNTS = [
  { role: 'Admin', username: 'admin', password: 'ECOD-admin-2026', blurb: 'Pipeline, roles & access' },
  { role: 'Assessor', username: 'priya.nair', password: 'ECOD-assessor-2026', blurb: 'Score & finalize' },
  { role: 'Candidate', username: 'rohit.verma', password: 'ECOD-candidate-2026', blurb: 'Take the RSA quiz' },
];

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Animate a number from 0 → to inside `el`. No-op under prefers-reduced-motion. */
function countUp(el, to, { duration = 1400, suffix = '' } = {}) {
  if (!el) return;
  if (reduceMotion()) { el.textContent = `${to}${suffix}`; return; }
  let start = null; // anchored to the first frame: rAF timestamps and
                    // performance.now() do not always share a time origin
  const tick = (now) => {
    if (start === null) start = now;
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(to * eased)}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function loginView(view, onSuccess) {
  view.innerHTML = '';
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('topbar').innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'auth-stage';
  wrap.innerHTML = `
    <div class="auth-bg" aria-hidden="true">
      <span class="auth-orb orb-one"></span>
      <span class="auth-orb orb-two"></span>
      <span class="auth-orb orb-three"></span>
      <span class="auth-mesh"></span>
      <span class="auth-beam"></span>
      <span class="auth-grain"></span>
    </div>

    <div class="auth-shell">
      <section class="auth-story" aria-label="About Anthroprime ECOD">
        <div class="story-inner">
          <header class="story-head">
            <div class="auth-logo">
              <span class="auth-mark" aria-hidden="true">
                ${logoSvg({ className: 'mark-svg' })}
              </span>
              <span class="auth-wordmark"><strong>Anthroprime</strong><em>ECOD</em></span>
            </div>
            <span class="story-badge"><i></i> Enterprise Capability OS</span>
          </header>

          <div class="story-copy">
            <div class="eyebrow light">Anthroprime ECOD</div>
            <h1 class="story-title">
              Turn capability into
              <span class="rotator" aria-live="off">
                <span class="rot-word">confidence.</span>
                <span class="rot-word">clarity.</span>
                <span class="rot-word">readiness.</span>
              </span>
            </h1>
            <p class="story-lede">One connected workspace to assess, enrich and certify experienced
              technology talent against the roles your enterprise actually needs.</p>
            <ul class="story-points">
              <li><span class="pt-icon">${ICON.target}</span><span><b>Role-based frameworks</b> — weighted competencies, no code changes.</span></li>
              <li><span class="pt-icon">${ICON.bolt}</span><span><b>Auto-scored, assessor-verified</b> — objective items grade themselves.</span></li>
              <li><span class="pt-icon">${ICON.shield}</span><span><b>Compartmentalized by design</b> — every role sees only its scope.</span></li>
            </ul>
          </div>

          <div class="story-board" aria-hidden="true">
            <span class="board-glow"></span>
            <div class="glass mini-report">
              <div class="mini-head"><span>Readiness snapshot</span><span class="mini-dots">•••</span></div>
              <div class="mini-score-row">
                <svg class="mini-ring" viewBox="0 0 44 44">
                  <circle class="ring-track" cx="22" cy="22" r="18"></circle>
                  <circle class="ring-fill" cx="22" cy="22" r="18"></circle>
                </svg>
                <div class="mini-ring-label"><b><i data-count="86">0</i>%</b><small>Enterprise ready · Databricks RSA</small></div>
              </div>
              <div class="mini-bars">
                <span style="--w:88%"></span><span style="--w:74%"></span><span style="--w:94%"></span>
              </div>
              <div class="mini-bar-labels"><span>Architecture</span><span>Advisory</span><span>Governance</span></div>
            </div>
            <div class="glass float-chip chip-one"><span class="chip-icon">${ICON.spark}</span><div><b><i data-count="24" data-suffix="%">0</i></b><small>faster decisions</small></div></div>
            <div class="glass float-chip chip-two"><span class="chip-icon">${ICON.target}</span><div><b>360°</b><small>capability view</small></div></div>
          </div>

          <footer class="story-foot">
            <span>© ${new Date().getFullYear()} Anthroprime</span>
            <span>Role-based access <b>·</b> Audit trailed <b>·</b> Built to scale</span>
          </footer>
        </div>
      </section>

      <section class="auth-panel" aria-label="Sign in">
        <div class="auth-card" id="auth-card">
          <span class="card-spotlight" aria-hidden="true"></span>
          <div class="auth-card-inner">
            <div class="auth-card-top">
              <div class="auth-logo auth-logo-mobile">
                <span class="auth-mark" aria-hidden="true">
                  ${logoSvg({ className: 'mark-svg' })}
                </span>
                <span class="auth-wordmark"><strong>Anthroprime</strong><em>ECOD</em></span>
              </div>
              <div class="theme-switch" role="radiogroup" aria-label="Colour theme" data-active="${Math.max(0, THEME_OPTIONS.findIndex((o) => o.value === themePref()))}">
                <span class="theme-thumb" aria-hidden="true"></span>
                ${THEME_OPTIONS.map((o, i) => `
                  <button type="button" class="theme-opt" role="radio" data-theme-opt="${o.value}" data-index="${i}"
                          aria-checked="${String(themePref() === o.value)}" aria-label="${o.label}" title="${o.label}">${o.icon}</button>`).join('')}
              </div>
            </div>

            <div class="auth-heading">
              <div class="eyebrow">Secure workspace</div>
              <h2>Welcome back<span class="heading-dot">.</span></h2>
              <p>Sign in to continue where your team left off.</p>
            </div>

            <div id="login-err" role="alert" aria-live="assertive"></div>

            <form id="login-form" novalidate>
              <label class="f login-field">
                <span class="lbl">Username or email</span>
                <span class="input-wrap">
                  <span class="input-icon" aria-hidden="true">${ICON.user}</span>
                  <input type="text" name="username" autocomplete="username" placeholder="you@company or username"
                         spellcheck="false" required />
                </span>
              </label>

              <label class="f login-field">
                <span class="lbl">Password</span>
                <span class="input-wrap">
                  <span class="input-icon" aria-hidden="true">${ICON.lock}</span>
                  <input id="password-input" type="password" name="password" autocomplete="current-password"
                         placeholder="Enter your password" required />
                  <button type="button" class="password-toggle" id="toggle-password" aria-label="Show password" aria-pressed="false">
                    <span class="pt-icon-eye">${ICON.eye}</span><span class="pt-icon-eye-off" hidden>${ICON.eyeOff}</span>
                  </button>
                </span>
              </label>

              <button class="btn block login-submit" type="submit">
                <span class="btn-shine" aria-hidden="true"></span>
                <span class="btn-label">Sign in to Anthroprime ECOD</span>
                <span class="btn-arrow" aria-hidden="true">${ICON.arrow}</span>
              </button>
            </form>

            <details class="demo-fold">
              <summary><span class="demo-summary-icon">${ICON.keyboard}</span> Demo sign-ins</summary>
              <div class="demo-list">
                ${DEMO_ACCOUNTS.map((d) => `
                  <button type="button" class="demo-row" data-demo-user="${esc(d.username)}" data-demo-pass="${esc(d.password)}">
                    <span class="demo-role">${esc(d.role)}</span>
                    <span class="demo-meta"><code>${esc(d.username)}</code><small>${esc(d.blurb)}</small></span>
                    <span class="demo-use">Use</span>
                  </button>`).join('')}
              </div>
            </details>

            <div class="auth-security"><span class="security-icon">${ICON.shield}</span><span>Sessions are token-authenticated and every action is audit-trailed.</span></div>
            <div class="auth-foot"><span>Need access?</span><b> Contact your Anthroprime ECOD administrator.</b></div>
          </div>
        </div>
      </section>
    </div>`;
  view.appendChild(wrap);

  const card = wrap.querySelector('#auth-card');
  const form = wrap.querySelector('#login-form');
  const usernameInput = form.elements.username;
  const passwordInput = wrap.querySelector('#password-input');
  const submitBtn = wrap.querySelector('button[type=submit]');
  const errBox = wrap.querySelector('#login-err');
  const DEFAULT_LABEL = submitBtn.querySelector('.btn-label').textContent;
  const DEFAULT_ARROW = submitBtn.querySelector('.btn-arrow').innerHTML;

  /* ------------------------------------------------- theme switch */
  const themeSwitch = wrap.querySelector('.theme-switch');
  const syncThemeUI = () => {
    const pref = themePref();
    themeSwitch.dataset.active = String(Math.max(0, THEME_OPTIONS.findIndex((o) => o.value === pref)));
    themeSwitch.querySelectorAll('.theme-opt').forEach((btn) => {
      const on = btn.dataset.themeOpt === pref;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
  };
  syncThemeUI();
  const offTheme = onThemeChange(syncThemeUI);
  themeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-opt');
    if (btn) { setThemePref(btn.dataset.themeOpt); syncThemeUI(); btn.focus(); }
  });
  themeSwitch.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = Math.max(0, THEME_OPTIONS.findIndex((o) => o.value === themePref()));
    const step = (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ? -1 : 1;
    const next = THEME_OPTIONS[(i + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
    setThemePref(next.value);
    syncThemeUI();
    themeSwitch.querySelector(`[data-theme-opt="${next.value}"]`)?.focus();
  });

  /* ------------------------------------------------- card spotlight + tilt */
  const onPointerMove = (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--mx', `${(x * 100).toFixed(2)}%`);
    card.style.setProperty('--my', `${(y * 100).toFixed(2)}%`);
    if (reduceMotion()) return;
    card.style.setProperty('--tilt-x', `${((0.5 - y) * 5).toFixed(2)}deg`);
    card.style.setProperty('--tilt-y', `${((x - 0.5) * 7).toFixed(2)}deg`);
  };
  const onPointerLeave = () => { card.style.setProperty('--tilt-x', '0deg'); card.style.setProperty('--tilt-y', '0deg'); };
  card.addEventListener('pointermove', onPointerMove);
  card.addEventListener('pointerleave', onPointerLeave);

  /* ------------------------------------------------- field interactivity */
  const markFilled = (input) => input.closest('.login-field')?.classList.toggle('filled', input.value.trim() !== '');
  [usernameInput, passwordInput].forEach((input) => {
    markFilled(input);
    input.addEventListener('input', () => {
      markFilled(input);
      if (errBox.innerHTML) showError('');
    });
  });
  const togglePassword = wrap.querySelector('#toggle-password');
  togglePassword.onclick = () => {
    const visible = passwordInput.type === 'text';
    passwordInput.type = visible ? 'password' : 'text';
    togglePassword.setAttribute('aria-pressed', String(!visible));
    togglePassword.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    togglePassword.querySelector('.pt-icon-eye').hidden = !visible;
    togglePassword.querySelector('.pt-icon-eye-off').hidden = visible;
    passwordInput.focus();
  };

  /* ------------------------------------------------- demo quick-fill */
  wrap.querySelectorAll('.demo-row').forEach((row) => {
    row.addEventListener('click', () => {
      usernameInput.value = row.dataset.demoUser;
      passwordInput.value = row.dataset.demoPass;
      markFilled(usernameInput); markFilled(passwordInput);
      wrap.querySelector('.demo-fold').open = false;
      wrap.querySelectorAll('.demo-row').forEach((r) => r.classList.toggle('picked', r === row));
      errBox.innerHTML = '';
      submitBtn.classList.remove('is-error', 'is-success');
      usernameInput.focus();
      submitBtn.animate?.(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }],
        { duration: 320, easing: 'ease-out' },
      );
    });
  });

  /* ------------------------------------------------- error + states */
  function showError(message) {
    if (!message) { errBox.innerHTML = ''; card.classList.remove('shake'); return; }
    errBox.innerHTML = `<div class="login-err"><span class="error-icon">${ICON.alert}</span><span>${esc(message)}</span></div>`;
    if (!reduceMotion()) {
      card.classList.remove('shake');
      void card.offsetWidth; // restart the animation
      card.classList.add('shake');
    }
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.classList.toggle('is-busy', busy);
    if (busy) {
      submitBtn.querySelector('.btn-label').textContent = 'Verifying credentials…';
      submitBtn.querySelector('.btn-arrow').innerHTML = '<span class="spinner spinner-light"></span>';
    } else {
      submitBtn.querySelector('.btn-label').textContent = DEFAULT_LABEL;
      submitBtn.querySelector('.btn-arrow').innerHTML = DEFAULT_ARROW;
    }
  }

  /* ------------------------------------------------- submit */
  form.onsubmit = async (e) => {
    e.preventDefault();
    submitBtn.classList.remove('is-success');
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username) { showError('Enter your username or email to continue.'); usernameInput.focus(); return; }
    if (!password) { showError('Enter your password to continue.'); passwordInput.focus(); return; }

    showError('');
    setBusy(true);
    try {
      const res = await login(username, password);
      submitBtn.disabled = true;
      submitBtn.classList.remove('is-busy');
      submitBtn.classList.add('is-success');
      submitBtn.querySelector('.btn-label').textContent = `Welcome, ${res?.user?.name || username}`;
      submitBtn.querySelector('.btn-arrow').innerHTML = ICON.check;
      wrap.classList.add('is-leaving');
      offTheme();
      card.removeEventListener('pointermove', onPointerMove);
      card.removeEventListener('pointerleave', onPointerLeave);
      window.setTimeout(() => { wrap.remove(); onSuccess(res); }, reduceMotion() ? 0 : 380);
    } catch (error) {
      setBusy(false);
      showError(error.message || 'Sign in failed. Check your credentials and try again.');
      passwordInput.select();
      passwordInput.focus();
    }
  };

  /* ------------------------------------------------- entrance + motion */
  requestAnimationFrame(() => wrap.classList.add('is-ready'));
  if (!reduceMotion()) {
    const ring = wrap.querySelector('.ring-fill');
    if (ring) requestAnimationFrame(() => ring.classList.add('is-on'));
  } else {
    wrap.querySelector('.ring-fill')?.classList.add('is-on', 'no-anim');
  }
  wrap.querySelectorAll('[data-count]').forEach((el) => {
    countUp(el, Number(el.dataset.count), { suffix: el.dataset.suffix || '' });
  });
  usernameInput.focus({ preventScroll: true });

  return wrap;
}
