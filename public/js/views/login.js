import { login } from '../api.js';
import { esc } from '../ui.js';

export function loginView(view, onSuccess) {
  view.innerHTML = '';
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('topbar').innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'login-wrap';
  wrap.innerHTML = `
    <div class="login-card">
      <div class="logo"><span class="mark">E</span> ECOD</div>
      <div class="sub">Enterprise Capability on Demand · by Anthroprime</div>
      <div id="login-err"></div>
      <form id="login-form">
        <label class="f"><span class="lbl">Username</span>
          <input type="text" name="username" autocomplete="username" autofocus required /></label>
        <label class="f"><span class="lbl">Password</span>
          <input type="password" name="password" autocomplete="current-password" required /></label>
        <button class="btn block" type="submit">Sign in</button>
      </form>
      <div class="login-foot">Accounts are provisioned by your ECOD administrator.<br/>Assessment · Gap mapping · Enrichment · Enterprise-ready talent.</div>
    </div>`;
  view.appendChild(wrap);
  wrap.querySelector('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = wrap.querySelector('#login-err');
    err.innerHTML = '';
    const btn = wrap.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const form = new FormData(e.target);
      const res = await login(form.get('username').trim(), form.get('password'));
      wrap.remove();
      onSuccess(res);
    } catch (error) {
      err.innerHTML = `<div class="login-err">${esc(error.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}
