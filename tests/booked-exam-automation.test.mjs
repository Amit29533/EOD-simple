import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { EXAM_SESSION_MS, examDeadline, examHasExpired, assertExamAccess } from '../src/api/exam-expiry.mjs';
import { verifyPassword } from '../src/core/passwords.mjs';

const PASSWORD = 'Candidate-password-2026';
const date = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
async function invitation(w, bound = true) {
  const r = await w.call('POST', '/admin/test-bookings/links', { token: w.tok, body: bound ? { role_id: w.role.id } : {} });
  assert.equal(r.status, 201);
  return { id: r.body.invitation.id, token: r.body.path.split('/').at(-1) };
}
const values = (w, link, patch = {}) => ({ token: link.token, name: 'Scheduled Candidate', email: `${link.id}@example.com`, phone: '+91 9876543210',
  role_id: w.role.id, date: date(), time: '10:00', password: PASSWORD, confirm_password: PASSWORD, request_id: 'scheduled-booking-request-1234', ...patch });
const book = (w, link, patch) => w.call('POST', '/public/test-bookings', { body: values(w, link, patch) });
async function windowAt(w, link, assessmentId, start) {
  const scheduled_at = new Date(start).toISOString(), scheduled_end_at = new Date(start + EXAM_SESSION_MS).toISOString();
  await w.store.update('test_bookings', link.id, { scheduled_at, scheduled_end_at });
  await w.store.update('assessments', assessmentId, { scheduled_at, scheduled_end_at });
}

test('booking creates linked profile, password-protected account and immutable chosen paper with a fixed two-hour window', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w);
  const result = await book(w, link, { role: 'admin', active: false, assessor_id: 'forged', candidate_id: 'someone-else' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const booking = await w.store.get('test_bookings', link.id);
  const user = await w.store.get('users', booking.user_id);
  const candidate = await w.store.get('candidates', booking.candidate_id);
  const paper = await w.store.get('assessments', booking.assessment_id);
  assert.equal(user.role, 'candidate'); assert.equal(user.active, true);
  assert.equal(user.candidate_id, candidate.id);
  assert.equal(candidate.stage, 'assessment'); assert.equal(candidate.target_role_id, w.role.id);
  assert.ok(verifyPassword(PASSWORD, user.password_hash));
  assert.equal(paper.candidate_id, candidate.id); assert.equal(paper.role_id, w.role.id);
  assert.equal(paper.status, 'assigned'); assert.equal(paper.snapshot_json.questions.length, 2);
  assert.equal(paper.booking_id, link.id);
  assert.equal(Date.parse(paper.scheduled_end_at) - Date.parse(paper.scheduled_at), EXAM_SESSION_MS);
  assert.equal(examDeadline(paper), Date.parse(paper.scheduled_end_at));
  assert.equal(booking.provisioning_json, null, 'temporary hash/snapshot plan is cleared after setup');
  assert.ok(!JSON.stringify(booking).includes(PASSWORD));
  assert.ok(!JSON.stringify(result.body).includes('password_hash'));
  assert.equal(result.body.exam_path, `#/assessments/${paper.id}/quiz`);
  const token = await w.login(values(w, link).email, PASSWORD);
  assert.equal((await w.call('GET', '/auth/me', { token })).body.user.candidate_id, candidate.id);
  assert.equal((await w.call('GET', '/admin/users', { token })).status, 403);
});

