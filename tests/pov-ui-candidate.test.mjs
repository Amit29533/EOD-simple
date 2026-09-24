/**
 * Candidate point of view in the SPA (public/js/views/candidate.js), rendered
 * in jsdom. The journey (portal, exam hall, submission, report card) runs the
 * real views against the real in-process API (tests/helpers/world.mjs); the
 * proctoring and submit-retry checks use a stubbed API to control each reply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

const CANDIDATE = { id: 'u1', username: 'rohit', name: 'Rohit Verma', role: 'candidate', email: '' };

/* ------------------------------------------------------------ journey, end to end */

test('journey: allocated -> exam hall -> every question locked -> submitted, all through the UI', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ mcq: 3, open: 0, t });
  const { token, assessmentId } = await w.candidateUser('hall.cand', { name: 'Hall Walker' });
  const spa = await bootSpa({ hash: '#/journey', backend: { app: w.app, token }, stubTimers: true });
  try {
    const cand = await import('../public/js/views/candidate.js');

    // Portal: the allocated paper, with the way in.
    await cand.portalView(spa.view);
    assert.match(spa.text(), /Hall/, 'greets the candidate by first name');
    const enter = spa.view.querySelector(`a[href="#/assessments/${assessmentId}/quiz"]`);
    assert.ok(enter, 'an allocated paper links to the exam hall');
    assert.match(enter.textContent, /Enter exam hall/);
    assert.match(spa.text(), /3 questions/);

    // Exam hall: the rules gate first; entering needs the acknowledgement.
    spa.window.location.hash = `#/assessments/${assessmentId}/quiz`;
    await cand.quizView(spa.view, { id: assessmentId });
    await flush(60);
    const btn = spa.view.querySelector('#exam-enter');
    assert.ok(btn, 'the rules gate is shown before the paper');
    assert.equal(btn.disabled, true, 'cannot enter without acknowledging');
    const ack = spa.view.querySelector('#exam-ack');
    ack.checked = true;
    ack.dispatchEvent(new spa.window.Event('change', { bubbles: true }));
    assert.equal(btn.disabled, false);
    btn.click();
    await flush(150);

    // One question at a time: answer, lock, next.
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const prompt = spa.view.querySelector('.exam-question, .q-prompt, h2')?.textContent || '';
      seen.push(prompt);
      const option = spa.view.querySelector('input[name="q-cur"][value="a"]');
      assert.ok(option, `question ${i + 1} offers its options`);
      option.checked = true;
      option.dispatchEvent(new spa.window.Event('change', { bubbles: true }));
      const next = spa.view.querySelector('#exam-next');
      assert.match(next.textContent, i === 2 ? /Lock & submit/ : /Lock & continue/);
      next.click();
      await flush(200);
    }
    await flush(200);

    // The server holds a submitted paper with every answer locked and scored.
    const a = await w.store.get('assessments', assessmentId);
    assert.equal(a.status, 'submitted', 'the UI walk submitted the paper');
    const rows = await w.store.list('responses', { assessment_id: assessmentId });
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.locked, true, 'each answer was locked in its own window');
      assert.equal(r.answer, 'a');
      assert.equal(r.auto_score, 4);
    }
    assert.equal(spa.window.location.hash, '#/journey', 'the candidate is sent back to the journey');

    // Back on the portal: under review, no way back into the paper.
    await cand.portalView(spa.view);
    assert.match(spa.text(), /Under assessor review/);
    assert.equal(spa.view.querySelector(`a[href="#/assessments/${assessmentId}/quiz"]`), null);
  } finally { spa.teardown(); }
});

test('report card: released only after scoring, and the candidate copy hides assessor identity and comments', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const { token, assessmentId } = await w.candidateUser('card.cand', { name: 'Card Reader' });
  const { user: assessor, token: aTok } = await w.assessorUser('secret.assessor');
  await w.walkAndSubmit(token, assessmentId);

  // Before scoring the report is refused.
  const early = await w.call('GET', `/candidate/reports/${assessmentId}`, { token });
  assert.equal(early.status, 409);

  await w.assign(assessmentId, assessor.id);
  await w.scoreAndFinalize(aTok, assessmentId, { score: 3, comment: 'PRIVATE ASSESSOR NOTE' });

  const spa = await bootSpa({ hash: `#/assessments/${assessmentId}/report`, backend: { app: w.app, token } });
  try {
    const cand = await import('../public/js/views/candidate.js');
    await cand.portalView(spa.view);
    assert.ok(spa.view.querySelector(`a[href="#/assessments/${assessmentId}/report"]`), 'the portal links to the report card');

    await cand.reportView(spa.view, { id: assessmentId });
    const text = spa.text();
    assert.match(text, /Card Reader/);
    assert.match(text, /Architecture/);
    assert.doesNotMatch(text, /secret\.assessor|Assessor secret/i, 'the assessor is not named to the candidate');
    assert.doesNotMatch(text, /PRIVATE ASSESSOR NOTE/, 'assessor comments stay internal');
    assert.equal(spa.view.querySelectorAll('.report-legend li').length, 2);
  } finally { spa.teardown(); }
});

