import { session, me, bootstrap, setUnauthorizedHandler } from './api.js';
import { initTheme, toggleTheme, resolvedTheme } from './theme.js';
import { esc, initials, enhanceTables } from './ui.js';
import { logoSvg } from './logo.js';
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
    view.innerHTML = `<div class="empty-page">
      <div class="empty-illustration"><span>✦</span></div>
      <div class="eyebrow">Coming next</div>
      <h1>${esc(moduleName)}</h1>
      <p>Hello <b>${esc(state.user?.name)}</b> — your workspace opens when the ${esc(moduleName)} module goes live in the next Anthroprime ECOD phase.</p>
      <p class="muted small">You only have access to your own assignments. For questions, contact your Anthroprime ECOD administrator.</p>
    </div>`;
  };
  return fn;
}

const NAV_ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.2"></rect><rect x="14" y="4" width="6" height="6" rx="1.2"></rect><rect x="4" y="14" width="6" height="6" rx="1.2"></rect><rect x="14" y="14" width="6" height="6" rx="1.2"></rect></svg>',
  candidates: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M3.8 19c.4-3.1 2.1-4.7 5.2-4.7s4.8 1.6 5.2 4.7"></path><path d="M16 5.4a3 3 0 0 1 0 5.7M17 14.6c2.1.5 3.3 2 3.5 4.4"></path></svg>',
  assessments: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.8h8l3 3V20H7z"></path><path d="M15 3.8V7h3M10 11h5M10 14.5h5M10 18h3"></path></svg>',
  roles: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"></circle><path d="m12 7.5 1.4 3.1 3.2.4-2.4 2.2.7 3.2-2.9-1.7-2.9 1.7.7-3.2-2.4-2.2 3.2-.4z"></path></svg>',
  questions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v15H7.5A2.5 2.5 0 0 0 5 20.5z"></path><path d="M5 5.5v15M9 7h7M9 10.5h7"></path></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2"></circle><path d="M5.5 20c.5-4 2.5-6 6.5-6s6 2 6.5 6"></path></svg>',
  audit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4"></path></svg>',
  workspace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 17 5-5 3 3 7-8"></path><path d="M15 7h4v4"></path></svg>',
  journey: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17c3-8 8-9 16-10"></path><path d="m16 5 4 2-3 3"></path><circle cx="5" cy="18" r="2"></circle></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 11 8-7 8 7v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"></path><path d="M9 20v-6h6v6"></path></svg>',
};
const NAV = {
  admin: [['#/dashboard', 'Dashboard'], ['#/candidates', 'Candidates'], ['#/assessments', 'Assessments'],
          ['#/roles', 'Roles & Frameworks'], ['#/questions', 'Question Bank'], ['#/users', 'Users & Access'], ['#/audit', 'Audit Log']],
  assessor: [['#/workspace', 'My Assessments']],
  candidate: [['#/journey', 'My Journey']],
  validator: [['#/home', 'Home']],
  trainer: [['#/home', 'Home']],
};

const routeHash = () => (location.hash || '').split('?')[0];
const navKey = (href) => href.slice(2).split('/')[0];

function closeMobileNav() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('nav-scrim')?.classList.remove('visible');
  document.getElementById('mobile-nav-toggle')?.setAttribute('aria-expanded', 'false');
}

