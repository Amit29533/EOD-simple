import { createHash } from 'node:crypto';
import { newToken } from '../../core/ids.mjs';
import { emailShapeProblem } from '../../core/candidate-import.mjs';
import { hashPasswordAsync, verifyPasswordAsync } from '../../core/passwords.mjs';
import { createGate } from '../../core/gate.mjs';
import { ok, created, bad, notFound, conflict, unprocessable, tooMany, audit } from '../helpers.mjs';
import { withLock } from '../mutex.mjs';
import { roleBank, automaticSnapshotFromBank, paperSummary, advanceStage, resolveAllocationAssessor } from '../assessment-service.mjs';
import { EXAM_SESSION_MS, expireExam } from '../exam-expiry.mjs';

const TABLE = 'test_bookings';
const A = ['admin'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const available = (row) => row?.status === 'pending' && Date.parse(row.expires_at) > Date.now();
const passwordGate = createGate({ concurrency: 2, maxWaiting: 20 });
const provisioningError = (message) => Object.assign(new Error(message), { code: 'STORE_CONFLICT' });
const withBooking = (id, fn) => withLock('users:create', () => withLock(`booking:${id}`, fn));

// Calendar inputs are explicitly IST, independent of the server/browser timezone.
export function bookingInput(body, now = Date.now()) {
  for (const [key, max] of [['name', 120], ['email', 100], ['phone', 60]]) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > max)
      return { error: `${key === 'name' ? 'Name' : key === 'email' ? 'Email' : 'Phone number'} is required (up to ${max} characters).` };
  }
  const name = body.name.trim(), email = body.email.trim().toLowerCase(), phone = body.phone.trim();
  const emailError = emailShapeProblem(email);
  if (emailError) return { error: emailError };
  if (!/^\+?[\d\s().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15)
    return { error: 'Enter a valid phone number with 7 to 15 digits.' };
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
    || typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time))
    return { error: 'Choose a valid test date and time in IST.' };
  const scheduled = Date.parse(`${body.date}T${body.time}:00+05:30`);
  if (!Number.isFinite(scheduled) || new Date(scheduled + 330 * 60_000).toISOString().slice(0, 16) !== `${body.date}T${body.time}`)
    return { error: 'Choose a valid calendar date.' };
  if (scheduled <= now) return { error: 'The test slot must be in the future.' };
  return { value: { name, email, phone, scheduled_at: new Date(scheduled).toISOString(), timezone: 'Asia/Kolkata' } };
}

async function changeBooking(store, id, decide) {
  if (typeof store.changeRow === 'function') return store.changeRow(TABLE, { id }, decide);
  // Airtable has no cross-instance conditional-write primitive. The local
  // deployment uses JSON; Blobs also re-evaluates this decision on CAS retries.
  const row = await store.get(TABLE, id);
  const patch = decide(row, await store.list(TABLE));
  return patch ? { row: await store.update(TABLE, id, patch), changed: true } : { row, changed: false };
}

// The identity check and slot claim share the same whole-table CAS. Checking
// only before the write allows two Lambda instances to consume different
// invitations for the same email, stranding one after deterministic user IDs
// correctly reject the duplicate account.
export function bookingCommitPatch(current, rows, values) {
  if (!available(current) || rows.some((b) => b.id !== current.id && b.status === 'booked'
    && b.automation_version && String(b.email || '').trim().toLowerCase() === values.email)) return undefined;
  return values;
}

async function findLink(store, token) {
  if (!validToken(token)) return null;
  return (await store.list(TABLE, { token_hash: digest(token) }))[0] || null;
}

// Repairable materialization: the slot is committed once before a candidate
// is created. A failed response/retry never creates another booking/profile.
async function ensureCandidate(store, row) {
  row = await store.get(TABLE, row.id);
  if (!row) return null;
  if (row.status !== 'booked' || row.candidate_id) return row;
  const existing = (await store.list('candidates', { booking_id: row.id }))[0];
  let candidate = existing;
  if (!candidate) {
    try {
      candidate = await store.insert('candidates', {
        id: `booking-${row.id}`, booking_id: row.id,
        name: row.name, email: row.email, phone: row.phone,
        source: 'Test booking link', stage: 'intake', target_role_id: row.role_id || null,
        created_by: row.created_by,
      });
    } catch (err) {
      if (err?.code !== 'DUPLICATE_ID') throw err;
      candidate = (await store.list('candidates', { booking_id: row.id }))[0];
      if (!candidate) throw err;
    }
  }
  return (await changeBooking(store, row.id, (current) => current?.status === 'booked' && !current.candidate_id
    ? { candidate_id: candidate.id } : undefined)).row;
}

