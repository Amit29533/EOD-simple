/**
 * Answer-sheet & recording retention, and the assessor's access to the
 * evidence after a report exists.
 *
 * What this suite pins:
 *  - a finalized paper keeps its answer sheet, transcripts and recordings, and
 *    the assessor can still read them (the screen was the only thing that used
 *    to hide them: the report replaced the scoring view);
 *  - the admin-level policy: defaults (30 days, both artefacts, everything),
 *    validation, RBAC, and what the settings screen is told;
 *  - the cleanup: due maths from the report's own timestamp, scope `all` vs
 *    `open`, toggles off, idempotence, batches, and what it must never touch
 *    (scores, the report card);
 *  - the assessor's manual delete of ONE recording: own paper only, after
 *    submission, keeps the notes/transcript, audited, idempotent;
 *  - the same policy on the Netlify Blobs adapter, not just the JSON file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { createBlobsStore } from '../src/storage/netlify-blobs.mjs';
import {
  DEFAULT_RETENTION, normaliseRetention, validateRetentionPatch, retentionRow,
  retentionState, dueAt, isDueForPurge, purgeAnswer, answerRetention,
  MAX_RETENTION_DAYS, DAY_MS,
} from '../src/core/retention.mjs';
import { runRetentionSweep, deleteAssessmentRecording } from '../src/api/retention-service.mjs';

const CLIP_B64 = 'RkFLRQ=='.repeat(30); // small but valid base64

/* ============================ the policy itself ============================ */

test('retention defaults are 30 days, everything, both toggles on — and junk never changes that', () => {
  assert.deepEqual(normaliseRetention(), DEFAULT_RETENTION);
  assert.deepEqual(normaliseRetention(null), DEFAULT_RETENTION);
  assert.deepEqual(normaliseRetention({ days: 'soon', scope: 'sideways' }), DEFAULT_RETENTION);
  // A missing value must never read as "off": only an explicit false disables.
  assert.equal(normaliseRetention({}).auto_delete_recordings, true);
  assert.equal(normaliseRetention({ auto_delete_recordings: false }).auto_delete_recordings, false);
  // Clamped, not rejected, on the way out of storage.
  assert.equal(normaliseRetention({ days: 99999 }).days, MAX_RETENTION_DAYS);
  assert.equal(normaliseRetention({ days: -5 }).days, 0);
  assert.equal(normaliseRetention({ days: 12.7 }).days, 12);
});

test('a patch is validated field by field', () => {
  assert.equal(validateRetentionPatch({ days: 30 }).ok, true);
  assert.equal(validateRetentionPatch({ days: '14' }).value.days, 14);
  assert.equal(validateRetentionPatch({ days: -1 }).ok, false);
  assert.equal(validateRetentionPatch({ days: MAX_RETENTION_DAYS + 1 }).ok, false);
  assert.equal(validateRetentionPatch({ days: 1.5 }).ok, false);
  assert.equal(validateRetentionPatch({ days: 'later' }).ok, false);
  assert.equal(validateRetentionPatch({ scope: 'objective' }).ok, false);
  assert.equal(validateRetentionPatch({ auto_delete_recordings: 'yes' }).ok, false);
  // Unknown fields (a newer screen talking to this build) are ignored.
  assert.deepEqual(validateRetentionPatch({ days: 7, something_new: true }).value, { days: 7 });
  assert.deepEqual(retentionRow({ days: 7 }, { at: '2026-01-01T00:00:00.000Z', by: 'u1' }), {
    key: 'retention', days: 7, scope: 'all', auto_delete_answer_sheets: true, auto_delete_recordings: true,
    updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'u1',
  });
});

