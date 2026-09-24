/**
 * Dates the app did not write itself (a hand-edited Airtable base, a migrated
 * or hand-edited JSON store) must not take a screen down. `fmtDate` and
 * `fmtDateTime` used to throw `RangeError: Invalid time value` on an
 * unreadable date, so one bad row replaced a whole list with the error page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDate, fmtDateTime } from '../public/js/ui.js';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

const UNREADABLE = ['not-a-date', '2026-13-45', '31/02/2026 25:61', {}, [], 1e20, 'Infinity', '\u0000'];

test('an unreadable date reads like a missing one', () => {
  for (const v of UNREADABLE) {
    assert.equal(fmtDate(v), '—', `fmtDate(${JSON.stringify(v)})`);
    assert.equal(fmtDateTime(v), '—', `fmtDateTime(${JSON.stringify(v)})`);
  }
  for (const v of ['', null, undefined, 0]) {
    assert.equal(fmtDate(v), '—');
    assert.equal(fmtDateTime(v), '—');
  }
});

test('readable dates still format as before', () => {
  const iso = '2026-09-24T09:00:00.000Z';
  assert.match(fmtDate(iso), /24/);
  assert.match(fmtDate(iso), /2026/);
  assert.match(fmtDateTime(iso), /24/);
  assert.equal(fmtDate(iso), new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)));
  assert.equal(fmtDate(Date.parse(iso)), fmtDate(iso), 'epoch milliseconds are a readable date too');
});

test('one row with an unreadable date leaves every admin screen standing', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const good = await w.candidateUser('good.dates', { name: 'Good Dates' });
  const bad = await w.candidateUser('bad.dates', { name: 'Bad Dates' });
  // What a hand edit leaves behind: the paper, the candidate and one audit row
  // carry dates no parser can read.
  await w.store.update('assessments', bad.assessmentId, { created_at: 'not-a-date' });
  await w.store.update('candidates', bad.cand.id, { created_at: '2026-13-45' });
  const [someAudit] = await w.store.list('audit_log');
  await w.store.update('audit_log', someAudit.id, { created_at: 'garbage' });
  assert.equal((await w.store.get('assessments', bad.assessmentId)).created_at, 'not-a-date', 'the store holds the bad date');

  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const admin = await import('../public/js/views/admin.js');

    await admin.assessmentsView(spa.view);
    assert.equal(spa.view.querySelector('.error-page'), null, 'the assessments list renders');
    const rows = [...spa.view.querySelectorAll('table tbody tr')].map((r) => r.textContent);
    assert.equal(rows.length, 2, 'both papers are listed');
    assert.ok(rows.some((r) => /Bad Dates/.test(r) && /—/.test(r)), 'the bad date reads "—"');
    assert.ok(rows.some((r) => /Good Dates/.test(r)));

    await admin.candidatesView(spa.view);
    assert.equal(spa.view.querySelectorAll('#cand-list tbody tr').length, 2, 'the candidates list renders both');

    await admin.candidateDetailView(spa.view, { id: bad.cand.id });
    assert.match(spa.text(), /Bad Dates/, 'the candidate record renders');

    await admin.auditView(spa.view);
    assert.equal(spa.view.querySelector('.error-page'), null, 'the audit log renders');
    assert.ok(spa.view.querySelectorAll('table tbody tr').length >= 3);
  } finally { spa.teardown(); }
  assert.ok(good.assessmentId);
});
