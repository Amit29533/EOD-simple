import { api, newRequestId } from '../api.js';
import { esc, dataTable, loading, emptyState, formModal, modal, toast, confirmModal, fmtScheduledTime } from '../ui.js';

export const bookingTime = fmtScheduledTime;
const finishedExam = (booking) => ['submitted', 'scored', 'validated', 'cancelled', 'unavailable'].includes(booking.assessment_status);

export function bookingTable(rows, actions = false) {
  if (!rows.length) return emptyState('No upcoming tests', 'Create a booking link and send it to a candidate.');
  return dataTable([
    { label: 'Candidate', render: (b) => `<b>${esc(b.name)}</b><div class="small muted">${esc(b.email)}</div><div class="small">${esc(b.phone)}</div>` },
    { label: 'Test window (IST)', render: (b) => `${esc(bookingTime(b.scheduled_at))}${b.scheduled_end_at ? `<div class="small muted">Closes ${esc(bookingTime(b.scheduled_end_at))}</div>` : ''}` },
    { label: 'Assessment track', render: (b) => esc(b.role_name || 'To be assigned') },
    { label: 'Status', render: (b) => b.status === 'cancelled' || b.assessment_status === 'cancelled' ? 'Cancelled'
      : b.assessment_status === 'submitted' ? 'Under review' : b.assessment_status === 'scored' ? 'Scored'
        : b.assessment_status === 'validated' ? 'Validated' : b.assessment_status === 'unavailable' ? 'Exam unavailable' : b.provisioning_pending ? 'Setup pending'
      : Date.parse(b.scheduled_end_at || b.scheduled_at) <= Date.now() ? 'Expired' : Date.parse(b.scheduled_at) <= Date.now() ? 'Open now' : 'Upcoming' },
    { label: '', render: (b) => `${b.candidate_id ? `<a class="btn ghost sm" href="#/candidates/${encodeURIComponent(b.candidate_id)}">Open candidate</a>` : '<span class="muted small">Profile pending</span>'}${actions && b.status === 'booked' && !finishedExam(b) ? `<button class="btn ghost sm" data-cancel-booking="${esc(b.id)}">Cancel slot</button>` : ''}` },
  ], rows);
}

export async function createBookingLink(onCreated = () => {}) {
  try {
    const { roles = [] } = await api('/admin/roles');
    const saved = await formModal({
      title: 'Create a single-use booking link', submitLabel: 'Create link',
      intro: 'Copy the generated link into your own email. One candidate can submit it once. Unused links expire after 30 days.',
      fields: [
        { name: 'label', label: 'Internal label (optional)', placeholder: 'e.g. October interview invitation' },
        { name: 'role_id', label: 'Assessment track (optional)', type: 'select', help: 'Leave blank to let the candidate choose any available exam. Select a track to restrict this invitation to that exam.', options: roles.filter((r) => r.active !== false).map((r) => ({ value: r.id, label: r.name })) },
      ],
      onSubmit: (body) => api('/admin/test-bookings/links', { method: 'POST', body }),
    });
    if (!saved) return;
    const url = new URL(location.pathname + saved.path, location.origin).href;
    modal({
      title: 'Booking link ready',
      bodyHtml: `<p>Copy this link and send it to one candidate. Save it before closing this dialog; it is shown only here.</p>
        <label class="f"><span class="lbl">Candidate booking link</span><input id="booking-link" type="text" readonly value="${esc(url)}" /></label>
        <p class="small muted">Valid until ${esc(bookingTime(saved.invitation.expires_at))}. Each link accepts one booking.</p>
        ${['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? '<p class="small muted">This local link works on this computer. External candidates will need a reachable ECOD address when the feature is published.</p>' : ''}`,
      actions: [
        { label: 'Copy link', onClick: async (_close, button) => {
          try { await navigator.clipboard.writeText(url); button.textContent = 'Copied'; }
          catch { const input = document.getElementById('booking-link'); input?.focus(); input?.select(); toast('Select and copy the link above.', 'info'); }
        } },
        { label: 'Done' },
      ],
    });
    await onCreated();
  } catch (err) { toast(err.message || 'Could not create a booking link.', 'error'); }
}

