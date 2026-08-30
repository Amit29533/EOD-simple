import {
  EXAM_MCQ_SECONDS,
  EXAM_OPEN_REVIEW_SECONDS,
  EXAM_OPEN_ANSWER_SECONDS,
} from '../core/constants.mjs';
import { promptKey, mergeDuplicateMetadata } from '../core/question-selection.mjs';
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
  // question-set membership survive the merge.
  const ids = new Map();
  const prompts = new Map();
  const rows = [];
  for (const q of (snap?.questions || [])) {
    if (!q) continue;
    const idKey = q.id ? `id:${q.id}` : '';
    const promptId = q.prompt ? promptKey(q.prompt) : '';
    const keptAt = (idKey && ids.get(idKey)) ?? (promptId && prompts.get(promptId));
    if (Number.isInteger(keptAt)) {
      rows[keptAt] = mergeDuplicateMetadata(rows[keptAt], q);
      continue;
    }
    if (idKey) ids.set(idKey, rows.length);
    if (promptId) prompts.set(promptId, rows.length);
    rows.push(q);
  }
  // Restore the spoken-answer contract before partitioning, so a frozen row
  // that lost its flags still pins first and demands a recorded answer.
  const healed = applySpokenContract(rows);
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

export function remainingMs(q, state, now = Date.now()) {
  const started = Date.parse(state.question_started_at || 0) || now;
  const b = budgetsFor(q);
  if (isOpenQuestion(q) && state.phase === 'review') {
    return Math.max(0, b.review_ms - (now - started));
  }
  const elapsed = now - started;
  if (isOpenQuestion(q) && state.phase === 'answer') {
    return Math.max(0, b.answer_ms - elapsed);
  }
  return Math.max(0, b.answer_ms - elapsed);
}

export function ensureQuizState(a, questions) {
  const qs = questions || sortedQuestions(a.snapshot_json);
  const existing = a.quiz_state && typeof a.quiz_state === 'object' ? a.quiz_state : null;
  if (existing && Number.isInteger(existing.index)) {
    return { ...existing, events: Array.isArray(existing.events) ? existing.events : [] };
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
      screenshot: 0, other: 0,
    },
    events: [],
  };
}

const INTEGRITY_EVENT_KEYS = {
  blur: 'blur',
  copy: 'copy',
  paste: 'paste',
  visibility: 'visibility',
  contextmenu: 'contextmenu',
  fullscreen_exit: 'fullscreen_exit',
  tab_switch: 'tab_switch',
  tab_return: 'tab_return',
  window_blur: 'window_blur',
  browser_close: 'browser_close',
  exam_exit: 'exam_exit',
  exam_reopen: 'exam_reopen',
  exam_start: 'exam_start',
  multi_window: 'multi_window',
  devtools_key: 'devtools_key',
  devtools_resize: 'devtools_resize',
  copy_attempt: 'copy_attempt',
  cut_attempt: 'cut_attempt',
  paste_attempt: 'paste_attempt',
  screenshot: 'screenshot',
  // Recorded by the API itself (not the candidate's browser) when an
  // open-question lock carries no audio — see handlers/candidate.mjs.
  spoken_answer_missing: 'spoken_answer_missing',
};

/**
 * Record one integrity event. `detail`, `question_index` and `question_id` are
 * optional context so the event is meaningful in the audit trail later. Every
 * event is appended to `state.events` (even previously-unknown ones) so nothing
 * a candidate's browser reports is silently dropped.
 */
export function integrityPatch(state, event, detail = '', { question_index = null, question_id = '', question_prompt = '' } = {}) {
  const safeEvent = String(event || '').slice(0, 80);
  if (!safeEvent) return state;
  const key = INTEGRITY_EVENT_KEYS[safeEvent] || 'other';
  const integrity = { ...(state.integrity || {}) };
  integrity[key] = (integrity[key] || 0) + 1;
  const line = {
    at: new Date().toISOString(),
    event: safeEvent,
    detail: String(detail || '').slice(0, 500),
    question_index: Number.isInteger(question_index) ? question_index : null,
    question_id: String(question_id || '').slice(0, 80),
    question_prompt: String(question_prompt || '').slice(0, 200),
  };
  return { ...state, integrity, events: [...(state.events || []), line] };
}
