import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

const candidate = { id: 'c1', name: 'UI Audit', stage: 'assessment' };
const paper = { id: 'a1', status: 'assigned', access_state: 'upcoming', role_name: 'Scheduled track', question_count: 2,
  scheduled_at: '2030-01-01T04:30:00Z', expires_at: '2030-01-01T06:30:00Z' };
const portal = (assessments) => ({ candidate, assessments });

test('the password-change UI preserves leading and trailing password characters', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t }); const c = await w.candidateUser('space.password', { allocate: false });
  const current = '  Candidate password 2026  ', next = '  New candidate password 2026  ';
  await w.store.update('users', c.user.id, { password_hash: hashPassword(current) });
  const token = await w.login('space.password', current);
  const spa = await bootSpa({ backend: { app: w.app, token } });
  try {
    const { changePassword } = await import('../public/js/account-security.js');
    const changed = changePassword(); await flush();
    for (const [key, value] of Object.entries({ current_password: current, new_password: next, confirm_password: next }))
      type(spa.document.querySelector(`[name="${key}"]`), value);
    spa.document.querySelector('.m-foot .btn:last-child').click(); await flush(180);
    assert.equal(spa.callsTo('/auth/password')[0].body.current_password, current);
    assert.equal(spa.callsTo('/auth/password')[0].body.new_password, next);
    await changed;
    assert.equal((await w.call('POST', '/auth/login', { body: { username: 'space.password', password: next } })).status, 200);
  } finally { spa.teardown(); }
});

test('invalid scheduled dates do not crash booking tables or the candidate journey', { skip: SKIP }, async () => {
  const spa = await bootSpa({ routes: () => portal([{ ...paper, scheduled_at: 'bad-date', expires_at: 'bad-date' }]) });
  try {
    const { bookingTime, bookingTable } = await import('../public/js/views/bookings.js');
    assert.equal(bookingTime('bad-date'), '—');
    assert.doesNotThrow(() => bookingTable([{ name: 'Bad date', scheduled_at: 'bad-date', scheduled_end_at: 'bad-date' }]));
    const { portalView } = await import('../public/js/views/candidate.js');
    await assert.doesNotReject(portalView(spa.view));
    assert.match(spa.text(), /Scheduled track/);
  } finally { spa.teardown(); }
});

test('future and cancelled exams are not counted as ready to enter', { skip: SKIP }, async () => {
  const spa = await bootSpa({ routes: () => portal([paper, { ...paper, id: 'a2', access_state: 'cancelled' }]) });
  try {
    const { portalView } = await import('../public/js/views/candidate.js'); await portalView(spa.view);
    const ready = [...spa.view.querySelectorAll('.overview-item')].find((el) => el.textContent.includes('Ready or in progress'));
    assert.equal(ready.querySelector('b').textContent, '0');
    assert.doesNotMatch(spa.view.querySelector('.candidate-heading').textContent, /ready for you/);
  } finally { spa.teardown(); }
});

test('refreshing availability stops microphone practice before replacing its controls', { skip: SKIP }, async () => {
  const spa = await bootSpa({ routes: () => portal([paper]) }); let stopped = 0;
  try {
    Object.defineProperty(spa.window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) } });
    spa.window.MediaRecorder = class {
      mimeType = 'audio/webm'; state = 'inactive';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    };
    spa.window.HTMLMediaElement.prototype.pause = () => {};
    const { portalView } = await import('../public/js/views/candidate.js'); await portalView(spa.view);
    await spa.view.querySelector('[data-mic-start]').onclick();
    assert.equal(stopped, 0);
    await spa.view.querySelector('#refresh-exam-availability').onclick();
    assert.ok(stopped > 0, 'refresh must release the microphone owned by the removed practice panel');
  } finally {
    spa.document.dispatchEvent(new spa.window.Event('ecod:view-unmount')); spa.teardown();
  }
});

test('availability refresh failure retains the journey and offers retry without an unhandled rejection', { skip: SKIP }, async () => {
  let fail = false;
  const spa = await bootSpa({ routes: () => fail ? { status: 503, body: { error: 'Temporary failure' } } : portal([paper]) });
  try {
    const { portalView } = await import('../public/js/views/candidate.js'); await portalView(spa.view); fail = true;
    await assert.doesNotReject(async () => spa.view.querySelector('#refresh-exam-availability').onclick());
    assert.match(spa.text(), /Scheduled track/);
    assert.equal(spa.view.querySelector('#refresh-exam-availability').disabled, false);
    assert.match(spa.document.querySelector('#toast-root').textContent, /Temporary failure/);
  } finally { spa.teardown(); }
});

test('a failed hall-entry request restores an acknowledged gate and can be retried', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const c = await w.candidateUser('entry.retry'); let fail = true;
  const spa = await bootSpa({ hash: `#/assessments/${c.assessmentId}/quiz`, stubTimers: true, backend: { token: c.token,
    app: (ctx) => ctx.method === 'GET' && ctx.path === `/candidate/assessments/${c.assessmentId}` && fail
      ? Promise.resolve({ status: 503, body: { error: 'Entry temporarily unavailable' } }) : w.app(ctx) } });
  try {
    const { quizView } = await import('../public/js/views/candidate.js'); await quizView(spa.view, { id: c.assessmentId });
    const ack = spa.view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    await spa.view.querySelector('#exam-enter').onclick(); await flush(30);
    assert.match(spa.text(), /Entry temporarily unavailable/);
    assert.equal(spa.view.querySelector('#exam-ack').checked, true);
    assert.equal(spa.view.querySelector('#exam-enter').disabled, false);
    fail = false; await spa.view.querySelector('#exam-enter').onclick();
    assert.ok(spa.view.querySelector('#exam-next'), 'retry reaches the live question');
    assert.equal((await w.store.get('assessments', c.assessmentId)).status, 'in_progress');
  } finally { spa.document.dispatchEvent(new spa.window.Event('ecod:view-unmount')); spa.teardown(); }
});