test('every exam entry/write endpoint rejects early access, including attempts to change the booked time in client input', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w); await book(w, link);
  const booking = await w.store.get('test_bookings', link.id);
  const token = await w.login(values(w, link).email, PASSWORD);
  const path = `/candidate/assessments/${booking.assessment_id}`;
  for (const [method, suffix, body] of [
    ['GET', '', {}], ['PUT', '/answers', { answers: {} }], ['POST', '/phase', { phase: 'answer' }],
    ['POST', '/next', { answer: 'a' }], ['POST', '/integrity', { event: 'exam_start' }], ['POST', '/submit', { answers: {} }],
  ]) {
    const result = await w.call(method, path + suffix, { token, body: { ...body, scheduled_at: '2020-01-01', started_at: '2020-01-01' } });
    assert.equal(result.status, 409, `${method} ${suffix}`);
    assert.match(result.body.error, /opens on/);
  }
  const paper = await w.store.get('assessments', booking.assessment_id);
  assert.equal(paper.status, 'assigned'); assert.equal(paper.started_at, undefined); assert.equal(paper.quiz_state, undefined);
  assert.equal((await w.store.list('responses', { assessment_id: paper.id })).length, 0);
  const list = (await w.call('GET', '/candidate/assessments', { token })).body;
  assert.equal(list.assessments[0].access_state, 'upcoming');
  assert.equal(list.assessments[0].expires_at, paper.scheduled_end_at);
  assert.ok(!JSON.stringify(list).includes('correct_option_ids'));
});

test('late arrival receives only the remaining window; expiry preserves saved answers and prevents further writes', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w); await book(w, link);
  const booking = await w.store.get('test_bookings', link.id);
  const token = await w.login(values(w, link).email, PASSWORD);
  await windowAt(w, link, booking.assessment_id, Date.now() - 30 * 60_000);
  const path = `/candidate/assessments/${booking.assessment_id}`;
  const opened = await w.call('GET', path, { token });
  assert.equal(opened.status, 200);
  assert.ok(opened.body.exam.session_remaining_ms <= 90 * 60_000 && opened.body.exam.session_remaining_ms > 89 * 60_000);
  const q = opened.body.current_question;
  assert.equal((await w.call('PUT', path + '/answers', { token, body: { answers: { [q.id]: 'a' } } })).status, 200);
  const before = await w.store.list('responses', { assessment_id: booking.assessment_id }); assert.equal(before.length, 1);
  await windowAt(w, link, booking.assessment_id, Date.now() - EXAM_SESSION_MS);
  const expired = await w.call('GET', path, { token });
  assert.equal(expired.status, 200); assert.equal(expired.body.assessment.status, 'submitted');
  assert.equal(expired.body.assessment.exam_expired, true); assert.equal(expired.body.current_question, null);
  assert.equal(expired.body.exam.session_remaining_ms, 0);
  for (const [method, suffix, body] of [['PUT', '/answers', { answers: { [q.id]: 'b' } }], ['POST', '/next', { answer: 'b' }],
    ['POST', '/phase', { phase: 'answer' }], ['POST', '/submit', { answers: { [q.id]: 'b' } }]])
    assert.equal((await w.call(method, path + suffix, { token, body })).status, 409);
  assert.deepEqual(await w.store.list('responses', { assessment_id: booking.assessment_id }), before);
  assert.equal((await w.store.list('audit_log', { entity_id: booking.assessment_id, action: 'assessment_expired' })).length, 1);
});

test('unused booked exams expire without hall entry and exact start/end boundaries are fixed', async (t) => {
  const start = Date.parse('2030-01-01T04:30:00Z');
  const paper = { status: 'assigned', scheduled_at: new Date(start).toISOString(), started_at: '2030-01-01T05:30:00Z' };
  await assert.rejects(assertExamAccess({}, paper, start - 1), /opens on/);
  await assert.doesNotReject(assertExamAccess({}, paper, start));
  assert.equal(examDeadline(paper), start + EXAM_SESSION_MS);
  assert.equal(examHasExpired(paper, start + EXAM_SESSION_MS - 1), false);
  assert.equal(examHasExpired(paper, start + EXAM_SESSION_MS), true);
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w); await book(w, link);
  const booking = await w.store.get('test_bookings', link.id);
  await windowAt(w, link, booking.assessment_id, Date.now() - EXAM_SESSION_MS - 1000);
  const token = await w.login(values(w, link).email, PASSWORD);
  const list = await w.call('GET', '/candidate/assessments', { token });
  assert.equal(list.body.assessments[0].status, 'submitted'); assert.equal(list.body.assessments[0].exam_expired, true);
  assert.equal((await w.store.get('assessments', booking.assessment_id)).started_at, undefined);
  assert.equal((await w.call('GET', '/admin/dashboard', { token: w.tok })).body.counts.upcoming_tests, 0);
});

