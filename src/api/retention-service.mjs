/**
 * Storage-facing half of the retention policy (see src/core/retention.mjs for
 * the rules themselves).
 *
 * Three jobs:
 *  - read/write the `retention` row of the `settings` table;
 *  - run the cleanup that removes answer sheets and recordings N days after a
 *    report was generated (never before: a paper awaiting scoring is untouched);
 *  - delete one recording on an assessor's explicit request.
 *
 * The cleanup is triggered by the admin's button and, opportunistically, by a
 * few read paths (there is no scheduler in this deployment — the audit-log trim
 * works the same way). Every entry point is safe to call with nothing due: the
 * current settings are read first and an all-off policy or an empty due list
 * costs one list and no writes.
 */
import { audit, bulkRemove, bulkUpdate } from './helpers.mjs';
import { withLock } from './mutex.mjs';
import { sortedQuestions } from './quiz-session.mjs';
import {
  SETTINGS_TABLE, RETENTION_KEY, MAX_PURGE_PER_SWEEP,
  normaliseRetention, validateRetentionPatch, retentionRow, retentionState,
  isDueForPurge, isFinalizedAssessment, purgedAt, dueAt, retentionDisabled,
  purgeAnswer, answerRetention, answerHasClip,
} from '../core/retention.mjs';

/**
 * The effective settings plus how they were obtained.
 * `provisioned: false` means the backend has no `settings` table yet (an
 * Airtable base created before this feature): reads fall back to the defaults
 * so nothing 500s, while the settings screen says saving needs a re-provision.
 */
export async function readRetentionSettings(store) {
  try {
    const [row] = await store.list(SETTINGS_TABLE, { key: RETENTION_KEY });
    return { settings: normaliseRetention(row || {}), row: row || null, provisioned: true };
  } catch (err) {
    return { settings: normaliseRetention({}), row: null, provisioned: false, error: err?.message || String(err) };
  }
}

/** Effective settings only (the shape every caller that just needs the policy wants). */
export async function getRetentionSettings(store) {
  const { settings } = await readRetentionSettings(store);
  return settings;
}

/**
 * Validate and store an admin's patch. Returns `{ error }` for a bad value, or
 * `{ settings, row }`. A missing `settings` table is reported, not swallowed:
 * the admin must know the save cannot land on this backend.
 */
export async function saveRetentionSettings(store, patch, user, { now = Date.now() } = {}) {
  const check = validateRetentionPatch(patch);
  if (!check.ok) return { error: check.error };
  const current = await readRetentionSettings(store);
  if (!current.provisioned) {
    return { error: 'This backend has no settings table yet. Run `npm run airtable:setup` (Airtable) and try again.' };
  }
  const merged = normaliseRetention({ ...current.settings, ...check.value });
  const row = retentionRow(merged, { at: new Date(now).toISOString(), by: user?.id || null });
  const saved = current.row
    ? await store.update(SETTINGS_TABLE, current.row.id, row)
    : await store.insert(SETTINGS_TABLE, row);
  return { settings: normaliseRetention(saved || row), row: saved || row };
}

/**
 * Remove the raw material of ONE paper. Called with the current row inside the
 * assessment's lock; idempotent (a paper already marked purged is skipped).
 *
 * Order matters: response rows and clips are written first, the paper's marker
 * last — a crash in between leaves the paper looking un-purged, so the next run
 * repeats the work instead of leaving clips behind with no trace.
 */
export async function purgeAssessment(store, assessment, settings, {
  at = new Date().toISOString(), by = null, reason = 'retention', actor = null, log = true,
} = {}) {
  const scope = normaliseRetention(settings).scope;
  const dropSheets = normaliseRetention(settings).auto_delete_answer_sheets;
  const dropRecordings = normaliseRetention(settings).auto_delete_recordings;
  const questions = new Map(sortedQuestions(assessment.snapshot_json).map((q) => [q.id, q]));

  const responses = await store.list('responses', { assessment_id: assessment.id });
  const clips = dropRecordings
    ? await store.list('recordings', { assessment_id: assessment.id })
    : [];

  const updates = [];
  for (const r of responses) {
    // A response whose question is no longer in the served set (a deactivated
    // competency) has no type to consult: treat it as an open answer, which is
    // what the conservative scope keeps.
    const q = questions.get(r.question_id) || { type: 'text' };
    const { answer, changed } = purgeAnswer(q, r.answer, {
      at, by, reason, scope, sheet: dropSheets, recording: dropRecordings,
    });
    if (changed) updates.push({ id: r.id, patch: { answer } });
  }
  await bulkUpdate(store, 'responses', updates);
  await bulkRemove(store, 'recordings', clips.map((c) => c.id));

  const marker = {
    purged_at: at,
    by: by || null,
    reason,
    scope,
    answer_sheets: dropSheets,
    recordings: dropRecordings,
    sheet_rows: updates.length,
    clips: clips.length,
  };
  await store.update('assessments', assessment.id, { retention_json: marker });

  if (log) {
    const bits = [
      dropSheets ? `${updates.length} answer row(s)` : '',
      dropRecordings && clips.length ? `${clips.length} recording(s)` : '',
    ].filter(Boolean).join(' and ') || 'nothing (already empty)';
    await audit(store, actor || { name: 'system' }, 'assessment_data_purged', 'assessments', assessment.id,
      `Retention cleanup removed ${bits} for a finalized assessment`);
  }
  return { id: assessment.id, rows: updates.length, clips: clips.length };
}

