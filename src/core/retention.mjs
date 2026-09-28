/**
 * Answer-sheet & recording retention policy.
 *
 * The raw material of a sitting — the recorded clips, the live transcripts and
 * the candidate's typed answers — is kept after the report is generated so an
 * assessor (or an admin auditing a result) can still review the evidence behind
 * a mark. It is not kept forever: an admin-level setting says how long, and the
 * default is 30 days. Everything in this file is pure so the policy can be
 * unit-tested without a store, and so the same rules are used by the settings
 * screen, the cleanup and the read paths that have to explain a missing answer.
 *
 * What is NEVER touched by retention: `assessments.report_json` (every prompt,
 * mark and comment) and the scores on the response rows (`auto_score`,
 * `assessor_score`, `final_score`). The report card stays exactly as generated.
 */

export const SETTINGS_TABLE = 'settings';
/** The settings row this feature owns (`list('settings', { key: 'retention' })`). */
export const RETENTION_KEY = 'retention';

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 0;
export const MAX_RETENTION_DAYS = 3650;
/** `all` = every answer; `open` = only open/scenario answers (typed notes + transcript). */
export const RETENTION_SCOPES = ['all', 'open'];
export const DAY_MS = 24 * 60 * 60 * 1000;

/** How many papers one cleanup run may clear, so a run is never a long request. */
export const MAX_PURGE_PER_SWEEP = 25;

export const DEFAULT_RETENTION = Object.freeze({
  days: DEFAULT_RETENTION_DAYS,
  scope: 'all',
  auto_delete_answer_sheets: true,
  auto_delete_recordings: true,
});

/**
 * Effective settings from a stored row (or none at all).
 *
 * Never throws and never returns a half-configured policy: a row written by an
 * older build, hand-edited, or holding junk falls back per field to the
 * default. The defaults are the documented product decision — 30 days, both
 * artefacts deleted — so an unconfigured workspace behaves as advertised.
 */
export function normaliseRetention(row = {}) {
  const src = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  const days = Number(src.days);
  return {
    days: Number.isFinite(days) ? Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.trunc(days))) : DEFAULT_RETENTION.days,
    scope: RETENTION_SCOPES.includes(src.scope) ? src.scope : DEFAULT_RETENTION.scope,
    // Only an explicit `false` disables a toggle (Airtable omits an unchecked
    // checkbox entirely, and the adapter restores the declared flag columns —
    // but a missing value here must never read as "off").
    auto_delete_answer_sheets: src.auto_delete_answer_sheets !== false,
    auto_delete_recordings: src.auto_delete_recordings !== false,
  };
}

/**
 * Validate an admin's patch. Unknown fields are ignored (the screen sends the
 * whole policy); a bad value is refused with a message the dialog can show.
 * Returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function validateRetentionPatch(body = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};

  if (src.days !== undefined) {
    const days = typeof src.days === 'number' ? src.days : Number(String(src.days).trim());
    if (!Number.isFinite(days) || !Number.isInteger(days))
      return { ok: false, error: `Retention must be a whole number of days (0-${MAX_RETENTION_DAYS}).` };
    if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS)
      return { ok: false, error: `Retention must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.` };
    out.days = days;
  }
  if (src.scope !== undefined) {
    if (!RETENTION_SCOPES.includes(src.scope))
      return { ok: false, error: 'Choose which answers to delete: all answers, or open answers only.' };
    out.scope = src.scope;
  }
  for (const flag of ['auto_delete_answer_sheets', 'auto_delete_recordings']) {
    if (src[flag] === undefined) continue;
    if (typeof src[flag] !== 'boolean') return { ok: false, error: `${flag} must be true or false.` };
    out[flag] = src[flag];
  }
  return { ok: true, value: out };
}

/** The row as it is stored (defaults filled in, key + provenance stamped). */
export function retentionRow(settings, { at = new Date().toISOString(), by = null } = {}) {
  return {
    key: RETENTION_KEY,
    ...normaliseRetention(settings),
    updated_at: at,
    updated_by: by,
  };
}

/**
 * When the clock starts for a paper: the moment its report was generated.
 * `scored_at` is authoritative; the report's own `generated_at`, then the
 * submission time, cover rows written by older builds.
 */