test('public dropdown offers only runnable exams and rejects unavailable tracks, duplicate emails and invalid credentials before consuming the link', async (t) => {
  const w = await makeWorld({ t }); const link = await invitation(w, false);
  await w.store.insert('roles', { name: 'Empty track', key: 'empty-booked-track', active: true });
  const lookup = await w.call('POST', '/public/test-bookings/lookup', { body: { token: link.token } });
  assert.deepEqual(lookup.body.exams.map((r) => r.id), [w.role.id]);
  assert.ok(!JSON.stringify(lookup.body).includes('correct_option_ids'));
  for (const patch of [{ role_id: '' }, { role_id: 'unavailable' }, { password: 'short', confirm_password: 'short' }, { confirm_password: 'different-password' }]) {
    assert.equal((await book(w, link, patch)).status, 422);
    assert.equal((await w.store.get('test_bookings', link.id)).status, 'pending');
  }
  const first = await book(w, link); assert.equal(first.status, 200);
  const second = await invitation(w);
  assert.equal((await book(w, second, { email: values(w, link).email.toUpperCase() })).status, 409);
  assert.equal((await w.store.get('test_bookings', second.id)).status, 'pending');
});

test('account and assessment write failures recover exactly once without resetting credentials, paper or schedule', async (t) => {
  for (const failedTable of ['users', 'assessments']) {
    const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w);
    const insert = w.store.insert.bind(w.store); let fail = true;
    w.store.insert = async (table, values) => {
      const row = await insert(table, values);
      if (table === failedTable && fail) { fail = false; throw new Error(`lost ${failedTable} acknowledgement`); }
      return row;
    };
    assert.equal((await book(w, link)).status, 500);
    const saved = await w.store.get('test_bookings', link.id);
    assert.ok(saved.provisioning_json.password_hash); assert.ok(!JSON.stringify(saved).includes(PASSWORD));
    assert.equal((await book(w, link, { password: 'Other-password-2026', confirm_password: 'Other-password-2026' })).status, 409);
    const recovered = await book(w, link); assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    for (const table of ['candidates', 'users', 'assessments']) assert.equal((await w.store.list(table, { booking_id: link.id })).length, 1);
    assert.equal(recovered.body.scheduled_at, saved.scheduled_at); assert.equal(recovered.body.scheduled_end_at, saved.scheduled_end_at);
    assert.equal((await w.store.get('test_bookings', link.id)).provisioning_json, null);
  }
});

test('cancellation revokes exam access for an already signed-in candidate and never reopens a consumed invitation', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w); await book(w, link);
  const booking = await w.store.get('test_bookings', link.id); const token = await w.login(values(w, link).email, PASSWORD);
  await windowAt(w, link, booking.assessment_id, Date.now() - 1000);
  await w.call('POST', `/admin/test-bookings/${link.id}/cancel`, { token: w.tok });
  const result = await w.call('GET', `/candidate/assessments/${booking.assessment_id}`, { token });
  assert.equal(result.status, 409); assert.match(result.body.error, /cancelled/);
  assert.equal((await w.call('GET', '/candidate/assessments', { token })).body.assessments[0].access_state, 'cancelled');
  assert.equal((await w.call('POST', '/public/test-bookings/lookup', { body: { token: link.token } })).status, 409);
});

