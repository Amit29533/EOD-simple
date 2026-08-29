import {
  EXAM_MCQ_SECONDS,
  EXAM_OPEN_REVIEW_SECONDS,
  EXAM_OPEN_ANSWER_SECONDS,
} from '../core/constants.mjs';

export function sortedQuestions(snap) {
  // Never serve the same question twice. Existing snapshots may have been
  // built before duplicate protection existed, so de-duplicate by id (with a
  // prompt fallback for records created before stable ids were guaranteed).
  const ids = new Set();
  const prompts = new Set();
  const rows = [...(snap?.questions || [])].filter((q) => {
    if (!q) return false;
    const idKey = q.id ? `id:${q.id}` : '';
    const promptKey = q.prompt ? `prompt:${q.prompt}` : '';
    if ((idKey && ids.has(idKey)) || (promptKey && prompts.has(promptKey))) return false;
    if (idKey) ids.add(idKey);
    if (promptKey) prompts.add(promptKey);
    return true;
  });
  const pin = rows.filter((q) => q.pin_first);
  const oral = rows.filter((q) => q.question_set && !q.pin_first)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rest = rows.filter((q) => !q.question_set && !q.pin_first)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return [...pin, ...oral, ...rest];
}

export function isOpenQuestion(q) {
  return q?.type === 'text';
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
