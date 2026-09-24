/**
 * Admin point of view in the SPA (public/js/views/admin.js), rendered in
 * jsdom. The integrity tile checks use a stubbed API so each counter can be
 * set exactly; the rest run the real views against the real in-process API
 * (tests/helpers/world.mjs), so what the admin sees is what the server holds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';
import { INTEGRITY_EVENT_KEYS } from '../src/api/quiz-session.mjs';

const ADMIN = { id: 'u-admin', username: 'admin', name: 'Admin', role: 'admin', email: '' };
const ROUTINE = new Set(['exam_start', 'tab_return']);

const tilesOf = (view) => [...view.querySelectorAll('.stat')].map((el) => ({
  label: el.querySelector('.lbl').textContent.trim(),
  n: Number(el.querySelector('.num').textContent),
}));

function trail(integrity, events = []) {
  return {
    assessment: { id: 'as-1', status: 'in_progress', started_at: '2026-09-24T09:00:00.000Z' },
    candidate: { id: 'c1', name: 'Rohit Verma' }, integrity, events_count: events.length, events,
  };
}

/* ------------------------------------------------------------ integrity tiles */

test('integrity: every counter the API keeps lands in exactly one tile (routine ones only in the total)', { skip: SKIP }, async () => {
  let counters = {};
  const spa = await bootSpa({ user: ADMIN, routes: (m, p) => (p.endsWith('/integrity') ? trail(counters) : undefined) });
  try {
    const admin = await import('../public/js/views/admin.js');
    const keys = [...INTEGRITY_EVENT_KEYS, 'other'];
    assert.ok(keys.length >= 20, 'the registry is the real one');
    for (const key of keys) {
      counters = { [key]: 7 };
      await admin.integrityView(spa.view, { id: 'as-1' });
      const tiles = tilesOf(spa.view);
      const hits = tiles.filter((t) => t.n === 7);
      if (ROUTINE.has(key)) {
        assert.equal(hits.length, 0, `${key} is routine and has no tile`);
      } else {
        assert.equal(hits.length, 1, `${key} must land in exactly one tile, got ${JSON.stringify(tiles)}`);
        assert.equal(tiles.reduce((s, t) => s + t.n, 0), 7, `${key} is counted once`);
      }
      assert.match(spa.text(), /7 events/, 'the headline counts every counter');
    }
  } finally { spa.teardown(); }
});

test('integrity: copy, paste, screenshot and right-click are counted where an admin looks for them', { skip: SKIP }, async () => {
  const counters = { copy: 3, paste: 2, copy_attempt: 1, screenshot: 1, contextmenu: 4, other: 5, tab_switch: 1, exam_start: 1 };
  const events = [
    { at: '2026-09-24T09:01:00.000Z', event: 'copy', detail: 'Copying exam content is not permitted.', question_index: 0 },
    { at: '2026-09-24T09:02:00.000Z', event: 'paste', detail: 'legacy paste beacon', question_index: 1 },
  ];
  const spa = await bootSpa({ user: ADMIN, routes: (m, p) => (p.endsWith('/integrity') ? trail(counters, events) : undefined) });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.integrityView(spa.view, { id: 'as-1' });
    const tiles = Object.fromEntries(tilesOf(spa.view).map((t) => [t.label, t.n]));
    assert.equal(tiles['Copy / paste / devtools'], 6);
    assert.equal(tiles['Screenshot / right-click / other'], 10);
    assert.equal(tiles['Tab switches'], 1);
    const flagged = Object.entries(counters).filter(([k]) => !ROUTINE.has(k)).reduce((s, [, v]) => s + v, 0);
    assert.equal(Object.values(tiles).reduce((s, n) => s + n, 0), flagged, 'the tiles add up to every flagged event');
    // Copying exam content and a (legacy) paste are flagged amber, not grey.
    for (const name of ['copy', 'paste']) {
      const b = [...spa.view.querySelectorAll('.table-card .badge')].find((x) => x.textContent.trim() === name);
      assert.ok(b, `${name} is listed`);
      assert.match(b.className, /\bamber\b/, `${name} tone: ${b.className}`);
    }
  } finally { spa.teardown(); }
});

test('integrity: a single event reads "1 event"', { skip: SKIP }, async () => {
  const spa = await bootSpa({ user: ADMIN, routes: (m, p) => (p.endsWith('/integrity') ? trail({ exam_start: 1 }) : undefined) });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.integrityView(spa.view, { id: 'as-1' });
    const badges = [...spa.view.querySelectorAll('.badge')].map((b) => b.textContent.trim());
    assert.ok(badges.includes('1 event'), `badges: ${badges}`);
    assert.ok(!badges.includes('1 events'));
  } finally { spa.teardown(); }
});

