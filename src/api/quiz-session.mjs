import {
  EXAM_MCQ_SECONDS,
  EXAM_OPEN_REVIEW_SECONDS,
  EXAM_OPEN_ANSWER_SECONDS,
} from '../core/constants.mjs';
import { dedupeQuestions } from '../core/question-selection.mjs';
// The open/spoken answer contract lives in core so the exam session, the admin
// write path and the published catalogue all read the same rule. Re-exported
// from here because the exam session is where candidates meet it.
import { isOpenQuestion, requiresSpokenAnswer } from '../core/spoken-answer.mjs';
import { applySpokenContract } from './catalogue-service.mjs';

export { isOpenQuestion, requiresSpokenAnswer };

export function sortedQuestions(snap) {
  // Never serve the same question twice. Existing snapshots may have been
  // built before duplicate protection existed, so de-duplicate by id and by
  // *normalized* prompt (typography-insensitive — curly quotes, dashes,
  // spacing and case differences between two stored copies of the same
  // question must not let it be asked twice). The surviving row inherits the
  // oral metadata of the dropped twin so the microphone requirement, pin and
  // question-set membership survive the merge. Same rule the allocator uses,
  // from one shared implementation (core/question-selection.mjs).
  const rows = dedupeQuestions(snap?.questions || []);
  // Restore the spoken-answer contract before partitioning, so a frozen row
  // that lost its flags still pins first and demands a recorded answer.
  const healed = applySpokenContract(rows);
  // A paper allocated since shuffling was introduced records the position each
  // question was drawn into, so the candidate's cursor, the assessor's review
  // list and the scorer all read the same mixed objective/open order back.
  // Snapshots allocated before that have no positions: they keep the grouping
  // they were allocated with, because re-ordering a paper someone is halfway
  // through would move questions out from under their cursor.
  const stamped = healed.filter((q) => Number.isInteger(q.position));
  if (healed.length && stamped.length === healed.length) {
    return [...healed].sort((a, b) => a.position - b.position);
  }
  const pin = healed.filter((q) => q.pin_first);
  const oral = healed.filter((q) => q.question_set && !q.pin_first)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rest = healed.filter((q) => !q.question_set && !q.pin_first)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return [...pin, ...oral, ...rest];
}

export function budgetsFor(q) {
  if (isOpenQuestion(q)) {
    return {
      review_ms: EXAM_OPEN_REVIEW_SECONDS * 1000,
      answer_ms: EXAM_OPEN_ANSWER_SECONDS * 1000,
    };
  }
  return { review_ms: 0, answer_ms: EXAM_MCQ_SECONDS * 1000 };
}

/**
 * The current question's start time, or null when the state has no usable one.
 *
 * Only a real string is parsed. Handing a number to `Date.parse` coerces it to
 * a string that *does* parse — `Date.parse(0)` is 2000-01-01 — and that is
 * exactly what made a state with a missing clock read as 26 years overdue: the
 * exam auto-advanced through every question with blank answers and a
 * `time_expired` entry each time. `null` here means "the clock starts now".
 */