export function retentionAnchor(assessment) {
  const a = assessment || {};
  const anchors = [a.scored_at, a.report_json && a.report_json.generated_at, a.submitted_at];
  for (const at of anchors) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Has this paper's report been generated (the only state retention applies to)? */
export const isFinalizedAssessment = (a) => Boolean(a) && ['scored', 'validated'].includes(a.status);

/** Epoch ms at which the paper's raw material becomes deletable, or null. */
export function dueAt(assessment, settings) {
  if (!isFinalizedAssessment(assessment)) return null;
  const anchor = retentionAnchor(assessment);
  if (anchor === null) return null;
  return anchor + normaliseRetention(settings).days * DAY_MS;
}

/** True when the policy switches every part of the cleanup off. */
export function retentionDisabled(settings) {
  const s = normaliseRetention(settings);
  return !s.auto_delete_answer_sheets && !s.auto_delete_recordings;
}

/** Was this paper already cleaned by the sweep? */
export const purgedAt = (assessment) => {
  const r = assessment && assessment.retention_json;
  return r && typeof r === 'object' && r.purged_at ? String(r.purged_at) : null;
};

/**
 * What the admin/assessor screens say about one paper.
 *   state: 'untracked'  - not finalized yet, no clock
 *          'purged'     - the sweep already removed the raw material
 *          'due'        - deletable now (the next cleanup will take it)
 *          'kept'       - still inside the retention window
 *          'off'        - the policy has both toggles off: kept indefinitely
 */
export function retentionState(assessment, settings, now = Date.now()) {
  const s = normaliseRetention(settings);
  const purged = purgedAt(assessment);
  if (purged) {
    return { state: 'purged', due_at: null, days_left: null, purged_at: purged, purged: assessment.retention_json, settings: s };
  }
  const due = dueAt(assessment, s);
  if (due === null) return { state: 'untracked', due_at: null, days_left: null, purged: null, settings: s };
  const iso = new Date(due).toISOString();
  if (retentionDisabled(s)) return { state: 'off', due_at: iso, days_left: null, purged: null, settings: s };
  const left = Math.ceil((due - now) / DAY_MS);
  return { state: due <= now ? 'due' : 'kept', due_at: iso, days_left: left < 0 ? 0 : left, purged: null, settings: s };
}

/** Should the next cleanup take this paper? */
export function isDueForPurge(assessment, settings, now = Date.now()) {
  if (retentionDisabled(settings)) return false;
  if (purgedAt(assessment)) return false; // already cleaned (idempotent)
  const due = dueAt(assessment, settings);
  return due !== null && due <= now;
}

/* ------------------------------------------------------------------ answers */

/**
 * The retention marker an answer carries once part of it is gone. It is the
 * only trace left on the row (the recording row itself is deleted, and a
 * cleared answer would otherwise be indistinguishable from a blank one) — the
 * assessor screen, the API and the tests all read it.
 */
export function answerRetention(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const r = answer.retention;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
}

/** Does a stored answer still point at a clip? (open answers only) */
export function answerHasClip(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  return Boolean(String(answer.audio_b64 || '').trim() || String(answer.audio_ref || '').trim());
}

/** Anything left on the answer besides the retention marker? */
export function answerHasContent(answer) {
  if (answer === null || answer === undefined) return false;
  if (typeof answer === 'string') return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.length > 0;
  if (typeof answer === 'number') return true;
  if (typeof answer !== 'object') return false;
  const keys = Object.keys(answer).filter((k) => k !== 'retention');
  return keys.length > 0;
}

const purgeMarker = (at, by, reason, parts) => ({
  retention: {
    at, by: by || null, reason,
    ...(parts.sheet ? { sheet: true } : {}),
    ...(parts.recording ? { recording: true } : {}),
    ...(parts.scope ? { scope: parts.scope } : {}),
  },
});

/**
 * The answer a row gets when the cleanup removes part of it.
 *
 * `scope: 'all'`  - every answer loses its content (its marks stay on the row);
 * `scope: 'open'` - only open/scenario answers do.
 * `sheet` / `recording` say which half is being removed (a manual recording
 * delete removes only the clip and keeps the notes and the transcript).
 *
 * Returns `{ answer, changed }`; `changed: false` means nothing was there to
 * remove, so the caller must not write a patch.
 */
export function purgeAnswer(question, answer, {
  at = new Date().toISOString(), by = null, reason = 'retention', scope = 'all',
  sheet = true, recording = true,
} = {}) {
  const q = question || {};
  const marker = answerRetention(answer);
  const dropClip = recording && answerHasClip(answer);
  const isOpen = q.type === 'text';
  const dropSheet = sheet && (scope === 'all' || isOpen) && answerHasContent(answer);

  if (!dropClip && !dropSheet) return { answer, changed: false };

  // A clip-only delete keeps whatever else the answer holds (notes, transcript,
  // source) and only strips the reference to the removed recording.
  if (!dropSheet) {
    const { audio_b64: _b64, audio_ref: _ref, audio_mime: _mime, ...rest } = answer;
    return {
      answer: { ...rest, ...purgeMarker(at, by, reason, { recording: true, sheet: false }) },
      changed: true,
    };
  }
  // The sheet goes: nothing of the candidate's content survives except the
  // marker (and the clip note when both halves were removed in one pass, or
  // when an earlier manual delete already took the clip).
  //
  // A policy can delete sheets but keep recordings. Then the reference to the
  // clip STAYS on the answer, so the assessor can still play the spoken answer
  // even though the notes and transcript are gone — the reference is the only
  // thing pointing at the recording table row.
  const keepsClip = !dropClip && answerHasClip(answer);
  const keptAudio = keepsClip
    ? (answer.audio_ref
      ? { audio_ref: answer.audio_ref, audio_mime: answer.audio_mime || 'audio/webm' }
      : { audio_b64: answer.audio_b64, audio_mime: answer.audio_mime || 'audio/webm' })
    : {};
  return {
    answer: {
      ...keptAudio,
      ...purgeMarker(at, by, reason, {
        sheet: true,
        recording: dropClip || Boolean(marker?.recording),
        scope,
      }),
    },
    changed: true,
  };
}