/**
 * Run the cleanup. `rows` lets a caller that has just listed the assessments
 * (the dashboard, the settings screen) hand them over so no second listing is
 * needed; without it the table is read here.
 *
 * Never throws for one bad paper: a paper that fails is reported and the rest
 * of the batch continues — the next run picks it up.
 */
export async function runRetentionSweep(store, {
  now = Date.now(), rows = null, actor = null, limit = MAX_PURGE_PER_SWEEP, reason = 'retention',
} = {}) {
  const settings = await getRetentionSettings(store);
  if (retentionDisabled(settings)) return { ran: false, reason: 'off', settings, purged: 0, rows: 0, clips: 0, papers: [] };

  const all = Array.isArray(rows) ? rows : await store.list('assessments', {}, { detached: false });
  const due = all.filter((a) => isDueForPurge(a, settings, now));
  const batch = due.slice(0, Math.max(1, limit));
  const at = new Date(now).toISOString();
  const papers = [];
  let failed = 0;

  for (const row of batch) {
    try {
      const done = await withLock(`assessment:${row.id}`, async () => {
        // Re-read under the lock: another instance may have cleaned this paper
        // (or a finalize may have landed) between the listing and the lock.
        const fresh = await store.get('assessments', row.id);
        if (!fresh || !isDueForPurge(fresh, settings, now)) return null;
        return purgeAssessment(store, fresh, settings, { at, by: actor?.id || null, reason, actor });
      });
      if (done) papers.push(done);
    } catch (err) {
      failed += 1;
      console.warn(`[retention] could not purge assessment ${row.id}: ${err.message}`);
    }
  }

  const totals = papers.reduce((s, p) => ({ rows: s.rows + p.rows, clips: s.clips + p.clips }), { rows: 0, clips: 0 });
  return {
    ran: true, settings, purged: papers.length, failed,
    rows: totals.rows, clips: totals.clips,
    remaining: Math.max(0, due.length - papers.length),
    papers,
  };
}

let inFlight = null;

/**
 * Fire-and-forget cleanup for a read path. The caller does NOT await it: the
 * response is already on its way out. Failures are logged, never thrown at the
 * request that happened to trigger it, and two concurrent triggers share one
 * run.
 */
export function sweepInBackground(store, opts = {}) {
  if (inFlight) return inFlight;
  inFlight = Promise.resolve()
    .then(() => runRetentionSweep(store, opts))
    .catch((err) => {
      console.warn(`[retention] background sweep failed: ${err.message}`);
      return null;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Per-paper retention state for the admin lists / report page / assessor detail. */
export function paperRetention(assessment, settings, now = Date.now()) {
  return retentionState(assessment, settings, now);
}

/**
 * Counts for the settings screen: how many finalized papers there are, how many
 * the next cleanup would take, and when the next one falls due.
 */
export async function retentionStatus(store, settings, { now = Date.now(), rows = null } = {}) {
  const all = Array.isArray(rows) ? rows : await store.list('assessments', {}, { detached: false });
  const finalized = all.filter(isFinalizedAssessment);
  const purged = finalized.filter((a) => purgedAt(a));
  const due = finalized.filter((a) => isDueForPurge(a, settings, now));
  const upcoming = finalized
    .filter((a) => !purgedAt(a))
    .map((a) => dueAt(a, settings))
    .filter((t) => t !== null && t > now)
    .sort((x, y) => x - y);
  return {
    finalized_papers: finalized.length,
    due_now: due.length,
    purged_papers: purged.length,
    next_due_at: upcoming.length ? new Date(upcoming[0]).toISOString() : null,
    sweep_limit: MAX_PURGE_PER_SWEEP,
  };
}

/**
 * Delete ONE recording on the assessor's request. The clip (its own row, or the
 * legacy inline copy) is removed and the answer is marked; the typed notes and
 * the transcript are kept, because those are the answer sheet, not the audio.
 *
 * Returns `{ deleted, question_id, already }` or `{ missing: true }`.
 */
export async function deleteAssessmentRecording(store, assessment, questionId, {
  at = new Date().toISOString(), actor = null, reason = 'manual',
} = {}) {
  const qid = String(questionId || '');
  const clips = await store.list('recordings', { assessment_id: assessment.id, question_id: qid });
  const [row] = await store.list('responses', { assessment_id: assessment.id, question_id: qid });
  const answer = row?.answer;
  // A clip can be in its own row (today), inline on the answer (papers written
  // before the recordings table), or only referenced from a stale `audio_ref`.
  const carriesClip = clips.length > 0 || answerHasClip(answer);

  if (!carriesClip) {
    // Nothing to delete. If the answer says a recording was already removed,
    // that is a success (a double click on a slow connection), not an error.
    return answerRetention(answer)?.recording ? { already: true, deleted: 0, question_id: qid } : { missing: true, question_id: qid };
  }

  const hadInline = Boolean(answer && typeof answer === 'object' && !Array.isArray(answer) && answer.audio_b64);
  await bulkRemove(store, 'recordings', clips.map((c) => c.id));
  let removedInline = false;
  if (row) {
    const { answer: stripped, changed } = purgeAnswer(null, answer, {
      at, by: actor?.id || null, reason, sheet: false, recording: true,
    });
    if (changed) {
      removedInline = hadInline && !stripped?.audio_b64;
      await store.update('responses', row.id, { answer: stripped });
    }
  }
  await audit(store, actor, 'assessment_recording_deleted', 'assessments', assessment.id,
    `A recording was deleted from the assessor review (question ${qid})`, { question_id: qid, clips: clips.length });
  // A legacy inline clip is one recording too, even though it carries no row.
  return { deleted: clips.length + (removedInline ? 1 : 0), question_id: qid, already: false };
}