/* ------------------------------------------------------------ proctoring beacons */

test('one blocked paste into the answer box is logged once, as paste_attempt', { skip: SKIP }, async () => {
  const q = {
    id: 'q7', competency_id: 'comp1', type: 'text', order: 6, points: 6, prompt: 'Redesign the pipeline.',
    help_text: '', options: [], difficulty: 'advanced', pin_first: false, audio_required: true,
  };
  const paper = {
    assessment: { id: 'asm1', status: 'in_progress', role: { name: 'RSA' } },
    exam: { index: 6, total: 10, phase: 'answer', remaining_ms: 118_000, budgets: { review_ms: 60_000, answer_ms: 120_000 }, integrity: {}, complete: false },
    current_question: q, current_answer: null, competency: null, questions: [q], competencies: [], answers: {},
  };
  const beacons = [];
  // The hall paints only while the route is the exam (it stands down once
  // the candidate has navigated away), so the DOM starts on the exam route.
  const spa = await bootSpa({
    hash: '#/assessments/asm1/quiz', user: CANDIDATE, candidate: { id: 'c1' }, stubTimers: true,
    routes: (m, p, body) => {
      if (p === '/candidate/assessments/asm1') return paper;
      if (p.endsWith('/integrity')) { beacons.push(body.event); return { integrity: {}, events: [] }; }
      return undefined;
    },
  });
  try {
    spa.window.sessionStorage.setItem('ecod.exam.ack.asm1', '1');
    const cand = await import('../public/js/views/candidate.js');
    await cand.quizView(spa.view, { id: 'asm1' });
    await flush(80);
    beacons.length = 0; // entering the hall logs its own events
    const ta = spa.view.querySelector('#exam-ta');
    assert.ok(ta, 'the open-answer box is rendered');
    const ev = new spa.window.Event('paste', { bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await flush(80);
    assert.equal(ev.defaultPrevented, true, 'the paste is blocked');
    assert.deepEqual(beacons, ['paste_attempt'], 'one paste, one beacon');
  } finally { spa.teardown(); }
});

/* ------------------------------------------------------------ submit handover */

test('submitExam: a storage insert race is retried, never reported as a submission', { skip: SKIP }, async () => {
  const replies = [];
  const posts = [];
  const spa = await bootSpa({
    user: CANDIDATE, candidate: { id: 'c1' },
    routes: (m, p) => {
      if (!p.endsWith('/submit')) return undefined;
      posts.push(p);
      return replies.shift() || { status: 500, body: { error: 'unexpected extra call' } };
    },
  });
  try {
    const { submitExam } = await import('../public/js/views/candidate.js');
    const race = { status: 409, body: { error: 'That record was created by another request at the same time. Please refresh and try again.' } };

    // The race, then success: the second attempt's real answer is returned.
    replies.push(race, { status: 200, body: { status: 'submitted', auto_scored: 3 } });
    const ok = await submitExam('asm1', { backoffMs: 1 });
    assert.deepEqual(ok, { status: 'submitted', auto_scored: 3 });
    assert.equal(posts.length, 2, 'the race was retried');

    // The race every time: a failure, never a pretend success.
    posts.length = 0;
    replies.push(race, race, race);
    await assert.rejects(() => submitExam('asm1', { backoffMs: 1 }), (err) => err.status === 409);
    assert.equal(posts.length, 3);

    // The route's own conflict still means an earlier attempt landed.
    posts.length = 0;
    replies.push({ status: 409, body: { error: 'This assessment has already been submitted.' } });
    assert.deepEqual(await submitExam('asm1', { backoffMs: 1 }), { status: 'submitted', already: true });
    assert.equal(posts.length, 1);
  } finally { spa.teardown(); }
});