async function insertBookingRecord(store, table, id, bookingId, values) {
  let row = await store.get(table, id);
  // Airtable generates its own record IDs; the persisted booking marker is
  // also the recovery key there. JSON/Blobs enforce deterministic IDs.
  if (!row) row = (await store.list(table, { booking_id: bookingId }))[0];
  if (!row) {
    try { row = await store.insert(table, { id, booking_id: bookingId, ...values }); }
    catch (err) {
      if (err?.code !== 'DUPLICATE_ID') throw err;
      row = await store.get(table, id);
      if (!row) throw err;
    }
  }
  if (row.booking_id !== bookingId) throw provisioningError('The booking identity is already in use.');
  return row;
}

async function provisionBooking(store, original) {
  let row = await ensureCandidate(store, original);
  if (!row || row.status !== 'booked' || !row.automation_version) return row;
  if (row.user_id && row.assessment_id && !row.provisioning_json) return row;
  const candidate = await store.get('candidates', row.candidate_id);
  if (!candidate || candidate.deleting) throw provisioningError('The booked candidate is unavailable.');
  const plan = row.provisioning_json;
  if (!plan?.password_hash || !plan?.snapshot) throw provisioningError('Booking provisioning needs administrator recovery.');
  const user = await insertBookingRecord(store, 'users', `booking-user-${digest(row.email)}`, row.id, {
    username: `candidate-${row.id}`, name: row.name, email: row.email, role: 'candidate',
    password_hash: plan.password_hash, candidate_id: candidate.id, active: true, created_by: row.created_by,
  });
  if (user.candidate_id !== candidate.id || user.role !== 'candidate' || user.active === false)
    throw provisioningError('The linked booking account is unavailable.');
  const role = await store.get('roles', row.role_id);
  const assessor_id = await resolveAllocationAssessor(store, role, candidate);
  const assessment = await insertBookingRecord(store, 'assessments', `booking-exam-${row.id}`, row.id, {
    candidate_id: candidate.id, role_id: row.role_id, assessor_id,
    status: 'assigned', snapshot_json: plan.snapshot, report_json: null,
    ...paperSummary(plan.snapshot), scheduled_at: row.scheduled_at, scheduled_end_at: row.scheduled_end_at,
    overall_pct: null, readiness_key: '', readiness_label: '', created_by: row.created_by,
  });
  // Use the persisted paper on repair: a retry must not undo a reassignment.
  if (!candidate.assessor_id && assessment.assessor_id)
    await store.update('candidates', candidate.id, { assessor_id: assessment.assessor_id });
  await advanceStage(store, candidate.id, 'assessment');
  row = (await changeBooking(store, row.id, (fresh) => fresh?.status === 'booked'
    ? { user_id: user.id, assessment_id: assessment.id, provisioning_json: null } : undefined)).row;
  return row;
}

async function bookableExams(store, invitation) {
  const roles = (await store.list('roles')).filter((role) => role.active !== false
    && (!invitation.role_id || invitation.role_id === role.id));
  const exams = [];
  for (const role of roles) {
    const bank = await roleBank(store, role.id);
    const snapshot = bank && automaticSnapshotFromBank(bank);
    if (snapshot?.questions.length) exams.push({ id: role.id, name: role.name, question_count: snapshot.questions.length });
  }
  return exams;
}

function bookingReceipt(row) {
  return { booked: true, scheduled_at: row.scheduled_at, scheduled_end_at: row.scheduled_end_at,
    timezone: 'Asia/Kolkata', username: `candidate-${row.id}`, email: row.email,
    exam_path: `#/assessments/${encodeURIComponent(row.assessment_id)}/quiz` };
}