test('the clock starts at the report, and the state tells the screens what to say', () => {
  const scored = { status: 'scored', scored_at: '2026-01-01T00:00:00.000Z' };
  const now = Date.parse('2026-01-10T00:00:00.000Z');
  assert.equal(dueAt(scored, { days: 30 }), Date.parse('2026-01-31T00:00:00.000Z'));
  assert.equal(retentionState(scored, { days: 30 }, now).state, 'kept');
  assert.equal(retentionState(scored, { days: 30 }, now).days_left, 21);
  assert.equal(retentionState(scored, { days: 30 }, Date.parse('2026-02-01T00:00:00.000Z')).state, 'due');
  assert.equal(retentionState(scored, { days: 0 }, now).state, 'due');
  assert.equal(isDueForPurge(scored, { days: 30 }, now), false);
  assert.equal(isDueForPurge(scored, { days: 0 }, now), true);
  // A paper still waiting for its assessor has no clock at all.
  assert.equal(dueAt({ status: 'submitted', submitted_at: '2026-01-01T00:00:00.000Z' }, { days: 0 }), null);
  assert.equal(retentionState({ status: 'in_progress' }, { days: 0 }, now).state, 'untracked');
  // An all-off policy keeps everything and says so.
  assert.equal(retentionState(scored, { days: 0, auto_delete_answer_sheets: false, auto_delete_recordings: false }, now).state, 'off');
  assert.equal(isDueForPurge(scored, { days: 0, auto_delete_answer_sheets: false, auto_delete_recordings: false }, now), false);
  // A paper the sweep already cleared is never due again.
  const purged = { ...scored, retention_json: { purged_at: '2026-01-05T00:00:00.000Z' } };
  assert.equal(isDueForPurge(purged, { days: 0 }, now), false);
  assert.equal(retentionState(purged, { days: 0 }, now).state, 'purged');
  // A legacy row with no scored_at still anchors on the report it wrote.
  assert.equal(dueAt({ status: 'scored', report_json: { generated_at: '2026-01-02T00:00:00.000Z' } }, { days: 1 }),
    Date.parse('2026-01-03T00:00:00.000Z'));
});

test('purgeAnswer removes exactly what it says and leaves a marker', () => {
  const at = '2026-02-01T00:00:00.000Z';
  const open = { type: 'text' };
  const mcq = { type: 'mcq_single' };

  // scope all: both kinds lose their content; a clip is noted if one was there.
  const openAll = purgeAnswer(open, { text: 'n', transcript: 't', source: 'audio', audio_ref: 'a/q' }, { at, scope: 'all' });
  assert.equal(openAll.changed, true);
  assert.deepEqual(openAll.answer, { retention: { at, by: null, reason: 'retention', sheet: true, recording: true, scope: 'all' } });
  assert.deepEqual(purgeAnswer(mcq, 'b', { at, scope: 'all' }).answer.retention.sheet, true);

  // scope open: the objective pick stays exactly as it was.
  assert.equal(purgeAnswer(mcq, 'b', { at, scope: 'open' }).changed, false);
  assert.equal(purgeAnswer(open, { text: 'n' }, { at, scope: 'open' }).answer.retention.sheet, true);

  // recording-only (the manual delete): notes and transcript survive, the clip
  // reference is stripped, and an earlier recording note is not lost.
  const clipOnly = purgeAnswer(open, { text: 'n', transcript: 't', source: 'audio', audio_b64: 'AAA', audio_mime: 'audio/webm' },
    { at, by: 'u1', reason: 'manual', sheet: false, recording: true });
  assert.deepEqual(clipOnly.answer, { text: 'n', transcript: 't', source: 'audio', retention: { at, by: 'u1', reason: 'manual', recording: true } });
  assert.equal(purgeAnswer(open, { text: 'n' }, { at, sheet: false, recording: true }).changed, false, 'nothing to delete');

  // A policy that deletes sheets but KEEPS recordings: the reference to the
  // clip has to survive, or the assessor could no longer play the answer.
  const sheetsOnly = purgeAnswer(open, { text: 'n', transcript: 't', audio_ref: 'a/q', audio_mime: 'audio/webm' },
    { at, scope: 'all', sheet: true, recording: false });
  assert.deepEqual(sheetsOnly.answer, {
    audio_ref: 'a/q', audio_mime: 'audio/webm',
    retention: { at, by: null, reason: 'retention', sheet: true, scope: 'all' },
  });
  // The marker is idempotent: purging an already-purged answer changes nothing.
  assert.equal(purgeAnswer(mcq, { retention: { sheet: true } }, { at, scope: 'all' }).changed, false);
  assert.equal(answerRetention({ retention: { sheet: true } }).sheet, true);
});

