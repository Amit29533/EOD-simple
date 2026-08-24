import { session, me, bootstrap, setUnauthorizedHandler } from './api.js';
import { esc, initials } from './ui.js';
import { loginView } from './views/login.js';
import * as admin from './views/admin.js';
import * as assessor from './views/assessor.js';
import * as candidate from './views/candidate.js';

export const state = { user: null, candidate: null, meta: null };

const ROUTES = {
  admin: [
    ['#/dashboard', admin.dashboardView], ['#/candidates', admin.candidatesView],
    ['#/candidates/:id', admin.candidateDetailView], ['#/assessments', admin.assessmentsView],
    ['#/assessments/:id/report', admin.reportView], ['#/roles', admin.rolesView],
    ['#/roles/:id', admin.roleDetailView], ['#/questions', admin.questionsView],
    ['#/users', admin.usersView], ['#/audit', admin.auditView],
  ],
  assessor: [
    ['#/workspace', assessor.workspaceView], ['#/assessments/:id', assessor.assessmentView],
  ],
  candidate: [
    ['#/journey', candidate.portalView], ['#/assessments/:id/quiz', candidate.quizView],
    ['#/assessments/:id/report', candidate.reportView],
  ],
  validator: [['#/home', placeholderView('Independent Validation')]],
  trainer: [['#/home', placeholderView('Enrichment Studio')]],
};
const DEFAULT_ROUTE = { admin: '#/dashboard', assessor: '#/workspace', candidate: '#/journey', validator: '#/home', trainer: '#/home' };

function placeholderView(moduleName) {
  const fn = (view) => {
    view.innerHTML = `<div class="card">${'<h2>'}${esc(moduleName)} module</h2>
      <p>Hello <b>${esc(state.user?.name)}</b> — your workspace opens when the ${esc(moduleName)} module goes live in the next ECOD phase.</p>
      <p class="muted small">You only have access to your own assignments. For questions, contact your ECOD administrator.</p></div>`;
  };
  return fn;
}

const NAV_ICONS = { dashboard: '▦', candidates: '🧑‍🤝‍🧑', assessments: '📝', roles: '🎯', questions: '💬', users: '🔐', audit: '🧾', workspace: '🧭', journey: '🚀', home: '🏠' };
const NAV = {
  admin: [['#/dashboard', 'Dashboard'], ['#/candidates', 'Candidates'], ['#/assessments', 'Assessments'],
          ['#/roles', 'Roles & Frameworks'], ['#/questions', 'Question Bank'], ['#/users', 'Users & Access'], ['#/audit', 'Audit Log']],
  assessor: [['#/workspace', 'My Assessments']],
  candidate: [['#/journey', 'My Journey']],
  validator: [['#/home', 'Home']],
  trainer: [['#/home', 'Home']],
};

function renderShell() {
  const u = state.user;
  const nav = NAV[u.role] || [];
  const hash = location.hash.split('/').slice(0, 2).join('/');
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">
      <div class="logo"><span class="mark">E</span> ECOD</div>
      <div class="tag">Enterprise Capability on Demand</div>
    </div>
    <nav class="nav">
      ${nav.map(([h, label]) => `<a href="${h}" class="${hash === h ? 'active' : ''}"><span class="ico">${NAV_ICONS[h.slice(2)] || '•'}</span>${esc(label)}</a>`).join('')}
    </nav>
    <div class="side-user">
      <div class="who"><span class="avatar">${esc(initials(u.name))}</span><span>${esc(u.name)}</span></div>
      <div class="role">${esc(u.role)}${state.candidate ? ` · ${esc(state.candidate.name)}` : ''}</div>
      <button class="btn secondary sm" id="logout-btn">Sign out</button>
    </div>`;
  document.getElementById('logout-btn').onclick = async () => {
    const { logout } = await import('./api.js');
    await logout();
    session.token = null;
    boot();
  };
  document.getElementById('topbar').innerHTML = `
    <b>${esc((nav.find(([h]) => h === hash) || [])[1] || 'ECOD')}</b>
    <span class="muted small">·</span><span class="muted small">${esc(u.role === 'admin' ? 'Platform administration' : u.role === 'assessor' ? 'Assessor workspace' : 'Candidate portal')}</span>
    <span style="flex:1"></span><span class="muted small">Anthroprime ECOD</span>`;
}

async function render() {
  const view = document.getElementById('view');
  if (!state.user) { loginView(view, onSignedIn); return; }
  renderShell();
  const hash = location.hash || DEFAULT_ROUTE[state.user.role];
  if (!location.hash) { location.hash = DEFAULT_ROUTE[state.user.role]; return; }
  const routes = ROUTES[state.user.role] || [];
  for (const [pattern, fn] of routes) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    const match = hash.match(rx);
    if (!match) continue;
    const params = {};
    keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
    view.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    try { await fn(view, params); }
    catch (err) { view.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="muted">${esc(err.message)}</p></div>`; }
    return;
  }
  location.hash = DEFAULT_ROUTE[state.user.role];
}

function onSignedIn({ token, user, candidate: c }) {
  session.token = token;
  state.user = user;
  state.candidate = c;
  location.hash = DEFAULT_ROUTE[user.role];
  render();
}

async function boot() {
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('topbar').innerHTML = '';
  window.onhashchange = () => { if (state.user) render(); };
  if (!state.meta) state.meta = await bootstrap().catch(() => null);
  if (session.token) {
    try {
      const res = await me();
      state.user = res.user; state.candidate = res.candidate;
    } catch { session.token = null; state.user = null; }
  } else state.user = null;
  render();
}

setUnauthorizedHandler(() => { state.user = null; render(); });
boot();
