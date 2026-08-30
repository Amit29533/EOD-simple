/**
 * The open-question answer contract.
 *
 * Every Open / scenario question (`type === 'text'`) is answered **out loud**:
 * the candidate must submit a recorded microphone answer, and the text box is an
 * optional place for supporting notes. This is a property of the question
 * *type*, not a per-question opt-in, so:
 *
 *  - a bank seeded before the requirement existed, an admin edit that stripped
 *    the flag, and a paper frozen while the bank was in that state all heal to
 *    the same behavior (see `withSpokenContract` / `healSpokenContract`);
 *  - `questionForCandidate` always carries `audio_required: true` on an open
 *    question, so the record control cannot disappear from the exam UI;
 *  - a non-open question may still opt in explicitly through `audio_required`
 *    (the published spoken customer-advisory set does), but nothing can opt an
 *    open question out of it.
 *
 * A recorded answer counts as *spoken evidence* when the submission carries
 * stored audio or a live transcript — either alone is enough, because a browser
 * without `MediaRecorder` can still transcribe and a browser without
 * transcription can still record.
 */

export const OPEN_QUESTION_TYPE = 'text';

/** Open / scenario question: the only type answered with prose + speech. */
export function isOpenQuestion(q) {
  return q?.type === OPEN_QUESTION_TYPE;
}

/** True when the candidate must answer this question through the microphone. */
export function requiresSpokenAnswer(q) {
  if (!q) return false;
  return isOpenQuestion(q) || q.audio_required === true;
}

/**
 * Additive heal for one question row: an open question always carries the
 * microphone requirement. Untouched (same reference) when it already does, so
 * bulk heals stay cheap and non-open rows are never rewritten.
 */
export function withSpokenContract(q) {
  if (!q || !isOpenQuestion(q) || q.audio_required === true) return q;
  return { ...q, audio_required: true };
}

/** Bulk form of `withSpokenContract` for a served/published question list. */
export function healSpokenContract(questions = []) {
  return questions.map((q) => withSpokenContract(q));
}

/** Did this submission actually carry a recorded/spoken answer? */
export function hasSpokenEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  const b64 = String(value.audio_b64 || '').replace(/\s/g, '');
  return Boolean(b64) || Boolean(String(value.transcript || '').trim());
}

/**
 * Does an open answer contain anything worth storing? Typed notes, a transcript
 * or a recording all count — a candidate who answered out loud without typing a
 * single word must not have their answer treated as blank and discarded.
 */
export function openAnswerHasContent(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (!value || typeof value !== 'object') return false;
  return Boolean(
    String(value.text || '').trim()
    || String(value.transcript || '').trim()
    || String(value.audio_b64 || '').replace(/\s/g, ''),
  );
}