/* ------------------------------------------------------------ against the real API */

test('integrity, end to end: what a candidate\'s browser reports is what the admin screen shows', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { token, assessmentId } = await w.candidateUser('proctored.cand', { name: 'Proctored Person' });
  await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
  for (const event of ['exam_start', 'copy', 'paste_attempt', 'screenshot', 'contextmenu', 'select_all', 'tab_switch', 'tab_return']) {
    const r = await w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, { token, body: { event, detail: `${event} happened` } });
    assert.equal(r.status, 200, `${event}: ${JSON.stringify(r.body)}`);
  }
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.integrityView(spa.view, { id: assessmentId });
    const tiles = Object.fromEntries(tilesOf(spa.view).map((x) => [x.label, x.n]));
    assert.equal(tiles['Copy / paste / devtools'], 2, 'copy + paste_attempt');
    assert.equal(tiles['Screenshot / right-click / other'], 3, 'screenshot + contextmenu + select_all (other)');
    assert.equal(tiles['Tab switches'], 1);
    assert.equal(Object.values(tiles).reduce((s, n) => s + n, 0), 6, 'all six flagged events, none of the routine two');
    assert.match(spa.text(), /8 events/);
    assert.match(spa.text(), /Proctored Person/);
    assert.match(spa.text(), /2 severe/, 'screenshot and tab switch are severe');
  } finally { spa.teardown(); }
});

test('assessments list: allocations from onboarding and bulk import, with counts, scope and actions', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  await w.candidateUser('listed.one', { name: 'Listed One' });
  const csv = 'Name,Email,Target role\nBulk Person,bulk@example.com,POV Track\n';
  assert.equal((await w.call('POST', '/admin/candidates/import', { token: w.tok, body: { csv, filename: 'c.csv', create_users: true } })).status, 200);
  const spa = await bootSpa({ hash: '#/assessments', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.assessmentsView(spa.view);
    const rows = [...spa.view.querySelectorAll('table tbody tr')];
    assert.equal(rows.length, 2);
    const text = spa.text();
    assert.match(text, /Listed One/);
    assert.match(text, /Bulk Person/);
    assert.match(text, /All 2/, 'the All pill counts both');
    assert.match(text, /Allocated 2/, 'both are allocated (status "assigned")');
    for (const r of rows) {
      assert.equal(r.cells[1].textContent.trim(), 'POV Track');
      assert.equal(r.cells[2].textContent.trim(), 'unassigned', 'no assessor yet');
      assert.equal(r.cells[3].textContent.trim(), '5', 'the question count comes from the row facts');
      assert.ok(r.querySelector('[data-re]'), 'an unscored paper can be reassigned');
      assert.ok(r.querySelector('[data-del]'), 'an unsubmitted paper can be deleted');
    }
  } finally { spa.teardown(); }
});

test('assessments list: reassigning from the list PATCHes the chosen assessor and repaints', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { assessmentId } = await w.candidateUser('reassign.me', { name: 'Reassign Me' });
  const { user: assessor } = await w.assessorUser('pat.assessor');
  const spa = await bootSpa({ hash: '#/assessments', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.assessmentsView(spa.view);
    spa.view.querySelector(`[data-re="${assessmentId}"]`).click();
    await flush(40);
    const modal = spa.document.getElementById('modal-root');
    const select = modal.querySelector('select[name="assessor_id"]');
    assert.ok(select, 'the reassign modal offers assessors');
    type(select, assessor.id);
    modal.querySelector('.m-foot .btn:last-child').click();
    await flush(150);
    assert.equal((await w.store.get('assessments', assessmentId)).assessor_id, assessor.id, 'the server holds the new assessor');
    assert.ok(spa.callsTo(`/admin/assessments/${assessmentId}`, 'PATCH').length === 1);
    assert.match(spa.text(), /Assessor pat\.assessor/, 'the list repaints with the assessor');
  } finally { spa.teardown(); }
});