function renderShell() {
  const u = state.user;
  const nav = NAV[u.role] || [];
  const hash = routeHash().split('/').slice(0, 2).join('/');
  const navGroups = u.role === 'admin'
    ? [['Workspace', nav.slice(0, 3)], ['Configure', nav.slice(3, 6)], ['Governance', nav.slice(6)]]
    : [['Workspace', nav]];
  const pageLabel = (nav.find(([h]) => h === hash) || [])[1] || 'Anthroprime ECOD';

  document.body.classList.add('app-body');
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">
      <a class="logo" href="${DEFAULT_ROUTE[u.role] || '#/home'}" aria-label="Anthroprime ECOD home">
        <span class="mark">${logoSvg({ className: 'mark-svg' })}</span>
        <span><strong>Anthroprime</strong><small>ECOD · Capability OS</small></span>
      </a>
      <div class="brand-status"><span></span> Talent readiness platform</div>
    </div>
    <nav class="nav" aria-label="Primary navigation">
      ${navGroups.map(([label, items]) => `<div class="nav-group">
        <div class="nav-label">${esc(label)}</div>
        ${items.map(([h, text]) => `<a href="${h}" class="${hash === h ? 'active' : ''}">
          <span class="ico">${NAV_ICONS[navKey(h)] || NAV_ICONS.home}</span><span>${esc(text)}</span>
        </a>`).join('')}
      </div>`).join('')}
    </nav>
    <div class="side-user">
      <div class="side-user-card">
        <div class="who"><span class="avatar">${esc(initials(u.name))}</span><span class="who-copy"><b>${esc(u.name)}</b><small>${esc(u.email || `${u.role} account`)}</small></span></div>
        <div class="role"><span class="online-dot"></span>${esc(u.role)}${state.candidate ? ` · ${esc(state.candidate.name)}` : ''}</div>
      </div>
      <button class="btn secondary sm signout" id="logout-btn"><span class="btn-icon">↗</span> Sign out</button>
    </div>`;

  document.getElementById('logout-btn').onclick = async () => {
    const { logout } = await import('./api.js');
    await logout();
    session.token = null;
    closeMobileNav();
    boot();
  };

  document.getElementById('topbar').innerHTML = `
    <div class="topbar-left">
      <button class="mobile-nav-toggle" id="mobile-nav-toggle" aria-label="Open navigation" aria-expanded="false">☰</button>
      <div class="topbar-context"><span class="eyebrow">Anthroprime ECOD</span><strong>${esc(pageLabel)}</strong></div>
    </div>
    <div class="topbar-right">
      <span class="live-status"><i></i> All systems normal</span>
      <span class="topbar-divider"></span>
      ${themeToggleHtml()}
      <span class="topbar-role">${esc(u.role)}</span>
      <span class="topbar-avatar">${esc(initials(u.name))}</span>
    </div>`;
  const themeBtn = document.getElementById('theme-toggle');
  themeBtn.onclick = () => {
    const next = toggleTheme();
    syncThemeToggle(themeBtn, next);
  };

  const toggle = document.getElementById('mobile-nav-toggle');
  toggle.onclick = () => {
    const open = document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('nav-scrim').classList.toggle('visible', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  document.getElementById('nav-scrim').onclick = closeMobileNav;
}

let rendering = false;
let rerenderQueued = false;

async function render() {
  // Guard against concurrent renders (e.g. setting location.hash fires
  // hashchange while we also call render()): only one view render runs at a
  // time; a change while rendering queues exactly one follow-up render.
  if (rendering) { rerenderQueued = true; return; }
  rendering = true;
  try { await renderOnce(); }
  finally {
    rendering = false;
    if (rerenderQueued) { rerenderQueued = false; render(); }
  }
}

async function renderOnce() {
  const view = document.getElementById('view');
  if (!state.user) {
    document.body.classList.remove('app-body');
    closeMobileNav();
    loginView(view, onSignedIn);
    return;
  }
  // UI config must be present before any view renders. It is public and
  // normally loaded at boot, but never let a missing meta crash a view.
  if (!state.meta) state.meta = await bootstrap().catch(() => null);
  if (!state.meta) {
    view.innerHTML = `<div class="error-page"><div class="error-icon">!</div><h3>Could not reach the server</h3><p class="muted">Please check your connection and reload the page.</p></div>`;
    return;
  }
  renderShell();
  const rawHash = location.hash || DEFAULT_ROUTE[state.user.role];
  if (!location.hash) { location.hash = DEFAULT_ROUTE[state.user.role]; return; }
  const hash = rawHash.split('?')[0];
  const routes = ROUTES[state.user.role] || [];
  for (const [pattern, fn] of routes) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    const match = hash.match(rx);
    if (!match) continue;
    const params = {};
    keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
    view.innerHTML = '<div class="loading"><span class="spinner"></span><span>Loading workspace</span></div>';
    try {
      await fn(view, params);
      enhanceTables(view);
      view.scrollIntoView?.({ block: 'start' });
    } catch (err) {
      renderRouteError(view, err);
    }
    return;
  }
  location.hash = DEFAULT_ROUTE[state.user.role];
}

/**
 * View-level failure. Network/offline problems get a retry affordance rather
 * than a dead end, and 404s are named for what they are so the user is not
 * left guessing whether the record exists.
 */
function renderRouteError(view, err) {
  const status = err?.status;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const title = offline ? 'You appear to be offline'
    : status === 404 ? 'Not found'
    : status === 403 ? 'You do not have access to this'
    : status === 409 ? 'Not available yet'
    : 'Something went wrong';
  const detail = offline
    ? 'Check your connection — your work is saved and the page will load once you are back online.'
    : (err?.message || 'An unexpected error occurred.');
  view.innerHTML = `<div class="error-page">
    <div class="error-icon">!</div>
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(detail)}</p>
    <div class="row" style="justify-content:center;gap:10px;margin-top:6px">
      <button class="btn" id="err-retry" type="button">Try again</button>
      <a class="btn secondary" href="${DEFAULT_ROUTE[state.user.role]}">Return to workspace</a>
    </div>
  </div>`;
  const retry = view.querySelector('#err-retry');
  if (retry) retry.onclick = () => render();
}

function onSignedIn({ token, user, candidate: c }) {
  session.token = token;
  state.user = user;
  state.candidate = c;
  const target = DEFAULT_ROUTE[user.role];
  // Setting the hash fires hashchange (which renders); only call render()
  // directly when the hash is already the target, so we never render twice.
  if (routeHash() === target) render();
  else location.hash = target;
}

async function boot() {
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('topbar').innerHTML = '';
  document.getElementById('nav-scrim')?.classList.remove('visible');
  window.onhashchange = () => { closeMobileNav(); if (state.user) render(); };
  if (!state.meta) state.meta = await bootstrap().catch(() => null);
  if (session.token) {
    try {
      const res = await me();
      state.user = res.user; state.candidate = res.candidate;
    } catch { session.token = null; state.user = null; }
  } else state.user = null;
  render();
}

/* ------------------------------ theme toggle ------------------------------ */
const THEME_ICONS = {
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4z"></path></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"></path></svg>',
};
/** The icon shows the theme you will switch *to*. */
function themeToggleHtml() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  return `<button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to ${next} mode" title="Switch to ${next} mode">${THEME_ICONS[next]}</button>`;
}
function syncThemeToggle(btn, theme) {
  const next = theme === 'dark' ? 'light' : 'dark';
  btn.innerHTML = THEME_ICONS[next];
  btn.setAttribute('aria-label', `Switch to ${next} mode`);
  btn.title = `Switch to ${next} mode`;
}

// Table overflow depends on viewport width — re-evaluate when it changes.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => enhanceTables(document.getElementById('view')), 180);
});

setUnauthorizedHandler(() => { state.user = null; render(); });
initTheme();
boot();