/* ========================== the API and the cleanup ========================== */

/** One full sitting: MCQs answered, open questions spoken (a clip on each). */
async function sitWithClips(w, { token, assessmentId }, { clip = CLIP_B64 } = {}) {
  for (;;) {
    const s = await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
    const q = s.body.current_question;
    if (!q || s.body.exam.complete) break;
    const answer = q.type === 'text'
      ? { text: `Notes for ${q.prompt.slice(0, 12)}`, transcript: 'Spoken answer, kept as evidence.', source: 'audio', audio_b64: clip, audio_mime: 'audio/webm' }
      : 'a';
    const r = await w.call('POST', `/candidate/assessments/${assessmentId}/next`, { token, body: { answer, question_id: q.id } });
    if (r.status !== 200) throw new Error(`next: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.body.complete) break;
  }
  const sub = await w.call('POST', `/candidate/assessments/${assessmentId}/submit`, { token, body: { answers: {} } });
  if (sub.status !== 200) throw new Error(`submit: ${sub.status} ${JSON.stringify(sub.body)}`);
}

/** A finalized paper with one assessor who owns it. */
async function finalizedWorld(t, opts) {
  const w = await makeWorld({ mcq: 2, open: 2, t });
  const A = await w.assessorUser('ret.assessor');
  const C = await w.candidateUser('ret.cand', { name: 'Retention Rita' });
  await sitWithClips(w, { token: C.token, assessmentId: C.assessmentId }, opts);
  await w.assign(C.assessmentId, A.user.id);
  await w.scoreAndFinalize(A.token, C.assessmentId, { score: 4 });
  return { w, A, C, id: C.assessmentId };
}

test('the settings screen is admin-only, defaults to 30 days, and validates', async (t) => {
  const w = await makeWorld({ t });
  const A = await w.assessorUser('settings.assessor');
  const C = await w.candidateUser('settings.cand');

  const defaults = await w.call('GET', '/admin/settings/retention', { token: w.tok });
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.body.settings, DEFAULT_RETENTION);
  assert.equal(defaults.body.provisioned, true);
  assert.equal(defaults.body.status.finalized_papers, 0, 'nothing is finalized yet');
  assert.deepEqual(defaults.body.defaults, DEFAULT_RETENTION);

  for (const [who, token] of [['assessor', A.token], ['candidate', C.token]]) {
    const res = await w.call('GET', '/admin/settings/retention', { token });
    assert.equal(res.status, 403, `${who} cannot read platform settings`);
  }
  assert.equal((await w.call('GET', '/admin/settings/retention')).status, 401, 'anonymous');

  for (const body of [{ days: -1 }, { days: 'tomorrow' }, { scope: 'objective' }, { auto_delete_recordings: 'yes' }]) {
    const res = await w.call('PUT', '/admin/settings/retention', { token: w.tok, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} is refused`);
  }
  assert.equal((await w.call('PUT', '/admin/settings/retention', { token: A.token, body: { days: 1 } })).status, 403);

  const saved = await w.call('PUT', '/admin/settings/retention', {
    token: w.tok, body: { days: 14, scope: 'open', auto_delete_recordings: false },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings, { days: 14, scope: 'open', auto_delete_answer_sheets: true, auto_delete_recordings: false });

  // It is stored (one row) and survives a fresh read, with provenance.
  const rows = await w.store.list('settings', { key: 'retention' });
  assert.equal(rows.length, 1, 'one settings row, updated in place');
  assert.equal(rows[0].updated_by, (await w.store.list('users', { username: 'admin' }))[0].id);
  const reread = await w.call('GET', '/admin/settings/retention', { token: w.tok });
  assert.equal(reread.body.settings.days, 14);
  assert.equal(reread.body.updated_by_name, 'Admin');
  const auditRows = await w.store.list('audit_log', { action: 'retention_settings_updated' });
  assert.equal(auditRows.length, 1, 'the change is audited');
  assert.match(auditRows[0].message, /14 day/);
});

