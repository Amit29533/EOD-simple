/**
 * Admin integrity trail (public/js/views/admin.js integrityView), rendered
 * with jsdom against a stubbed API. Pins:
 *  - `time_expired` is a first-class counter with its own tile and tone, not
 *    lumped under "other";
 *  - an event name that names an Object.prototype member (the name comes from
 *    the candidate's browser) renders with the grey tone — `TONE["constructor"]`
 *    must never be stringified into a class attribute — and never counts as
 *    severe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, SKIP } from './helpers/jsdom.mjs';

function setupDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <aside id="sidebar"></aside><header id="topbar"></header><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
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
    HashChangeEvent: window.HashChangeEvent,
  });
  return dom;
}

function teardown(dom) {
  dom.window.close();
  for (const k of ['window', 'document', 'location', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'fetch']) delete globalThis[k];
}

const TRAIL = {
  assessment: { id: 'as-1', status: 'in_progress', started_at: '2026-09-22T09:00:00.000Z' },
  candidate: { id: 'c1', name: 'Rohit Verma' },
  integrity: { tab_switch: 1, time_expired: 3, spoken_answer_missing: 0, other: 0 },
  events_count: 6,
  events: [
    { at: '2026-09-22T09:01:00.000Z', event: 'tab_switch', detail: 'Browser tab switched', question_index: 0 },
    { at: '2026-09-22T09:02:00.000Z', event: 'time_expired', detail: 'Answer window expired', question_index: 1 },
    { at: '2026-09-22T09:03:00.000Z', event: 'time_expired', detail: 'Review window expired', question_index: 2 },
    { at: '2026-09-22T09:04:00.000Z', event: 'time_expired', detail: 'Answer window expired', question_index: 2 },
    { at: '2026-09-22T09:05:00.000Z', event: 'constructor', detail: 'hostile event name', question_index: 3 },
    { at: '2026-09-22T09:06:00.000Z', event: '__proto__', detail: 'hostile event name', question_index: 3 },
  ],
};

function stubFetch() {
  globalThis.fetch = async (url) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes('/auth/me')) return json({ user: { id: 'u-admin', username: 'admin', name: 'Admin', role: 'admin', email: '' }, candidate: null });
    if (url.includes('/integrity')) return json(TRAIL);
    return json({});
  };
}

test('integrity view: timed-out questions get their own tile and an amber badge; hostile event names stay grey', { skip: SKIP }, async () => {
  const dom = setupDom();
  try {
    stubFetch();
    localStorage.setItem('ecod.token', 'test-token');
    const { state } = await import('../public/js/app.js');
    state.user = null; state.candidate = null;
    const admin = await import('../public/js/views/admin.js');
    const view = document.getElementById('view');
    await admin.integrityView(view, { id: 'as-1' });

    const tiles = [...view.querySelectorAll('.stat')].map((el) => [el.querySelector('.lbl').textContent, el.querySelector('.num').textContent]);
    const timedOut = tiles.find(([label]) => /timed out/i.test(label));
    assert.ok(timedOut, 'a "Questions timed out" tile is rendered');
    assert.equal(timedOut[1], '3');

    const badges = [...view.querySelectorAll('.table-card .badge')];
    const byText = (text) => badges.filter((b) => b.textContent.trim() === text);
    assert.equal(byText('time_expired').length, 3);
    for (const b of byText('time_expired')) assert.match(b.className, /\bamber\b/);
    assert.match(byText('tab_switch')[0].className, /\bred\b/);
    for (const hostile of ['constructor', '__proto__']) {
      const [b] = byText(hostile);
      assert.ok(b, `${hostile} event is listed`);
      assert.match(b.className, /\bgrey\b/, `${hostile} -> grey, got "${b.className}"`);
      assert.doesNotMatch(b.className, /function|native code/);
    }
    // Only the tab switch is severe: timeouts and unknown names never are.
    assert.match(view.textContent, /1 severe/);
    assert.match(view.textContent, /4 events/, 'the header total sums the counters');
  } finally { teardown(dom); }
});
