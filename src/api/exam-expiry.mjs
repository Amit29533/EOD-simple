import { audit } from './helpers.mjs';

export const EXAM_SESSION_MS = 2 * 60 * 60 * 1000;

export function examScheduledStart(a) {
  if (typeof a?.scheduled_at !== 'string' || !a.scheduled_at) return null;
  const start = Date.parse(a.scheduled_at);
  return Number.isFinite(start) ? start : null;
}

/** Absolute wall clock: neither browser storage nor a close beacon controls it. */
export function examDeadline(a) {
  const booked = examScheduledStart(a);
  if (booked !== null) return booked + EXAM_SESSION_MS;
  if (typeof a?.started_at !== 'string' || !a.started_at) return null;
  const start = Date.parse(a.started_at);
  return Number.isFinite(start) ? start + EXAM_SESSION_MS : null;
}

export function examHasExpired(a, now = Date.now()) {
  const deadline = examDeadline(a);
  const canExpire = a?.status === 'in_progress' || (a?.status === 'assigned' && examScheduledStart(a) !== null);
  return canExpire && deadline !== null && now >= deadline;
}

/** Guard every exam operation, including direct API calls before hall entry. */
export async function assertExamAccess(store, assessment, now = Date.now()) {
  if (assessment?.status === 'cancelled')
    throw Object.assign(new Error('This exam booking has been cancelled. Contact your administrator.'), { code: 'EXAM_ACCESS' });
  if (!assessment || !['assigned', 'in_progress'].includes(assessment.status)) return;
  if (assessment.booking_id) {
    const booking = await store.get('test_bookings', assessment.booking_id);
    if (!booking || booking.status !== 'booked')
      throw Object.assign(new Error('This exam booking has been cancelled. Contact your administrator.'), { code: 'EXAM_ACCESS' });
  }
  const start = examScheduledStart(assessment);
  if (assessment.booking_id && start === null)
    throw Object.assign(new Error('The exam schedule is unavailable. Contact your administrator before entering.'), { code: 'EXAM_ACCESS' });
  if (start !== null && now < start) {
    const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(start));
    throw Object.assign(new Error(`This exam opens on ${when} IST and closes two hours later.`), { code: 'EXAM_ACCESS' });
  }
}

/** Materialize expiry on access; the deadline applies even while nobody is online. */
export async function expireExam(store, a) {
  if (!a || !['assigned', 'in_progress'].includes(a.status)) return a;
  // Cancellation wins over the timer. A failed cancellation write can be
  // repaired on access instead of submitting a cancelled exam for scoring.
  const booking = a.booking_id ? await store.get('test_bookings', a.booking_id) : null;
  const cancelled = Boolean(a.booking_id && booking?.status !== 'booked');
  if (!cancelled && !examHasExpired(a)) return a;
  const decide = (current) => {
    if (cancelled && current?.booking_id === a.booking_id && ['assigned', 'in_progress'].includes(current.status))
      return { status: 'cancelled' };
    if (!examHasExpired(current)) return undefined;
    const at = new Date(examDeadline(current)).toISOString();
    return {
      status: 'submitted', submitted_at: at,
      quiz_state: { ...current.quiz_state, exam_expired: true, exam_expired_at: at },
    };
  };
  let result;
  if (typeof store.changeRow === 'function') result = await store.changeRow('assessments', { id: a.id }, decide);
  else {
    const current = await store.get('assessments', a.id);
    const patch = decide(current);
    result = { row: patch ? await store.update('assessments', a.id, patch) : current, changed: Boolean(patch) };
  }
  if (result.changed)
    await audit(store, null, cancelled ? 'assessment_cancelled' : 'assessment_expired', 'assessments', a.id,
      cancelled ? 'Booking cancelled; assessment closed without submission.' : 'Two-hour exam deadline reached; saved answers preserved for review.');
  return result.row ? { ...a, ...result.row, snapshot_json: a.snapshot_json ?? result.row.snapshot_json } : null;
}