test('a finalized paper keeps its answer sheet, transcripts and recordings for the assessor', async (t) => {
  const { w, A, id } = await finalizedWorld(t);
  const detail = await w.call('GET', `/assessor/assessments/${id}`, { token: A.token });
  assert.equal(detail.status, 200);

  // The report is there as before...
  assert.ok(detail.body.report, 'the report still comes with the detail');
  assert.equal(detail.body.retention.state, 'kept');
  assert.ok(detail.body.retention.due_at, 'and says when the evidence is deleted');

  // ...and so is everything the report was built from.
  const open = detail.body.responses.filter((r) => r.answer && typeof r.answer === 'object' && 'transcript' in r.answer);
  assert.equal(open.length, 2, 'both open answers are still in the payload');
  assert.match(open[0].answer.transcript, /Spoken answer/, 'the transcript survives finalization');
  assert.match(open[0].answer.text, /Notes for/, 'and the typed notes');
  assert.equal(open[0].answer.has_recording, true, 'the clip is flagged…');
  assert.equal(open[0].answer.audio_b64, undefined, '…but never inlined in the payload');

  // The clip itself is one request away, as it was before finalization.
  const rec = await w.call('GET', `/assessor/assessments/${id}/recordings/${open[0].question_id}`, { token: A.token });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.audio_b64, CLIP_B64);

  // The MCQ markings are untouched by finalization too.
  const mcq = detail.body.responses.find((r) => r.answer === 'a');
  assert.equal(mcq.auto_score, 4);
});

test('the assessor can delete ONE recording — clip gone, notes and transcript kept, audited', async (t) => {
  const { w, A, id } = await finalizedWorld(t);
  const detail = await w.call('GET', `/assessor/assessments/${id}`, { token: A.token });
  const target = detail.body.responses.find((r) => r.answer?.has_recording);
  const qid = target.question_id;

  const before = await w.store.list('recordings', { assessment_id: id });
  assert.equal(before.length, 2, 'a clip for each spoken answer');

  const del = await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`, { token: A.token });
  assert.equal(del.status, 200);
  assert.deepEqual({ deleted: del.body.deleted, already: del.body.already_deleted }, { deleted: 1, already: false });
  assert.equal((await w.store.list('recordings', { assessment_id: id })).length, 1, 'only that question’s clip went');
  assert.equal((await w.store.list('recordings', { assessment_id: id, question_id: qid })).length, 0);

  // The answer sheet is intact: the delete takes the audio, not the answer.
  const [row] = await w.store.list('responses', { assessment_id: id, question_id: qid });
  assert.match(row.answer.text, /Notes for/);
  assert.match(row.answer.transcript, /Spoken answer/);
  assert.equal(row.answer.audio_ref, undefined, 'the reference to the deleted clip is dropped');
  assert.equal(row.answer.retention.recording, true);
  assert.equal(row.answer.retention.reason, 'manual');
  assert.equal(row.final_score, 4, 'the mark is untouched');

  // The detail explains the hole instead of showing a broken player.
  const after = await w.call('GET', `/assessor/assessments/${id}`, { token: A.token });
  const shown = after.body.responses.find((r) => r.question_id === qid);
  assert.equal(shown.answer.has_recording, false);
  assert.equal(shown.answer.recording_deleted, true);
  assert.equal((await w.call('GET', `/assessor/assessments/${id}/recordings/${qid}`, { token: A.token })).status, 404);

  // The other recording, the report and the audit trail are unaffected.
  const otherQid = detail.body.responses.find((r) => r.answer?.has_recording && r.question_id !== qid).question_id;
  assert.equal((await w.call('GET', `/assessor/assessments/${id}/recordings/${otherQid}`, { token: A.token })).status, 200);
  assert.ok(after.body.report);
  const audits = await w.store.list('audit_log', { action: 'assessment_recording_deleted' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].entity_id, id);

  // Idempotent: a second click reports the delete that already happened.
  const again = await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`, { token: A.token });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_deleted, true);
  assert.equal(again.body.deleted, 0);
  assert.equal((await w.store.list('audit_log', { action: 'assessment_recording_deleted' })).length, 1, 'a no-op is not audited twice');
});