export function bookingForAdmin(row, assessmentStatus = '') {
  return {
    id: row.id, label: row.label || '', role_id: row.role_id || null, role_name: row.role_name || '',
    status: row.status === 'pending' && !available(row) ? 'expired' : row.status,
    created_at: row.created_at, expires_at: row.expires_at, booked_at: row.booked_at || null,
    candidate_id: row.candidate_id || null, name: row.name || '', email: row.email || '', phone: row.phone || '',
    scheduled_at: row.scheduled_at || null, timezone: 'Asia/Kolkata',
    scheduled_end_at: row.scheduled_end_at || null, user_id: row.user_id || null,
    assessment_id: row.assessment_id || null,
    assessment_status: assessmentStatus,
    provisioning_pending: Boolean(row.automation_version && (!row.candidate_id || !row.user_id || !row.assessment_id || row.provisioning_json)),
  };
}

export async function listBookings(store) {
  const rows = await store.list(TABLE);
  const result = [];
  for (const row of rows) {
    const needsRepair = !row.candidate_id || (row.automation_version && (!row.user_id || !row.assessment_id || row.provisioning_json));
    let repaired = row;
    if (row.status === 'booked' && needsRepair) {
      try { repaired = await withBooking(row.id, () => provisionBooking(store, row)); }
      catch {
        // Keep the admin's recovery/cancellation controls available while a
        // particular signup cannot finish. A later list/request retries it.
        console.warn(`[bookings] Setup pending for ${row.id}; repair will retry on the next access.`);
        repaired = await store.get(TABLE, row.id);
      }
    }
    result.push(repaired || row);
  }
  const assessments = result.some((row) => row.assessment_id)
    ? await store.list('assessments', {}, { detached: false }) : [];
  const statusById = new Map(assessments.map((a) => [a.id, a.status]));
  return result.map((row) => bookingForAdmin(row, row.assessment_id ? statusById.get(row.assessment_id) || 'unavailable' : ''))
    .sort((a, b) => String(a.scheduled_at || a.created_at).localeCompare(String(b.scheduled_at || b.created_at)));
}

