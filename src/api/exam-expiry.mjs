import { audit } from './helpers.mjs';

export const EXAM_SESSION_MS = 2 * 60 * 60 * 1000;

/** Absolute wall clock: neither browser storage nor a close beacon controls it. */
export function examDeadline(a) {
  if (typeof a?.started_at !== 'string' || !a.started_at) return null;
  const start = Date.parse(a.started_at);
  return Number.isFinite(start) ? start + EXAM_SESSION_MS : null;
}

export function examHasExpired(a, now = Date.now()) {
  const deadline = examDeadline(a);
  return a?.status === 'in_progress' && deadline !== null && now >= deadline;
}

/** Materialize expiry on access; the deadline applies even while nobody is online. */
export async function expireExam(store, a) {
  if (!examHasExpired(a)) return a;
  const decide = (current) => {
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
    await audit(store, null, 'assessment_expired', 'assessments', a.id, 'Two-hour exam deadline reached; saved answers preserved for review.');
  return result.row ? { ...a, ...result.row, snapshot_json: a.snapshot_json ?? result.row.snapshot_json } : null;
}
