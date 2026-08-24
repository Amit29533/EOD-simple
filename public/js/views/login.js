import { login } from '../api.js';
import { esc } from '../ui.js';

export function loginView(view, onSuccess) {
  view.innerHTML = '';
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('topbar').innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'login-wrap';
  wrap.innerHTML = `
    <div class="login-shell">
      <section class="login-showcase" aria-label="About ECOD">
        <div class="showcase-top">
          <div class="auth-logo"><span class="mark">E</span><span><strong>ECOD</strong><small>Capability OS</small></span></div>
          <span class="showcase-badge"><i></i> Built for readiness</span>
        </div>
        <div class="showcase-copy">
          <div class="eyebrow light">Enterprise talent, made visible</div>
          <h1>Turn capability into <em>confidence.</em></h1>
          <p>Assess, enrich and mobilize exceptional technology talent with one clear, connected workspace.</p>
        </div>
        <div class="showcase-board" aria-hidden="true">
          <div class="board-glow"></div>
          <div class="mini-report">
            <div class="mini-report-head"><span class="mini-label">Readiness snapshot</span><span class="mini-dots">•••</span></div>
            <div class="mini-score-row"><div class="mini-ring"><b>86</b><small>%</small></div><div><strong>Enterprise ready</strong><span>Databricks · RSA</span></div></div>
            <div class="mini-bars"><i style="width:88%"></i><i style="width:74%"></i><i style="width:94%"></i></div>
            <div class="mini-bar-labels"><span>Architecture</span><span>Advisory</span><span>Governance</span></div>
          </div>
          <div class="floating-chip chip-one"><span>↗</span> 24% faster decisions</div>
          <div class="floating-chip chip-two"><span>✦</span> 360° capability view</div>
        </div>
        <div class="showcase-foot"><span>ECOD by Anthroprime</span><span>Secure by design <b>·</b> Built to scale</span></div>
      </section>

      <section class="login-card" aria-label="Sign in">
        <div class="login-card-inner">
          <div class="mobile-auth-logo"><span class="mark">E</span><strong>ECOD</strong></div>
          <div class="login-heading">
            <div class="eyebrow">Secure workspace</div>
            <h2>Welcome back<span class="heading-dot">.</span></h2>
            <p>Sign in to continue where your team left off.</p>
          </div>
          <div id="login-err" role="alert" aria-live="polite"></div>
          <form id="login-form">
            <label class="f login-field"><span class="lbl">Username</span>
              <div class="input-wrap"><span class="input-icon" aria-hidden="true">@</span><input type="text" name="username" autocomplete="username" placeholder="you@company or username" autofocus required /></div>
            </label>
            <label class="f login-field"><span class="lbl">Password</span>
              <div class="input-wrap"><span class="input-icon lock-icon" aria-hidden="true">⌑</span><input id="password-input" type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required /><button type="button" class="password-toggle" id="toggle-password" aria-label="Show password">Show</button></div>
            </label>
            <button class="btn block login-submit" type="submit"><span>Sign in to ECOD</span><b aria-hidden="true">→</b></button>
          </form>
          <div class="login-security"><span class="security-icon">✓</span><span>Your session is protected with encrypted authentication.</span></div>
          <div class="login-foot"><span>Need access?</span><b> Contact your ECOD administrator.</b></div>
        </div>
      </section>
    </div>`;
  view.appendChild(wrap);

  const passwordInput = wrap.querySelector('#password-input');
  const togglePassword = wrap.querySelector('#toggle-password');
  togglePassword.onclick = () => {
    const visible = passwordInput.type === 'text';
    passwordInput.type = visible ? 'password' : 'text';
    togglePassword.textContent = visible ? 'Show' : 'Hide';
    togglePassword.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  };

  wrap.querySelector('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = wrap.querySelector('#login-err');
    err.innerHTML = '';
    const btn = wrap.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-light"></span><span>Signing in…</span>';
    try {
      const form = new FormData(e.target);
      const res = await login(form.get('username').trim(), form.get('password'));
      wrap.remove();
      onSuccess(res);
    } catch (error) {
      err.innerHTML = `<div class="login-err"><span class="error-icon">!</span><span>${esc(error.message)}</span></div>`;
      btn.disabled = false;
      btn.innerHTML = '<span>Sign in to ECOD</span><b aria-hidden="true">→</b>';
      passwordInput.focus();
    }
  };
}
