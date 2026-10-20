import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { EXAM_SESSION_MS } from '../src/api/exam-expiry.mjs';

async function bookedWorld(t) {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const invite = await w.call('POST', '/admin/test-bookings/links', { token: w.tok, body: { role_id: w.role.id } });
  const result = await w.call('POST', '/public/test-bookings', { body: {
    token: invite.body.path.split('/').at(-1), request_id: 'lifecycle-audit-request-2026', name: 'Lifecycle Candidate',
    email: 'lifecycle@example.com', phone: '+919876543210', role_id: w.role.id,
    date: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), time: '10:00',
    password: 'Lifecycle-password-2026', confirm_password: 'Lifecycle-password-2026',
  } });
  assert.equal(result.status, 200);
  const booking = await w.store.get('test_bookings', invite.body.invitation.id);
  return { ...w, booking, candidateToken: await w.login('lifecycle@example.com', 'Lifecycle-password-2026') };
}

test('cancelled bookings leave the active queue, never become scoreable on expiry and allow a replacement exam', async (t) => {
  const w = await bookedWorld(t), id = w.booking.assessment_id;
  const assessor = await w.assessorUser('cancellation.assessor'); await w.assign(id, assessor.user.id);
  const cancelled = await w.call('POST', `/admin/test-bookings/${w.booking.id}/cancel`, { token: w.tok });
  assert.equal(cancelled.status, 200);
  assert.equal((await w.store.get('assessments', id)).status, 'cancelled');
  assert.equal((await w.call('GET', '/admin/dashboard', { token: w.tok })).body.counts.active_assessments, 0);
  await w.store.update('assessments', id, { scheduled_at: new Date(Date.now() - EXAM_SESSION_MS - 1000).toISOString() });
  const list = await w.call('GET', '/candidate/assessments', { token: w.candidateToken });
  assert.equal(list.body.assessments[0].status, 'cancelled');
  assert.equal(list.body.assessments[0].exam_expired, false);
  const path = `/assessor/assessments/${id}`;
  assert.equal((await w.call('GET', path, { token: assessor.token })).status, 409);
  assert.equal((await w.call('POST', path + '/finalize', { token: assessor.token })).status, 409);
  const replacement = await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: w.booking.candidate_id, role_id: w.role.id } });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
});

test('interrupted booking cancellation is repairable and cannot turn into an awaiting-scoring attempt', async (t) => {
  const w = await bookedWorld(t), id = w.booking.assessment_id;
  const change = w.store.changeRow.bind(w.store); let fail = true;
  w.store.changeRow = async (table, key, decide) => {
    if (table === 'assessments' && fail) { fail = false; throw new Error('cancel status write failed'); }
    return change(table, key, decide);
  };
  assert.equal((await w.call('POST', `/admin/test-bookings/${w.booking.id}/cancel`, { token: w.tok })).status, 500);
  assert.equal((await w.call('POST', `/admin/test-bookings/${w.booking.id}/cancel`, { token: w.tok })).status, 200);
  assert.equal((await w.store.get('assessments', id)).status, 'cancelled');
});

test('deleting a booked assessment cancels its slot instead of advertising an exam link that no longer exists', async (t) => {
  const w = await bookedWorld(t), id = w.booking.assessment_id;
  assert.equal((await w.call('DELETE', `/admin/assessments/${id}`, { token: w.tok })).status, 200);
  assert.equal((await w.store.get('test_bookings', w.booking.id)).status, 'cancelled');
  const dashboard = await w.call('GET', '/admin/dashboard', { token: w.tok });
  assert.equal(dashboard.body.counts.upcoming_tests, 0);
  assert.equal(await w.store.get('assessments', id), null, 'dashboard repair must not recreate a deleted exam');
});

test('an invalid booked schedule fails closed instead of granting an unscheduled attempt', async (t) => {
  const w = await bookedWorld(t), id = w.booking.assessment_id;
  await w.store.update('assessments', id, { scheduled_at: 'bad-date' });
  const result = await w.call('GET', `/candidate/assessments/${id}`, { token: w.candidateToken });
  assert.equal(result.status, 409);
  assert.equal((await w.store.get('assessments', id)).status, 'assigned');
  assert.equal((await w.store.get('assessments', id)).started_at, undefined);
  const list = await w.call('GET', '/candidate/assessments', { token: w.candidateToken });
  assert.equal(list.body.assessments[0].access_state, 'unavailable');
});

test('a submitted exam leaves Upcoming tests immediately, even while its booked window is still open', async (t) => {
  const w = await bookedWorld(t), id = w.booking.assessment_id;
  const start = Date.now() - 60_000;
  const schedule = { scheduled_at: new Date(start).toISOString(), scheduled_end_at: new Date(start + EXAM_SESSION_MS).toISOString() };
  await w.store.update('test_bookings', w.booking.id, schedule); await w.store.update('assessments', id, schedule);
  await w.walkAndSubmit(w.candidateToken, id);
  const dashboard = await w.call('GET', '/admin/dashboard', { token: w.tok });
  assert.equal(dashboard.body.counts.upcoming_tests, 0);
  const list = await w.call('GET', '/admin/test-bookings', { token: w.tok });
  assert.equal(list.body.bookings[0].assessment_status, 'submitted');
  assert.equal(list.body.bookings[0].status, 'booked', 'completion does not make the invitation reusable');
});
