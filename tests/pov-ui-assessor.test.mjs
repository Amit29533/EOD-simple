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

/**
 * A sitting with a real recorded answer on each open question, finalized. The
 * shared `walkAndSubmit` helper answers open questions with typed text only, so
 * the clip-facing behaviour needs its own walk.
 */
async function recordedWorld(t) {
  const w = await makeWorld({ t });
  const A = await w.assessorUser('ui.rec.assessor');
  const cand = await w.candidateUser('ui.rec.cand', { name: 'Recorded Rae' });
  for (;;) {
    const s = await w.call('GET', `/candidate/assessments/${cand.assessmentId}`, { token: cand.token });
    const q = s.body.current_question;
    if (!q || s.body.exam.complete) break;
    const answer = q.type === 'text'
      ? { text: `Notes for question ${q.prompt.slice(-2)}`, transcript: 'Spoken answer kept as evidence.', source: 'audio', audio_b64: 'QUJD'.repeat(60), audio_mime: 'audio/webm' }
      : 'a';
    const r = await w.call('POST', `/candidate/assessments/${cand.assessmentId}/next`, { token: cand.token, body: { answer, question_id: q.id } });
    assert.equal(r.status, 200);
    if (r.body.complete) break;
  }
  assert.equal((await w.call('POST', `/candidate/assessments/${cand.assessmentId}/submit`, { token: cand.token, body: { answers: {} } })).status, 200);
  await w.assign(cand.assessmentId, A.user.id);
  await w.scoreAndFinalize(A.token, cand.assessmentId, { score: 4 });
  return { w, A, id: cand.assessmentId };
}

test('a finalized paper opens its answer sheet and recordings — the evidence is still there, read-only', { skip: SKIP }, async (t) => {
  const { w, A, id } = await recordedWorld(t);
  const a = await w.store.get('assessments', id);
  assert.equal(a.status, 'scored');

  const spa = await bootSpa({ hash: `#/assessments/${id}/answers`, backend: { app: w.app, token: A.token } });
  try {
    const assessor = await import('../public/js/views/assessor.js');
    await assessor.answersView(spa.view, { id });
    await flush(80);
    const text = spa.text();
    assert.match(text, /Answer sheet · report finalized/, 'the review screen, not the report');
    assert.match(text, /View report card/, 'and the report card is one click away');
    assert.equal(spa.view.querySelector('#finalize-btn'), null, 'nothing to finalize any more');
    // The answer sheet itself: notes and transcript survive finalization.
    assert.match(text, /Notes for question/);
    assert.match(text, /\[Transcript\]/);
    assert.match(text, /Spoken answer kept as evidence/);
    // Marks are shown, inputs are locked.
    const scoreInputs = [...spa.view.querySelectorAll('input[id^="score-"]')];
    assert.ok(scoreInputs.length >= 1, 'the open answers are listed');
    assert.ok(scoreInputs.every((el) => el.disabled), 'locked scores render read-only');
    assert.equal(spa.view.querySelector('.report-legend'), null, 'this screen is the sheet, not the report');
    // The recordings are playable, one player per spoken answer.
    const players = [...spa.view.querySelectorAll('audio.exam-audio-playback')];
    assert.equal(players.length, 2, 'one player per recorded answer');
    assert.match(players[0].src, /^data:audio\/webm;base64,/);
    assert.ok(spa.view.querySelector('[data-delete-recording]'), 'and each player can be deleted by hand');
    assert.match(text, /deleted automatically on/, 'the retention window is stated');
  } finally { spa.teardown(); }
});

test('the assessor can delete one recording from the portal: confirm, DELETE, and the note replaces the player', { skip: SKIP }, async (t) => {
  const { w, A, id } = await recordedWorld(t);
  const spa = await bootSpa({ hash: `#/assessments/${id}/answers`, backend: { app: w.app, token: A.token } });
  try {
    const assessor = await import('../public/js/views/assessor.js');
    await assessor.answersView(spa.view, { id });
    await flush(80);
    const openRows = [...spa.view.querySelectorAll('.q-card')].filter((c) => c.querySelector('[data-delete-recording]'));
    assert.equal(openRows.length, 2, 'both recorded answers offer the delete');
    const btn = openRows[0].querySelector('[data-delete-recording]');
    const qid = btn.dataset.deleteRecording;
    assert.ok((await w.store.list('recordings', { assessment_id: id, question_id: qid })).length, 'the clip is stored');

    btn.click();
    await flush(40);
    const confirm = spa.document.querySelector('#modal-root .m-foot .btn:last-child');
    assert.ok(confirm, 'deleting asks for confirmation');
    assert.match(confirm.textContent, /Delete recording/);
    assert.match(spa.document.getElementById('modal-root').textContent, /only copy/i, 'the warning says it cannot be undone');
    confirm.click();
    await flush(150);

    assert.equal((await w.store.list('recordings', { assessment_id: id, question_id: qid })).length, 0, 'the clip is gone from storage');
    assert.equal((await w.store.list('recordings', { assessment_id: id })).length, 1, 'the other recording is untouched');
    assert.match(openRows[0].textContent, /Recording deleted/, 'the slot says so instead of showing a broken player');
    assert.equal(openRows[0].querySelector('[data-delete-recording]'), null, 'and the button is gone');
    assert.ok(toasts(spa.document).some((m) => /Recording deleted/.test(m)));
    // The answer sheet itself (notes + transcript) is still on screen.
    assert.match(openRows[0].textContent, /Notes for question/);
    assert.match(openRows[0].textContent, /Spoken answer kept as evidence/);
    assert.ok((await w.store.list('audit_log', { action: 'assessment_recording_deleted' })).length === 1);
  } finally { spa.teardown(); }
});

test('a purged paper explains itself: the sheet note replaces the blank, and no player is offered', { skip: SKIP }, async (t) => {
  const { w, A, id } = await recordedWorld(t);
  await w.call('PUT', '/admin/settings/retention', { token: w.tok, body: { days: 0 } });
  assert.equal((await w.call('POST', '/admin/retention/run', { token: w.tok })).status, 200);
  const spa = await bootSpa({ hash: `#/assessments/${id}/answers`, backend: { app: w.app, token: A.token } });
  try {
    const assessor = await import('../public/js/views/assessor.js');
    await assessor.answersView(spa.view, { id });
    await flush(60);
    const text = spa.text();
    assert.match(text, /answer sheet deleted by the retention policy/i, 'the hole is explained');
    assert.match(text, /deleted by the retention policy on/, 'the retention line says when');
    assert.equal(spa.view.querySelectorAll('audio.exam-audio-playback').length, 0, 'nothing left to play');
    assert.equal(spa.view.querySelector('[data-delete-recording]'), null, 'and nothing left to delete');
    assert.match(text, /2\/2 open questions scored/, 'the marks are still shown');
  } finally { spa.teardown(); }
});
