/**
 * Assessor point of view in the SPA (public/js/views/assessor.js), rendered
 * in jsdom against the real in-process API (tests/helpers/world.mjs): the
 * workspace queue, the scoring screen (rubric, score entry and its guard
 * rails, progress), finalization through the confirm dialog, and the report
 * a finalized paper opens as.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

async function reviewWorld(t) {
  const w = await makeWorld({ t });
  const A = await w.assessorUser('ui.assessor');
  const done = await w.candidateUser('done.cand', { name: 'Submitted Sam' });
  const waiting = await w.candidateUser('wait.cand', { name: 'Waiting Wren' });
  await w.walkAndSubmit(done.token, done.assessmentId);
  await w.assign(done.assessmentId, A.user.id);
  await w.assign(waiting.assessmentId, A.user.id);
  const openQs = (await w.store.get('assessments', done.assessmentId)).snapshot_json.questions.filter((q) => q.type === 'text');
  return { w, A, id: done.assessmentId, waitingId: waiting.assessmentId, openQs };
}

const toasts = (doc) => [...doc.querySelectorAll('#toast-root .toast')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());

test('workspace: submitted papers are flagged for scoring, unsubmitted ones are listed without an action', { skip: SKIP }, async (t) => {
  const { w, A, id, waitingId } = await reviewWorld(t);
  const spa = await bootSpa({ hash: '#/workspace', backend: { app: w.app, token: A.token } });
  try {
    const assessor = await import('../public/js/views/assessor.js');
    await assessor.workspaceView(spa.view);
    const text = spa.text();
    assert.match(text, /2 assigned/);
    assert.match(text, /1 assessment awaiting your scoring/);
    const rows = [...spa.view.querySelectorAll('table.data tbody tr')];
    assert.equal(rows.length, 2);
    const sam = rows.find((r) => /Submitted Sam/.test(r.textContent));
    const wren = rows.find((r) => /Waiting Wren/.test(r.textContent));
    const scoreNow = sam.querySelector(`a[href="#/assessments/${id}"]`);
    assert.ok(scoreNow, 'a submitted paper links to scoring');
    assert.match(scoreNow.textContent, /Score now/);
    assert.match(wren.textContent, /not yet/, 'no submission time yet');
    assert.equal(wren.querySelector('a'), null, 'nothing to open before submission');
    assert.equal(wren.querySelector(`a[href="#/assessments/${waitingId}"]`), null);
  } finally { spa.teardown(); }
});

test('scoring screen: rubric on show, out-of-range scores refused locally, valid ones saved, finalize gated then confirmed', { skip: SKIP }, async (t) => {
  const { w, A, id, openQs } = await reviewWorld(t);
  const spa = await bootSpa({ hash: `#/assessments/${id}`, backend: { app: w.app, token: A.token } });
  try {
    const assessor = await import('../public/js/views/assessor.js');
    await assessor.assessmentView(spa.view, { id });
    await flush(60);
    const text = spa.text();
    assert.match(text, /Submitted Sam/);
    assert.match(text, /Names the trade-offs\./, 'the rubric is shown to the assessor');
    assert.match(text, /Architecture/);
    assert.match(text, /Advisory/);
    const progress = spa.view.querySelector('#score-progress');
    assert.equal(progress.textContent, '0/2 open questions scored');

    // Finalizing early is stopped in the browser: no request goes out.
    spa.view.querySelector('#finalize-btn').click();
    await flush(40);
    assert.ok(toasts(spa.document).some((m) => /Score all 2 open questions before finalizing \(0 done\)/.test(m)));
    assert.equal(spa.callsTo(`/assessor/assessments/${id}/finalize`).length, 0);

    // Out of range: refused, reset, nothing saved.
    const [q1, q2] = openQs;
    const input1 = spa.view.querySelector(`#score-${q1.id}`);
    assert.ok(input1, 'each open question has a score input');
    type(input1, '9');
    await flush(40);
    assert.ok(toasts(spa.document).some((m) => /Score must be between 0 and 5/.test(m)));
    assert.equal(input1.value, '', 'the bad value is cleared');
    assert.equal(spa.callsTo(`/assessor/assessments/${id}/scores`).length, 0);

    // Valid scores and a comment reach the server.
    type(input1, '4');
    await flush(80);
    type(spa.view.querySelector(`#comment-${q1.id}`), 'Good structure, thin on cost.');
    await flush(80);
    type(spa.view.querySelector(`#score-${q2.id}`), '2.5');
    await flush(80);
    assert.equal(progress.textContent, '2/2 open questions scored');
    const rows = await w.store.list('responses', { assessment_id: id });
    const r1 = rows.find((r) => r.question_id === q1.id);
    assert.equal(r1.assessor_score, 4);
    assert.equal(r1.assessor_comment, 'Good structure, thin on cost.');
    assert.equal(rows.find((r) => r.question_id === q2.id).assessor_score, 2.5);

    // Finalize: the confirm dialog, then the report replaces the screen.
    spa.view.querySelector('#finalize-btn').click();
    await flush(40);
    const confirm = spa.document.querySelector('#modal-root .m-foot .btn:last-child');
    assert.ok(confirm, 'finalizing asks for confirmation');
    assert.match(confirm.textContent, /Finalize & generate/);
    confirm.click();
    await flush(200);
    const a = await w.store.get('assessments', id);
    assert.equal(a.status, 'scored', 'the server finalized the paper');
    assert.ok(spa.view.querySelector('.report-legend'), 'the report card is rendered in place');
    assert.match(spa.text(), new RegExp(`${a.overall_pct}%`));
    assert.ok(toasts(spa.document).some((m) => /Report generated:/.test(m)));
  } finally { spa.teardown(); }
});

test('a finalized paper opens as its report; an unsubmitted one is refused and never shows a scoring screen', { skip: SKIP }, async (t) => {
  const { w, A, id, waitingId } = await reviewWorld(t);
  await w.scoreAndFinalize(A.token, id, { score: 5 });
  const spa = await bootSpa({ hash: `#/assessments/${id}`, backend: { app: w.app, token: A.token } });
  try {
    const assessor = await import('../public/js/views/assessor.js');
    await assessor.assessmentView(spa.view, { id });
    assert.ok(spa.view.querySelector('.report-legend'), 'the report, not the scoring screen');
    assert.equal(spa.view.querySelector('#finalize-btn'), null);
    assert.match(spa.text(), /Submitted Sam/);

    // The API refuses an unsubmitted paper (409); the router's error page
    // would show it. The view itself must not render a scoring screen.
    await assert.rejects(() => assessor.assessmentView(spa.view, { id: waitingId }), (err) => err.status === 409);
    assert.equal(spa.view.querySelector('#finalize-btn'), null);
  } finally { spa.teardown(); }
});