test('candidates list: every candidate, and the search narrows it', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  await w.candidateUser('ann.list', { name: 'Ann Search' });
  await w.candidateUser('bob.list', { name: 'Bob Other' });
  const spa = await bootSpa({ hash: '#/candidates', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.candidatesView(spa.view);
    assert.equal(spa.view.querySelectorAll('#cand-list tbody tr').length, 2);
    assert.match(spa.text(), /2 profiles in your directory/);
    type(spa.view.querySelector('#cand-q'), 'Ann');
    await flush(600); // debounced refilter
    const names = [...spa.view.querySelectorAll('#cand-list tbody tr')].map((r) => r.querySelector('b').textContent);
    assert.deepEqual(names, ['Ann Search']);
  } finally { spa.teardown(); }
});

test('candidate record: login, allocated paper and timeline come from the server', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { cand } = await w.candidateUser('record.cand', { name: 'Record Holder' });
  const spa = await bootSpa({ hash: `#/candidates/${cand.id}`, backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.candidateDetailView(spa.view, { id: cand.id });
    const text = spa.text();
    assert.match(text, /Record Holder/);
    assert.match(text, /Portal login: record\.cand/);
    assert.match(text, /Target role: POV Track/);
    const row = spa.view.querySelector('table.data tbody tr');
    assert.ok(row, 'the allocated paper is listed');
    assert.equal(row.cells[0].textContent.trim(), 'POV Track');
    assert.equal(row.cells[2].textContent.trim(), '5', 'question count');
    assert.match(row.cells[3].textContent, /Allocated/);
    assert.match(text, /auto-allocated/i, 'the timeline carries the allocation');
  } finally { spa.teardown(); }
});

