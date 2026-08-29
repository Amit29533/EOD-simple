import {
  EXAM_MCQ_SECONDS,
  EXAM_OPEN_REVIEW_SECONDS,
  EXAM_OPEN_ANSWER_SECONDS,
} from '../core/constants.mjs';

export function sortedQuestions(snap) {
  const rows = [...(snap?.questions || [])];
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

export function ensureQuizState(a, questions) {
  const qs = questions || sortedQuestions(a.snapshot_json);
  const existing = a.quiz_state && typeof a.quiz_state === 'object' ? a.quiz_state : null;
  if (existing && Number.isInteger(existing.index)) return existing;
  return {
    index: 0,
    question_started_at: new Date().toISOString(),
    phase: qs[0] && isOpenQuestion(qs[0]) ? 'review' : 'answer',
    integrity: { blur: 0, copy: 0, paste: 0, visibility: 0, contextmenu: 0, fullscreen_exit: 0 },
  };
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

export function integrityPatch(state, event) {
  const integrity = { ...(state.integrity || {}) };
  const key = {
    blur: 'blur',
    copy: 'copy',
    paste: 'paste',
    visibility: 'visibility',
    contextmenu: 'contextmenu',
    fullscreen_exit: 'fullscreen_exit',
  }[event];
  if (!key) return state;
  integrity[key] = (integrity[key] || 0) + 1;
  return { ...state, integrity };
}