test('an interrupted registration reserves its email until recovery or cancellation', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 });
  const first = await invitation(w), second = await invitation(w);
  const email = 'reserved.booking@example.com';
  const insert = w.store.insert.bind(w.store); let fail = true;
  w.store.insert = async (table, values) => {
    if (table === 'candidates' && fail) { fail = false; throw new Error('candidate store temporarily unavailable'); }
    return insert(table, values);
  };
  assert.equal((await book(w, first, { email })).status, 500);
  const duplicate = await book(w, second, { email: email.toUpperCase() });
  assert.equal(duplicate.status, 409, 'a second invitation must not take the interrupted booking identity');
  assert.equal((await w.store.get('test_bookings', second.id)).status, 'pending');
  assert.equal((await book(w, first, { email })).status, 200);
  for (const table of ['candidates', 'users', 'assessments'])
    assert.equal((await w.store.list(table, { booking_id: first.id })).length, 1);
  assert.equal((await w.store.list('users', { email })).length, 1);

  const cancelled = await invitation(w), replacement = await invitation(w);
  fail = true;
  const otherEmail = 'cancelled.pending@example.com';
  assert.equal((await book(w, cancelled, { email: otherEmail })).status, 500);
  assert.equal((await w.call('POST', `/admin/test-bookings/${cancelled.id}/cancel`, { token: w.tok })).status, 200);
  assert.equal((await book(w, replacement, { email: otherEmail })).status, 200, 'cancelling an unprovisioned booking releases its email');
});

test('a review timeout arriving across the booking deadline cannot open another answer window', async (t) => {
  const w = await makeWorld({ t, mcq: 0, open: 1 }); const link = await invitation(w);
  assert.equal((await book(w, link)).status, 200);
  const booking = await w.store.get('test_bookings', link.id);
  const token = await w.login(values(w, link).email, PASSWORD);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  await windowAt(w, link, booking.assessment_id, now - EXAM_SESSION_MS + 10_000);
  const base = `/candidate/assessments/${booking.assessment_id}`;
  const opened = await w.call('GET', base, { token });
  assert.equal(opened.body.exam.phase, 'review');
  const paper = await w.store.get('assessments', booking.assessment_id);
  await w.store.update('assessments', paper.id, { quiz_state: { ...paper.quiz_state, question_started_at: new Date(now - 31_000).toISOString() } });
  const changeRow = w.store.changeRow.bind(w.store); let delay = true;
  w.store.changeRow = async (table, key, decide) => {
    if (table === 'assessments' && delay) { delay = false; t.mock.timers.tick(10_001); }
    return changeRow(table, key, decide);
  };
  const result = await w.call('POST', `${base}/next`, { token, body: { question_id: opened.body.current_question.id } });
  assert.equal(result.status, 409);
  const closed = await w.store.get('assessments', paper.id);
  assert.equal(closed.status, 'submitted');
  assert.equal(closed.quiz_state.phase, 'review', 'expiry must not start a new answer phase');
  assert.equal((await w.store.list('responses', { assessment_id: paper.id })).length, 0);
});

test('an unrecovered booking remains visible and cancellable without breaking the admin dashboard', async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await invitation(w);
  const insert = w.store.insert.bind(w.store);
  w.store.insert = async (table, values) => {
    if (table === 'candidates') throw new Error('ongoing profile storage failure');
    return insert(table, values);
  };
  assert.equal((await book(w, link)).status, 500);
  const dashboard = await w.call('GET', '/admin/dashboard', { token: w.tok });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.counts.upcoming_tests, 1);
  assert.equal(dashboard.body.upcoming_tests[0].provisioning_pending, true);
  const list = await w.call('GET', '/admin/test-bookings', { token: w.tok });
  assert.equal(list.status, 200); assert.equal(list.body.bookings[0].provisioning_pending, true);
  assert.ok(!JSON.stringify(list.body).includes('password_hash'));
  w.store.insert = insert;
  const recovered = await w.call('GET', '/admin/test-bookings', { token: w.tok });
  assert.equal(recovered.body.bookings[0].provisioning_pending, false);
  assert.equal((await book(w, link)).status, 200);
});