test('audit log: admin actions appear with actor and action', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  await w.candidateUser('audited.cand', { name: 'Audited Person' });
  const spa = await bootSpa({ hash: '#/audit', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.auditView(spa.view);
    const rows = [...spa.view.querySelectorAll('table tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' '));
    assert.ok(rows.length >= 3, `audit rows: ${rows.length}`);
    assert.ok(rows.some((r) => /Admin/.test(r) && /assessment_allocated/.test(r) && /Audited Person/.test(r)), 'the auto-allocation is audited');
    assert.ok(rows.some((r) => /user_created|candidate_created/.test(r)), 'the onboarding is audited');
  } finally { spa.teardown(); }
});

test('report: the admin copy of a finalized report names the assessor and shows the breakdown', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { token, assessmentId } = await w.candidateUser('reported.cand', { name: 'Reported Person' });
  const { user: assessor, token: aTok } = await w.assessorUser('rep.assessor');
  await w.walkAndSubmit(token, assessmentId);
  await w.assign(assessmentId, assessor.id);
  const fin = await w.scoreAndFinalize(aTok, assessmentId, { score: 5 });
  const spa = await bootSpa({ hash: `#/assessments/${assessmentId}/report`, backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.reportView(spa.view, { id: assessmentId });
    const text = spa.text();
    assert.match(text, /Reported Person/);
    assert.match(text, /Assessor rep\.assessor/);
    assert.match(text, new RegExp(`${fin.report.overall_pct}%`), 'the overall score is the finalized one');
    assert.match(text, /Architecture/);
    assert.match(text, /Advisory/);
    // Every question answered right and every open answer 5/5: 100%.
    assert.equal(fin.report.overall_pct, 100);
    assert.deepEqual([...spa.view.querySelectorAll('.report-legend li b')].map((b) => b.textContent.trim()), ['60%', '40%']);
  } finally { spa.teardown(); }
});

/* ------------------------------------------------------------------------- */
/* The assessor on the candidate record. Auto-allocated papers used to show   */
/* "unassigned" with no way to fix that from the candidate itself.           */
/* ------------------------------------------------------------------------- */

test('candidate record: Edit offers an Assessor select and saving it moves the auto-allocated paper', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { cand, assessmentId } = await w.candidateUser('edit.assessor', { name: 'Edit Assessor' });
  const { user: assessor } = await w.assessorUser('kim.assessor');
  assert.equal((await w.store.get('assessments', assessmentId)).assessor_id, null, 'starts unassigned');
  const spa = await bootSpa({ hash: `#/candidates/${cand.id}`, backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.candidateDetailView(spa.view, { id: cand.id });
    assert.match(spa.text(), /Assessor: unassigned/, 'the record says so');
    spa.view.querySelector('#edit').click();
    await flush(60);
    const modal = spa.document.getElementById('modal-root');
    const select = modal.querySelector('select[name="assessor_id"]');
    assert.ok(select, 'the Edit form has an Assessor field');
    assert.ok([...select.options].some((o) => o.value === assessor.id && /kim\.assessor/.test(o.textContent)), 'active assessors are offered');
    type(select, assessor.id);
    modal.querySelector('.m-foot .btn:last-child').click();
    await flush(200);
    assert.equal((await w.store.get('candidates', cand.id)).assessor_id, assessor.id, 'the candidate remembers the assessor');
    assert.equal((await w.store.get('assessments', assessmentId)).assessor_id, assessor.id, 'the open paper follows');
    assert.equal(spa.callsTo(`/admin/candidates/${cand.id}`, 'PATCH').length, 1);

    await admin.candidateDetailView(spa.view, { id: cand.id });
    assert.match(spa.text(), /Assessor: Assessor kim\.assessor/);
    const row = spa.view.querySelector('table.data tbody tr');
    assert.equal(row.cells[1].textContent.trim(), 'Assessor kim.assessor', 'the paper row names the assessor');
  } finally { spa.teardown(); }
});

test('candidates list: shows each candidate\'s assessor; the Add form offers the same select', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { user: assessor } = await w.assessorUser('lee.assessor');
  await w.candidateUser('with.assessor', { name: 'With Assessor' });
  await w.call('PATCH', `/admin/candidates/${(await w.store.list('candidates'))[0].id}`, { token: w.tok, body: { assessor_id: assessor.id } });
  await w.candidateUser('sans.assessor', { name: 'Sans Assessor' });
  const spa = await bootSpa({ hash: '#/candidates', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.candidatesView(spa.view);
    const heads = [...spa.view.querySelectorAll('#cand-list thead th')].map((th) => th.textContent.trim());
    assert.ok(heads.includes('Assessor'), 'the directory has an Assessor column');
    const col = heads.indexOf('Assessor');
    const cells = Object.fromEntries([...spa.view.querySelectorAll('#cand-list tbody tr')]
      .map((r) => [r.querySelector('b').textContent, r.cells[col].textContent.trim()]));
    assert.equal(cells['With Assessor'], 'Assessor lee.assessor');
    assert.equal(cells['Sans Assessor'], 'unassigned');

    spa.view.querySelector('#add-cand').click();
    await flush(60);
    const select = spa.document.querySelector('#modal-root select[name="assessor_id"]');
    assert.ok(select, 'Add candidate offers the Assessor field too');
    assert.ok([...select.options].some((o) => o.value === assessor.id));
  } finally { spa.teardown(); }
});

test('candidates: the import dialog has a default Assessor select and previews the assessor per row', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { user: assessor } = await w.assessorUser('mia.assessor');
  const { user: other } = await w.assessorUser('noa.assessor');
  const spa = await bootSpa({ hash: '#/candidates', backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');
    await admin.candidatesView(spa.view);
    spa.view.querySelector('#import-cands').click();
    await flush(120);
    const dialog = spa.document.querySelector('#modal-root .modal');
    const select = dialog.querySelector('#ic-assessor');
    assert.ok(select, 'the dialog has an assessor selector');
    assert.ok([...select.options].some((o) => o.value === assessor.id), 'assessors are listed');
    assert.match(dialog.textContent, /Assessor · Username/, 'the column list advertises the Assessor column');
    type(select, other.id);

    const csv = 'Name,Email,Target role,Assessor\nRow Rita,rita@example.com,POV Track,mia.assessor\nRow Ron,ron@example.com,POV Track,\n';
    const input = dialog.querySelector('#ic-file');
    const file = new spa.window.File([csv], 'people.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new spa.window.Event('change'));
    await flush(300);

    const heads = [...dialog.querySelectorAll('#ic-report thead th')].map((th) => th.textContent.trim());
    assert.ok(heads.includes('Assessor'), 'the preview has an Assessor column');
    const col = heads.indexOf('Assessor');
    const rows = Object.fromEntries([...dialog.querySelectorAll('#ic-report tbody tr')]
      .map((r) => [r.querySelector('b')?.textContent, r.cells[col]?.textContent.trim()]));
    assert.equal(rows['Row Rita'], 'Assessor mia.assessor', 'the row column wins');
    assert.equal(rows['Row Ron'], 'Assessor noa.assessor', 'a blank cell takes the dialog default');

    [...dialog.querySelectorAll('.m-foot .btn')].at(-1).click();
    await flush(400);
    const papers = await w.store.list('assessments');
    const byName = {};
    for (const p of papers) byName[(await w.store.get('candidates', p.candidate_id)).name] = p.assessor_id;
    assert.equal(byName['Row Rita'], assessor.id);
    assert.equal(byName['Row Ron'], other.id);
  } finally { spa.teardown(); }
});
