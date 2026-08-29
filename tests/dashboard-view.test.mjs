import { test } from 'node:test';
import assert from 'node:assert/strict';
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional dependency missing */ }
const SKIP = JSDOM ? false : 'jsdom not installed (npm install, or npm i --no-save jsdom)';

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function setupDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
    { url: 'http://localhost:3000/#/dashboard', pretendToBeVisual: true },
  );
  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HashChangeEvent: window.HashChangeEvent,
  });
  return dom;
}

function teardown(dom) {
  dom.window.close();
  for (const k of ['window', 'document', 'location', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'fetch']) delete globalThis[k];
}

test('dashboard metrics render meaningful SVG icons instead of empty tiles', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    globalThis.fetch = async (url) => {
      const json = (body) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Admin', role: 'admin', email: '' }, candidate: null });
      if (url.includes('/meta/bootstrap')) return json({ pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] });
      if (url.includes('/admin/dashboard')) return json({
        counts: { candidates: 4, enterprise_ready: 0, active_assessments: 2, avg_score: 51.7 },
        by_stage: {},
        by_status: {},
        recent_activity: [],
      });
      return json({});
    };
    localStorage.setItem('ecod.token', 'test-token');
    const { state } = await import('../public/js/app.js');
    state.meta = {
      pipelineStages: [],
      assessmentStatuses: [],
      userRoles: [],
      questionTypes: [],
      difficulties: [],
    };
    const admin = await import('../public/js/views/admin.js');
    const view = document.getElementById('view');
    await admin.dashboardView(view);
    await flush(20);

    const icons = [...view.querySelectorAll('.metric-grid .stat-icon')];
    assert.equal(icons.length, 4);
    assert.equal(icons.filter((icon) => icon.querySelector('svg')).length, 4, 'each metric tile has a real icon glyph');
    assert.ok(icons.every((icon) => icon.textContent.trim() === ''), 'icons are decorative SVGs, not stray placeholder text');
  } finally { teardown(dom); }
});