export async function bookingsView(view) {
  view.innerHTML = loading();
  const { bookings = [] } = await api('/admin/test-bookings');
  const slots = bookings.filter((b) => b.scheduled_at);
  const upcoming = slots.filter((b) => b.status === 'booked' && !finishedExam(b) && Date.parse(b.scheduled_end_at || b.scheduled_at) > Date.now());
  const history = slots.filter((b) => !upcoming.includes(b)).reverse();
  const links = bookings.filter((b) => !b.scheduled_at).reverse();
  view.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Candidate scheduling</div><h1>Test bookings</h1>
      <p>Create a link, email it manually, and see the candidate's chosen slot here. All times are IST.</p></div>
      <div class="heading-actions"><button class="btn" id="create-booking-link">＋ Create booking link</button></div></div>
    <div class="card"><div class="panel-head"><div><h2>Upcoming tests (${upcoming.length})</h2><p>New bookings automatically create the candidate, login and exam. Exam access closes two hours after the booked start.</p></div><a href="#/dashboard">Dashboard →</a></div>${bookingTable(upcoming, true)}</div>
    ${history.length ? `<div class="card"><div class="panel-head"><h2>Completed, past and cancelled slots</h2></div>${bookingTable(history, true)}</div>` : ''}
    <div class="card"><div class="panel-head"><h2>Booking invitations</h2></div>${links.length ? dataTable([
      { label: 'Label', render: (b) => esc(b.label || 'Candidate invitation') },
      { label: 'Track', render: (b) => esc(b.role_name || 'To be assigned') },
      { label: 'Status', render: (b) => esc(b.status) },
      { label: 'Expires (IST)', render: (b) => esc(bookingTime(b.expires_at)) },
      { label: '', render: (b) => b.status === 'pending' ? `<button class="btn ghost sm" data-cancel-booking="${esc(b.id)}">Revoke link</button>` : '' },
    ], links) : '<p class="muted">No unused invitations. Create a separate link for each candidate.</p>'}</div>`;
  view.querySelector('#create-booking-link').onclick = () => createBookingLink(() => bookingsView(view));
  view.querySelectorAll('[data-cancel-booking]').forEach((button) => { button.onclick = async () => {
    if (!await confirmModal('Cancel this slot or invitation?', 'The invitation will remain unusable. For an existing candidate, arrange a replacement attempt from their candidate profile; this invitation cannot be reused.', 'Cancel booking')) return;
    button.disabled = true;
    try { await api(`/admin/test-bookings/${encodeURIComponent(button.dataset.cancelBooking)}/cancel`, { method: 'POST' }); await bookingsView(view); }
    catch (err) { button.disabled = false; toast(err.message, 'error'); }
  }; });
}

export async function publicBookingView(view, token) {
  view.innerHTML = `<div class="booking-public">${loading()}</div>`;
  let invitation;
  try { invitation = await api('/public/test-bookings/lookup', { method: 'POST', body: { token } }); }
  catch (err) {
    view.innerHTML = `<section class="booking-public card"><div class="eyebrow">Anthroprime ECOD</div><h1>Booking unavailable</h1><p role="alert">${esc(err.message)}</p>${![404, 409].includes(err.status) ? '<button class="btn" id="booking-retry">Try again</button>' : '<p class="muted">Please ask your ECOD administrator for a new booking link.</p>'}</section>`;
    const retry = view.querySelector('#booking-retry'); if (retry) retry.onclick = () => publicBookingView(view, token);
    return;
  }
  const requestId = newRequestId();
  const exams = invitation.exams || [];
  if (!exams.length) {
    view.innerHTML = '<section class="booking-public card"><h1>No exams available</h1><p>This invitation currently has no available exam. Please contact your ECOD administrator.</p></section>';
    return;
  }
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  view.innerHTML = `<section class="booking-public card"><div class="eyebrow">Anthroprime ECOD</div><h1>Book your test</h1>
    ${invitation.role_name ? `<p class="booking-track">${esc(invitation.role_name)}</p>` : ''}
    <p>Enter your details and choose your test slot. This invitation accepts one submission.</p>
    <form id="test-booking-form">
      <label class="f"><span class="lbl">Full name</span><input name="name" autocomplete="name" required maxlength="120" /></label>
      <label class="f"><span class="lbl">Email</span><input name="email" type="email" autocomplete="email" required maxlength="100" /><span class="help">Use this email to sign in after booking.</span></label>
      <label class="f"><span class="lbl">Phone number</span><input name="phone" type="tel" autocomplete="tel" required maxlength="60" placeholder="+91 98765 43210" /></label>
      <label class="f"><span class="lbl">Target exam</span><select name="role_id" required><option value="">Choose your exam</option>${exams.map((exam) => `<option value="${esc(exam.id)}" ${exams.length === 1 ? 'selected' : ''}>${esc(exam.name)} (${exam.question_count} questions)</option>`).join('')}</select></label>
      <div class="form-2col"><label class="f"><span class="lbl">Test date</span><input name="date" type="date" min="${today}" required /></label>
        <label class="f"><span class="lbl">Test time (IST)</span><input name="time" type="time" required /></label></div>
      <p class="small muted">India Standard Time (UTC+05:30). Your exam opens at the selected start time and expires exactly two hours later. Joining late gives you less time.</p>
      <p id="booking-window" class="small" aria-live="polite"></p>
      <label class="f"><span class="lbl">Create password</span><input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required /><span class="help">12 to 200 characters. Keep it for signing in to your candidate portal.</span></label>
      <label class="f"><span class="lbl">Confirm password</span><input name="confirm_password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required /></label>
      <p id="booking-error" class="form-err" role="alert" tabindex="-1" hidden></p>
      <button class="btn" type="submit" id="book-test">Confirm test slot</button>
    </form></section>`;
  const form = view.querySelector('#test-booking-form');
  const showWindow = () => {
    const start = Date.parse(`${form.elements.date.value}T${form.elements.time.value}:00+05:30`);
    view.querySelector('#booking-window').textContent = Number.isFinite(start)
      ? `Exam window: ${bookingTime(start)} to ${bookingTime(start + 2 * 60 * 60 * 1000)}.` : '';
  };
  form.elements.date.onchange = showWindow; form.elements.time.onchange = showWindow;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('#book-test');
    if (button.disabled || !form.reportValidity()) return;
    const error = form.querySelector('#booking-error'); error.hidden = true;
    const body = { token, request_id: requestId };
    for (const name of ['name', 'email', 'phone', 'role_id', 'date', 'time', 'password', 'confirm_password']) body[name] = form.elements[name].value;
    if (body.password !== body.confirm_password) {
      error.textContent = 'Passwords do not match.'; error.hidden = false; form.elements.confirm_password.focus(); return;
    }
    button.disabled = true; button.textContent = 'Booking…';
    try {
      const result = await api('/public/test-bookings', { method: 'POST', body });
      const examUrl = new URL(location.pathname + result.exam_path, location.origin).href;
      view.innerHTML = `<section class="booking-public card"><div class="eyebrow">Anthroprime ECOD</div><h1>Test slot booked</h1><p role="status">Your exam opens <b>${esc(bookingTime(result.scheduled_at))}</b> and closes <b>${esc(bookingTime(result.scheduled_end_at))}</b>.</p>
        <p>Your candidate profile, linked login and assessment are ready. Sign in using <b>${esc(result.email)}</b> and the password you just created.</p>
        <p class="small muted">Alternative username: ${esc(result.username)}</p><a class="btn" href="${esc(result.exam_path)}">Sign in to your exam</a>
        <label class="f"><span class="lbl">Save your exam access link</span><input type="text" readonly value="${esc(examUrl)}" /></label>
        <p class="small muted">The booking invitation has now been used. Save the exam link above; it requires your login and only allows the exam during your booked window. You can also sign in to ECOD and open My Journey. Contact your administrator to change the slot.</p></section>`;
    } catch (err) {
      error.textContent = err.message || 'Could not book this slot. Please try again.'; error.hidden = false; error.focus();
      button.disabled = false; button.textContent = 'Confirm test slot';
    }
  };
}