export function bookingHandlers(route) {
  route('POST', '/admin/test-bookings/links', A, async ({ store, body, auth }) => {
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 120)) return bad('Link label must be text, up to 120 characters.');
    if (body.role_id !== undefined && body.role_id !== null && typeof body.role_id !== 'string') return bad('Select a valid assessment track.');
    const role = body.role_id ? await store.get('roles', body.role_id) : null;
    if (body.role_id && (!role || role.active === false)) return bad('The selected assessment track is unavailable.');
    const token = newToken();
    const row = await store.insert(TABLE, {
      token_hash: digest(token), label: (body.label || '').trim(), status: 'pending',
      role_id: role?.id || null, role_name: role?.name || '', created_by: auth.user.id,
      expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
    await audit(store, auth.user, 'test_booking_link_created', TABLE, row.id, 'Single-use test booking link created.');
    return created({ invitation: bookingForAdmin(row), path: `#/book/${token}` });
  });
  route('GET', '/admin/test-bookings', A, async ({ store }) => ok({ bookings: await listBookings(store) }));
  route('POST', '/admin/test-bookings/:id/cancel', A, async ({ store, params, auth }) => withBooking(params.id, async () => {
    const result = await changeBooking(store, params.id, (row) => row && ['pending', 'booked'].includes(row.status)
      ? { status: row.status === 'pending' ? 'revoked' : 'cancelled', provisioning_json: null } : undefined);
    if (!result.row) return notFound('Booking link not found.');
    if (result.row.status === 'cancelled' && result.row.assessment_id)
      await withLock(`assessment:${result.row.assessment_id}`, async () => {
        await expireExam(store, await store.get('assessments', result.row.assessment_id));
      });
    if (result.changed) await audit(store, auth.user, 'test_booking_cancelled', TABLE, params.id, 'Test booking or unused link cancelled.');
    return ok({ booking: bookingForAdmin(result.row) });
  }));
  // Tokens live in the URL fragment and POST body, never query strings/paths.
  route('POST', '/public/test-bookings/lookup', 'public', async ({ store, body }) => {
    const row = await findLink(store, body.token);
    if (!row) return notFound('This booking link is invalid. Contact your ECOD administrator.');
    if (!available(row)) return conflict('This booking link has already been used, expired or been cancelled. Contact your ECOD administrator.');
    return ok({ role_name: row.role_name || '', timezone: 'Asia/Kolkata', expires_at: row.expires_at,
      exams: await bookableExams(store, row) });
  });
  route('POST', '/public/test-bookings', 'public', async ({ store, body }) => {
    const row = await findLink(store, body.token);
    if (!row) return notFound('This booking link is invalid.');
    if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(body.request_id)) return bad('A valid submission identifier is required.');
    return withBooking(row.id, async () => {
      const current = await store.get(TABLE, row.id);
      // A lost success acknowledgement can be retried by the original form.
      const replay = current?.status === 'booked' && current.request_id === body.request_id;
      if (!replay && !available(current)) return conflict('This booking link is no longer available. It can only be submitted once.');
      const checked = bookingInput(body, replay ? 0 : Date.now());
      if (checked.error) return unprocessable(checked.error);
      if (typeof body.role_id !== 'string' || !body.role_id) return unprocessable('Choose a target exam.');
      if (current.role_id && body.role_id !== current.role_id) return unprocessable('Choose the exam offered by this invitation.');
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 200)
        return unprocessable('Password must contain 12 to 200 characters.');
      if (body.confirm_password !== body.password) return unprocessable('Passwords do not match.');
      checked.value.role_id = body.role_id;
      const signature = digest(JSON.stringify(checked.value));
      if (replay && current.submission_hash !== signature) return conflict('This link has already been submitted with different details.');
      let plan = null;
      try {
        if (replay) {
          const user = current.user_id ? await store.get('users', current.user_id)
            : (await store.list('users', { booking_id: current.id }))[0];
          if (!await passwordGate.run(() => verifyPasswordAsync(body.password, current.provisioning_json?.password_hash || user?.password_hash)))
            return conflict('This booking was submitted with different credentials.');
        } else {
          const users = await store.list('users');
          if (users.some((u) => String(u.email || '').trim().toLowerCase() === checked.value.email || u.username === checked.value.email))
            return conflict('An account already uses this email. Contact your administrator to schedule an existing account.');
          // The booking commits before its account is materialized. Reserve
          // that identity across storage failures so a second invitation
          // cannot take it while the original submission awaits recovery.
          const bookings = await store.list(TABLE);
          if (bookings.some((b) => b.id !== current.id && b.status === 'booked' && b.automation_version
            && String(b.email || '').trim().toLowerCase() === checked.value.email))
            return conflict('This email already has a test booking. Retry the original submission or contact your administrator.');
          const bank = await roleBank(store, body.role_id);
          const snapshot = bank && automaticSnapshotFromBank(bank);
          if (!snapshot?.questions.length) return unprocessable('This exam is currently unavailable. Select another exam or contact your administrator.');
          checked.value.role_name = bank.role.name;
          plan = { password_hash: await passwordGate.run(() => hashPasswordAsync(body.password)), snapshot };
        }
      } catch (err) {
        if (err?.code === 'GATE_FULL') return tooMany('Registration is busy. Please try again shortly.');
        throw err;
      }
      const values = { ...checked.value, scheduled_end_at: new Date(Date.parse(checked.value.scheduled_at) + EXAM_SESSION_MS).toISOString(),
          automation_version: '1', provisioning_json: plan,
          status: 'booked', booked_at: new Date().toISOString(), request_id: body.request_id, submission_hash: signature };
      const result = replay ? { row: current } : await changeBooking(store, row.id,
        (fresh, rows) => bookingCommitPatch(fresh, rows, values));
      if (!replay && !result.changed) return conflict(result.row?.status === 'pending'
        ? 'This email already has a test booking. Use the original invitation or contact your administrator.'
        : 'This booking link has already been submitted or cancelled.');
      const provisioned = await provisionBooking(store, result.row);
      if (!provisioned?.user_id || !provisioned?.assessment_id) throw provisioningError('Booking setup did not finish. Retry the same submission.');
      if (!replay) await audit(store, null, 'test_slot_booked', TABLE, row.id, 'Candidate booked a test slot.');
      return ok(bookingReceipt(provisioned));
    });
  });
}
