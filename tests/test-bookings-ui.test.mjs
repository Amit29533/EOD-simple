import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush, type } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

const future = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
async function createLink(w) {
  const result = await w.call('POST', '/admin/test-bookings/links', { token: w.tok, body: { role_id: w.role.id } });
  assert.equal(result.status, 201);
  return { ...result.body, token: result.body.path.split('/').at(-1) };
}
function fill(spa) {
  const form = spa.view.querySelector('#test-booking-form');
  for (const [name, value] of Object.entries({ name: 'UI Booking', email: 'uibooking@example.com', phone: '+91 9876543210', role_id: form.elements.role_id.options[1].value, password: 'Booking-password-2026', confirm_password: 'Booking-password-2026', date: future(), time: '14:30' })) type(form.elements[name], value);
  return form;
}

test('public booking route opens without sign-in and a submitted slot appears on the main dashboard', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t }); const link = await createLink(w);
  const spa = await bootSpa({ hash: link.path, backend: { app: w.app, token: w.tok } });
  try {
    assert.ok(spa.view.querySelector('#test-booking-form'), spa.text());
    assert.equal(spa.callsTo('/auth/me').length, 0, 'public route does not restore an admin/candidate session');
    assert.equal(spa.document.querySelector('#sidebar').textContent, '');
    assert.match(spa.text(), /India Standard Time/);
    const form = fill(spa);
    await form.onsubmit(new spa.window.Event('submit', { cancelable: true }));
    assert.match(spa.text(), /Test slot booked/);
    assert.match(spa.text(), /2:30 pm IST/i);
    const { dashboardView } = await import('../public/js/views/admin.js');
    await dashboardView(spa.view);
    const panel = spa.view.querySelector('#upcoming-tests');
    assert.match(panel.textContent, /Upcoming tests \(1\)/);
    assert.match(panel.textContent, /UI Booking/);
    assert.match(panel.textContent, /uibooking@example.com/);
    assert.ok(panel.querySelector('a[href^="#/candidates/"]'));
    const { publicBookingView } = await import('../public/js/views/bookings.js');
    await publicBookingView(spa.view, link.token);
    assert.equal(spa.view.querySelector('form'), null);
    assert.match(spa.text(), /Booking unavailable/);
    assert.ok(!spa.text().includes('uibooking@example.com'), 'used-link lookup exposes no previous candidate data');
  } finally { spa.teardown(); }
});

test('public form retains details on failure and retries with the same submission identifier', { skip: SKIP }, async () => {
  let fail = true; const submissions = [];
  const spa = await bootSpa({ routes: (method, path, body) => {
    if (path.endsWith('/lookup')) return { role_name: 'RSA', exams: [{ id: 'rsa', name: 'RSA', question_count: 50 }] };
    if (path === '/public/test-bookings') {
      submissions.push(body);
      return fail ? { status: 503, body: { error: 'Temporary storage failure' } } : { booked: true, scheduled_at: `${future()}T09:00:00Z`, scheduled_end_at: `${future()}T11:00:00Z`, email: 'uibooking@example.com', username: 'candidate-demo', exam_path: '#/assessments/demo/quiz' };
    }
  } });
  try {
    const { publicBookingView } = await import('../public/js/views/bookings.js');
    await publicBookingView(spa.view, 'a'.repeat(64));
    const form = fill(spa);
    await form.onsubmit(new spa.window.Event('submit', { cancelable: true }));
    assert.match(spa.view.querySelector('#booking-error').textContent, /Temporary storage/);
    assert.equal(form.elements.name.value, 'UI Booking');
    assert.equal(form.querySelector('button').disabled, false);
    fail = false;
    await form.onsubmit(new spa.window.Event('submit', { cancelable: true }));
    assert.equal(submissions[0].request_id, submissions[1].request_id);
    assert.match(spa.text(), /Test slot booked/);
  } finally { spa.teardown(); }
});

test('admin creates a copyable link, sees it pending, then revokes it through the booking page', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const spa = await bootSpa({ backend: { app: w.app, token: w.tok } });
  try {
    const { bookingsView } = await import('../public/js/views/bookings.js');
    await bookingsView(spa.view);
    spa.view.querySelector('#create-booking-link').click(); await flush(60);
    const form = spa.document.querySelector('#fm-form');
    assert.ok(form);
    type(form.elements.label, 'Candidate invitation'); type(form.elements.role_id, w.role.id);
    spa.document.querySelector('.m-foot .btn:last-child').click(); await flush(120);
    const link = spa.document.querySelector('#booking-link');
    assert.ok(link, spa.document.querySelector('#modal-root').textContent);
    assert.match(link.value, /^http:\/\/localhost:3000\/#\/book\/[a-f0-9]{64}$/);
    assert.match(spa.text(), /pending/);
    const done = [...spa.document.querySelectorAll('.m-foot button')].find((b) => b.textContent === 'Done');
    done.click();
    spa.view.querySelector('[data-cancel-booking]').click(); await flush(30);
    const confirm = [...spa.document.querySelectorAll('.m-foot button')].find((b) => b.textContent === 'Cancel booking');
    assert.ok(confirm); confirm.click(); await flush(100);
    assert.match(spa.text(), /revoked/);
    assert.equal(spa.view.querySelector('[data-cancel-booking]'), null);
  } finally { spa.teardown(); }
});

test('booked candidate sees the scheduled window, cannot enter early, and receives slot-based rules when it opens', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t, mcq: 2, open: 0 }); const link = await createLink(w);
  const result = await w.call('POST', '/public/test-bookings', { body: {
    token: link.token, name: 'Scheduled UI Candidate', email: 'scheduled.ui@example.com', phone: '+919876543210',
    date: future(), time: '10:00', role_id: w.role.id, password: 'Scheduled-password-2026', confirm_password: 'Scheduled-password-2026', request_id: 'scheduled-ui-request-123456',
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const booking = await w.store.get('test_bookings', link.invitation.id);
  const token = await w.login('scheduled.ui@example.com', 'Scheduled-password-2026');
  const spa = await bootSpa({ hash: '#/journey', backend: { app: w.app, token }, stubTimers: true });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    await candidate.portalView(spa.view);
    assert.equal(spa.view.querySelector('a[href$="/quiz"]'), null);
    assert.ok([...spa.view.querySelectorAll('button')].some((b) => b.textContent === 'Not open yet' && b.disabled));
    spa.window.location.hash = `#/assessments/${booking.assessment_id}/quiz`;
    await candidate.quizView(spa.view, { id: booking.assessment_id });
    assert.match(spa.text(), /Your exam is scheduled/);
    assert.equal(spa.callsTo(`/candidate/assessments/${booking.assessment_id}`, 'GET').length, 0, 'future gate never fetches the exam');
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.parse(start) + 2 * 60 * 60 * 1000).toISOString();
    await w.store.update('assessments', booking.assessment_id, { scheduled_at: start, scheduled_end_at: end });
    await candidate.quizView(spa.view, { id: booking.assessment_id });
    assert.match(spa.text(), /Your booked window is/);
    assert.match(spa.text(), /Joining late does not extend/);
    assert.ok(!spa.text().includes('It starts when you enter the exam hall'));
    assert.equal(spa.view.querySelector('#exam-enter').disabled, true, 'existing exam acknowledgement still applies');
  } finally { spa.teardown(); }
});