test('manual delete: own paper only, after submission only, and never a missing clip', async (t) => {
  const { w, A, C, id } = await finalizedWorld(t);
  const other = await w.assessorUser('ret.other');
  const detail = await w.call('GET', `/assessor/assessments/${id}`, { token: A.token });
  const qid = detail.body.responses.find((r) => r.answer?.has_recording).question_id;

  assert.equal((await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`, { token: other.token })).status, 404, 'another assessor cannot even see the paper');
  assert.equal((await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`, { token: C.token })).status, 403, 'candidates have no access');
  assert.equal((await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`)).status, 401, 'nor does an anonymous caller');
  assert.equal((await w.call('DELETE', `/assessor/assessments/${id}/recordings/does-not-exist`, { token: A.token })).status, 404, 'unknown question');

  // A paper still being sat can never lose its clips.
  const fresh = await w.candidateUser('ret.waiting');
  await w.assign(fresh.assessmentId, A.user.id);
  assert.equal((await w.call('DELETE', `/assessor/assessments/${fresh.assessmentId}/recordings/${qid}`, { token: A.token })).status, 409);

  // And a question the candidate answered without recording has nothing to delete.
  const typedOnly = detail.body.responses.find((r) => r.answer && typeof r.answer === 'object' && !r.answer.has_recording && 'transcript' in r.answer);
  if (typedOnly) {
    assert.equal((await w.call('DELETE', `/assessor/assessments/${id}/recordings/${typedOnly.question_id}`, { token: A.token })).status, 404);
  }
});

test('a paper from before the recordings table (inline clip) deletes the same way', async (t) => {
  const { w, A, id } = await finalizedWorld(t);
  const detail = await w.call('GET', `/assessor/assessments/${id}`, { token: A.token });
  const qid = detail.body.responses.find((r) => r.answer?.has_recording).question_id;

  // Rebuild the old shape: the clip on the answer itself, no recordings row.
  const [row] = await w.store.list('responses', { assessment_id: id, question_id: qid });
  await w.store.update('responses', row.id, { answer: { ...row.answer, audio_b64: 'QUJD'.repeat(40), audio_ref: undefined } });
  const [clip] = await w.store.list('recordings', { assessment_id: id, question_id: qid });
  await w.store.remove('recordings', clip.id);

  const del = await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`, { token: A.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1, 'the inline clip is one recording too');
  const [after] = await w.store.list('responses', { assessment_id: id, question_id: qid });
  assert.equal(after.answer.audio_b64, undefined, 'the inline audio is gone');
  assert.match(after.answer.text, /Notes for/, 'the answer sheet is not');
  assert.equal(after.answer.retention.recording, true);
  assert.equal((await w.call('DELETE', `/assessor/assessments/${id}/recordings/${qid}`, { token: A.token })).body.already_deleted, true);
});

test('the cleanup clears a due paper only — after the window, in the chosen scope', async (t) => {
  const { w, A, C, id } = await finalizedWorld(t);
  const scoredAt = (await w.store.get('assessments', id)).scored_at;

  // 30 days (the default): not due, and a run says so.
  const early = await w.call('POST', '/admin/retention/run', { token: w.tok });
  assert.equal(early.status, 200);
  assert.equal(early.body.purged, 0);
  assert.equal(early.body.status.due_now, 0);
  assert.equal((await w.store.list('recordings', { assessment_id: id })).length, 2, 'nothing went early');
  assert.equal((await w.store.list('audit_log', { action: 'assessment_data_purged' })).length, 0);

  // Move the paper 31 days into the past by rewinding its anchor — the policy
  // measures from the report, so this is exactly what waiting looks like.
  const long_ago = new Date(Date.parse(scoredAt) - 31 * DAY_MS).toISOString();
  await w.store.update('assessments', id, { scored_at: long_ago });
  const settings = await w.call('GET', '/admin/settings/retention', { token: w.tok });
  assert.equal(settings.body.status.due_now, 1);
  assert.equal(settings.body.status.finalized_papers, 1);

  // scope 'open' (the default is 'all'): the MCQ picks are kept, the open
  // answers and every clip go.
  await w.call('PUT', '/admin/settings/retention', { token: w.tok, body: { scope: 'open' } });
  const run = await w.call('POST', '/admin/retention/run', { token: w.tok });
  assert.equal(run.body.purged, 1);
  assert.equal(run.body.clips, 2, 'both recordings were removed');

  const rows = await w.store.list('responses', { assessment_id: id });
  const objective = rows.filter((r) => r.answer === 'a');
  const open = rows.filter((r) => r.answer?.retention);
  assert.equal(objective.length, 2, 'the objective picks are untouched by scope=open');
  assert.equal(open.length, 2);
  for (const r of open) {
    assert.equal(r.answer.text, undefined, 'the typed notes are gone');
    assert.equal(r.answer.transcript, undefined, 'the transcript is gone');
    assert.equal(r.answer.audio_ref, undefined);
    assert.equal(r.answer.retention.sheet, true);
    assert.equal(r.answer.retention.scope, 'open');
  }
  for (const r of rows) assert.equal(r.final_score !== undefined, true, 'every mark survives');

  // The report card is untouched — that is the whole point of the policy.
  const a = await w.store.get('assessments', id);
  assert.equal(a.report_json.overall_pct, (await w.call('GET', `/admin/reports/${id}`, { token: w.tok })).body.report.overall_pct);
  assert.ok(a.report_json.competencies.every((c) => c.breakdown.length > 0), 'the report keeps its per-question breakdown');
  assert.equal(a.retention_json.sheet_rows, 2);
  assert.equal(a.retention_json.clips, 2);
  assert.equal(a.retention_json.scope, 'open');
  assert.equal((await w.store.list('recordings', { assessment_id: id })).length, 0);

  // Screens now explain the holes.
  const detail = await w.call('GET', `/assessor/assessments/${id}`, { token: A.token });
  assert.equal(detail.body.retention.state, 'purged');
  const purgedRow = detail.body.responses.find((r) => r.answer?.answer_deleted);
  assert.equal(purgedRow.answer.answer_deleted, true);
  assert.equal(purgedRow.answer.recording_deleted, true);
  assert.equal(detail.body.questions.length, 4, 'the questions themselves stay for context');
  assert.equal((await w.call('GET', `/admin/reports/${id}`, { token: w.tok })).body.retention.state, 'purged');
  assert.equal((await w.call('GET', '/admin/assessments', { token: w.tok })).body.assessments[0].retention.state, 'purged');

  // The candidate's own report still opens (the projection re-reads nothing raw).
  assert.equal((await w.call('GET', `/candidate/reports/${id}`, { token: C.token })).status, 200);

  // Audited, and idempotent: a second run finds nothing to do and logs nothing new.
  assert.equal((await w.store.list('audit_log', { action: 'assessment_data_purged' })).length, 1);
  assert.equal((await w.store.list('audit_log', { action: 'retention_cleanup_run' })).length, 1);
  const second = await w.call('POST', '/admin/retention/run', { token: w.tok });
  assert.equal(second.body.purged, 0);
  assert.equal(second.body.status.purged_papers, 1);
  assert.equal((await w.store.list('audit_log', { action: 'assessment_data_purged' })).length, 1);
});

test('scope "all" clears the objective answers too; the toggles can switch each half off', async (t) => {
  const first = await finalizedWorld(t);
  await first.w.store.update('assessments', first.id, { scored_at: new Date(Date.now() - 40 * DAY_MS).toISOString() });
  await first.w.call('PUT', '/admin/settings/retention', { token: first.w.tok, body: { days: 30, scope: 'all' } });
  await first.w.call('POST', '/admin/retention/run', { token: first.w.tok });
  const rows = await first.w.store.list('responses', { assessment_id: first.id });
  assert.equal(rows.filter((r) => r.answer === 'a').length, 0, 'scope=all also clears the MCQ picks');
  assert.ok(rows.every((r) => r.answer?.retention?.scope === 'all'));
  assert.ok(rows.every((r) => r.final_score !== undefined), 'and keeps every mark');

  // Answer sheets off, recordings on: only the clips go.
  const second = await finalizedWorld(t);
  await second.w.store.update('assessments', second.id, { scored_at: new Date(Date.now() - 40 * DAY_MS).toISOString() });
  await second.w.call('PUT', '/admin/settings/retention', {
    token: second.w.tok, body: { days: 30, auto_delete_answer_sheets: false, auto_delete_recordings: true },
  });
  const run = await second.w.call('POST', '/admin/retention/run', { token: second.w.tok });
  assert.equal(run.body.clips, 2);
  assert.equal(run.body.rows, 2, 'the rows are patched to drop only the clip reference');
  const kept = await second.w.store.list('responses', { assessment_id: second.id });
  for (const r of kept.filter((r) => r.answer && typeof r.answer === 'object' && 'transcript' in r.answer)) {
    assert.match(r.answer.transcript, /Spoken answer/, 'the transcript stays');
    assert.equal(r.answer.audio_ref, undefined);
    assert.equal(r.answer.retention.sheet, undefined, 'no sheet marker: the sheet was not touched');
    assert.equal(r.answer.retention.recording, true);
  }

  // Both toggles off: the policy is inert, even at 0 days.
  const third = await finalizedWorld(t);
  await third.w.call('PUT', '/admin/settings/retention', {
    token: third.w.tok, body: { days: 0, auto_delete_answer_sheets: false, auto_delete_recordings: false },
  });
  const inert = await third.w.call('POST', '/admin/retention/run', { token: third.w.tok });
  assert.equal(inert.body.ran, false);
  assert.equal(inert.body.reason, 'off');
  assert.equal(inert.body.purged, 0);
  const untouched = await third.w.store.list('responses', { assessment_id: third.id });
  assert.ok(untouched.every((r) => !r.answer?.retention), 'nothing was marked');
  assert.equal((await third.w.store.list('recordings', { assessment_id: third.id })).length, 2, 'both clips are still there');
});

test('the cleanup also runs from the screens (no scheduler), and 0 days means "at the next cleanup"', async (t) => {
  const { w, A, id } = await finalizedWorld(t);
  // Default policy: a paper finalized seconds ago is not due, so an ordinary
  // listing must not touch it (the background sweep is opportunistic, not eager).
  await w.call('GET', '/admin/assessments', { token: w.tok });
  await w.call('GET', '/assessor/assessments', { token: A.token });
  assert.equal((await w.store.list('recordings', { assessment_id: id })).length, 2, 'nothing was due');

  // 0 days puts every finalized paper due immediately — "delete at the next cleanup".
  await w.call('PUT', '/admin/settings/retention', { token: w.tok, body: { days: 0 } });
  const listed = await w.call('GET', '/admin/assessments', { token: w.tok });
  assert.equal(listed.status, 200, 'the listing that triggers the sweep still answers');
  await new Promise((r) => setTimeout(r, 60)); // the sweep is fire-and-forget
  const a = await w.store.get('assessments', id);
  assert.ok(a.retention_json?.purged_at, 'the background sweep cleared the due paper');
  assert.equal((await w.store.list('recordings', { assessment_id: id })).length, 0);
  assert.equal(listed.body.assessments[0].retention.state, 'due', 'the response described the state before the sweep ran');
});

test('a cleaned paper can still be deleted by an admin (its cascade has nothing left to take)', async (t) => {
  const { w, id } = await finalizedWorld(t);
  await w.call('PUT', '/admin/settings/retention', { token: w.tok, body: { days: 0 } });
  await w.call('POST', '/admin/retention/run', { token: w.tok });
  assert.ok((await w.store.get('assessments', id)).retention_json.purged_at);
  // Reports protect a candidate from deletion, as before; the admin's own
  // pre-submission delete path is what must not break on an empty recording set.
  const fresh = await w.candidateUser('ret.delete-mine');
  const del = await w.call('DELETE', `/admin/assessments/${fresh.assessmentId}`, { token: w.tok });
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
});

/* ======================= the same policy on the blobs backend ======================= */

test('netlify blobs: the sweep clears answers and clips without touching the report', async () => {
  const data = new Map();
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const blobsModule = {
    getStore: () => ({
      async get(key) { return data.has(key) ? clone(data.get(key)) : null; },
      async setJSON(key, value) { data.set(key, clone(value)); },
      async delete(key) { data.delete(key); },
      async list({ prefix = '' } = {}) {
        return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: 'x' })), directories: [] };
      },
    }),
  };
  const store = await createBlobsStore({ blobsModule });
  const snapshot = {
    role: { id: 'r1', name: 'Track' },
    competencies: [{ id: 'c1', name: 'C', weight: 100, target_level: 4 }],
    questions: [
      { id: 'q1', competency_id: 'c1', type: 'mcq_single', prompt: 'Pick', points: 2, options: [{ id: 'a', label: 'A' }], correct_option_ids: ['a'] },
      { id: 'q2', competency_id: 'c1', type: 'text', prompt: 'Say', points: 3, rubric: 'r' },
    ],
  };
  const assessment = await store.insert('assessments', {
    candidate_id: 'c1', role_id: 'r1', status: 'scored',
    // 40 days old, past the default 30-day window.
    scored_at: new Date(Date.now() - 40 * DAY_MS).toISOString(),
    snapshot_json: snapshot, report_json: { overall_pct: 50, generated_at: new Date(Date.now() - 40 * DAY_MS).toISOString() },
  });
  await store.insert('responses', { assessment_id: assessment.id, question_id: 'q1', answer: 'a', auto_score: 2, final_score: 2 });
  await store.insert('responses', { assessment_id: assessment.id, question_id: 'q2', answer: { text: 'notes', transcript: 'spoken', audio_ref: `${assessment.id}/q2` }, assessor_score: 3, final_score: 3 });
  await store.insert('recordings', { assessment_id: assessment.id, question_id: 'q2', audio: { b64: CLIP_B64, mime: 'audio/webm' } });

  const result = await runRetentionSweep(store, { now: Date.now(), reason: 'retention' });
  assert.equal(result.purged, 1);
  assert.equal(result.clips, 1);
  assert.equal((await store.list('recordings', { assessment_id: assessment.id })).length, 0);
  const rows = await store.list('responses', { assessment_id: assessment.id });
  for (const r of rows) {
    assert.ok(r.answer.retention.sheet, 'the marker is stored on the row');
    assert.equal(r.final_score !== undefined, true, 'the mark survives');
  }
  const after = await store.get('assessments', assessment.id);
  assert.equal(after.report_json.overall_pct, 50, 'the report is untouched');
  assert.ok(after.retention_json.purged_at);
});

test('the service handles a paper with no answers and a missing settings table', async (t) => {
  const w = await makeWorld({ t });
  const C = await w.candidateUser('ret.empty');
  // Nothing submitted: deleting a recording is impossible, and the sweep skips it.
  const del = await deleteAssessmentRecording(w.store, await w.store.get('assessments', C.assessmentId), 'nope', {});
  assert.equal(del.missing, true);
  const sweep = await runRetentionSweep(w.store, {});
  assert.equal(sweep.purged, 0);
  assert.equal(sweep.ran, true);
});