function parseQuestionStartedAt(state) {
  const raw = state?.question_started_at;
  if (typeof raw !== 'string' || !raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Budget in force for the current question and phase. */
function activeBudgetMs(q, state) {
  const b = budgetsFor(q);
  return isOpenQuestion(q) && (state?.phase || 'answer') === 'review' ? b.review_ms : b.answer_ms;
}

/**
 * Milliseconds left on the current question. Unclamped, so a caller can tell
 * "just expired" from "long expired" (the exam grace window relies on it).
 */
export function remainingTimeMs(q, state, now = Date.now()) {
  return activeBudgetMs(q, state) - (now - (parseQuestionStartedAt(state) ?? now));
}

export function remainingMs(q, state, now = Date.now()) {
  return Math.max(0, remainingTimeMs(q, state, now));
}

export function ensureQuizState(a, questions) {
  const qs = questions || sortedQuestions(a.snapshot_json);
  const existing = a.quiz_state && typeof a.quiz_state === 'object' ? a.quiz_state : null;
  if (existing && Number.isInteger(existing.index)) {
    // Backfill a clock a partial/legacy state is missing, so the restored
    // question starts a fresh budget instead of reading as already expired.
    const healed = parseQuestionStartedAt(existing) === null
      ? { ...existing, question_started_at: new Date().toISOString() }
      : existing;
    return { ...healed, events: Array.isArray(existing.events) ? existing.events : [] };
  }
  return {
    index: 0,
    question_started_at: new Date().toISOString(),
    phase: qs[0] && isOpenQuestion(qs[0]) ? 'review' : 'answer',
    integrity: {
      blur: 0, copy: 0, paste: 0, visibility: 0, contextmenu: 0, fullscreen_exit: 0,
      tab_switch: 0, tab_return: 0, window_blur: 0, browser_close: 0, exam_exit: 0,
      exam_reopen: 0, exam_start: 0, multi_window: 0, devtools_key: 0,
      devtools_resize: 0, copy_attempt: 0, cut_attempt: 0, paste_attempt: 0,
      screenshot: 0, spoken_answer_missing: 0, other: 0,
    },
    events: [],
  };
}

/**
 * Known integrity event names. A `Set` rather than an object literal: with an
 * object, `KEYS[eventName]` resolves inherited members for a browser that
 * reports an event called `constructor` or `toString`, and the counter was then
 * filed under a garbage key instead of `other`.
 */
const INTEGRITY_EVENT_KEYS = new Set([
  'blur',
  'copy',
  'paste',
  'visibility',
  'contextmenu',
  'fullscreen_exit',
  'tab_switch',
  'tab_return',
  'window_blur',
  'browser_close',
  'exam_exit',
  'exam_reopen',
  'exam_start',
  'multi_window',
  'devtools_key',
  'devtools_resize',
  'copy_attempt',
  'cut_attempt',
  'paste_attempt',
  'screenshot',
  // Recorded by the API itself (not the candidate's browser) when an
  // open-question lock carries no audio — see handlers/candidate.mjs.
  'spoken_answer_missing',
]);

/**
 * How much of the raw event log is kept on the assessment record. Counters are
 * exact and unbounded; the history is a ring, because every append rewrites
 * the whole assessment (and, on the file/blob adapters, the whole store), so an
 * unbounded log turns a chatty or misbehaving client into quadratic writes.
 */
export const MAX_INTEGRITY_EVENTS = 200;

/**
 * Record one integrity event. `detail`, `question_index` and `question_id` are
 * optional context so the event is meaningful in the audit trail later. Every
 * event is appended to `state.events` (even previously-unknown ones) so nothing
 * a candidate's browser reports is silently dropped.
 */
export function integrityPatch(state, event, detail = '', { question_index = null, question_id = '', question_prompt = '' } = {}) {
  const safeEvent = String(event || '').slice(0, 80);
  if (!safeEvent) return state;
  const key = INTEGRITY_EVENT_KEYS.has(safeEvent) ? safeEvent : 'other';
  // Counters live on a null-prototype object so an event named `__proto__`
  // cannot reach the prototype chain through the write below.
  const integrity = { __proto__: null, ...state.integrity };
  integrity[key] = (integrity[key] || 0) + 1;
  const line = {
    at: new Date().toISOString(),
    event: safeEvent,
    detail: String(detail || '').slice(0, 500),
    question_index: Number.isInteger(question_index) ? question_index : null,
    question_id: String(question_id || '').slice(0, 80),
    question_prompt: String(question_prompt || '').slice(0, 200),
  };
  const events = [...(state.events || []), line];
  const dropped = (state.events_dropped || 0) + Math.max(0, events.length - MAX_INTEGRITY_EVENTS);
  return {
    ...state,
    integrity,
    events: events.slice(-MAX_INTEGRITY_EVENTS),
    events_dropped: dropped || undefined,
  };
}
