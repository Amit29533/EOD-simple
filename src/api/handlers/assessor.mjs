import {
  ok, bad, notFound, conflict, unprocessable, audit, num, str, isTextish, bulkInsert, bulkUpdate,
} from '../helpers.mjs';
import { candidateForAssessor } from '../projections.mjs';
import { isManualQuestion, isAutoQuestion, autoScore } from '../../core/scoring.mjs';
import { finalizeScoring, paperFacts } from '../assessment-service.mjs';
import { sortedQuestions } from '../quiz-session.mjs';
import { withLock } from '../mutex.mjs';

const R = ['assessor'];

// Scoring and finalization share one assessment's lock with each other (and
// with the candidate-side mutations in candidate.mjs): a score landing
// mid-finalize, or two finalizes at once, must serialize, not interleave.
const locked = (fn) => async (ctx) => withLock(`assessment:${ctx.params.id}`, () => fn(ctx));

/** Load an assessment only if it belongs to the signed-in assessor (404 hides existence). */
async function own(store, assessorId, assessmentId) {
  const a = await store.get('assessments', assessmentId);
  return a && a.assessor_id === assessorId ? a : null;
}

/**
 * An answer as the detail view carries it: the recording itself stays out.
 * A whole-bank paper holds 33 spoken answers of ~320,000 base64 characters
 * each — inline, the detail payload was ~10 MB, past a serverless function's
 * 6 MB response cap, so a full paper could not be opened on Netlify at all.
 * `has_recording` tells the UI to fetch the clip from
 * `GET …/recordings/:question_id` when the answer is on screen.
 */
function answerForDetail(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const { audio_b64, audio_ref, ...rest } = answer;
  return { ...rest, has_recording: Boolean(audio_ref || audio_b64) };
}

export function assessorHandlers(route) {
  route('GET', '/assessor/assessments', R, async ({ store, auth }) => {
    const rows = await store.list('assessments', { assessor_id: auth.user.id }, { detached: false });
    const candidates = await store.list('candidates');
    const cmap = Object.fromEntries(candidates.map((c) => [c.id, c]));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const facts = await paperFacts(store, rows);
    return ok({
      assessments: rows.map((a, i) => ({
        id: a.id, status: a.status, created_at: a.created_at, submitted_at: a.submitted_at,
        scored_at: a.scored_at, overall_pct: a.overall_pct,
        readiness_key: a.readiness_key, readiness_label: a.readiness_label,
        role_name: facts[i].role_name || 'Assessment',
        question_count: facts[i].question_count,
        candidate: candidateForAssessor(cmap[a.candidate_id]),
      })),
    });
  });

  route('GET', '/assessor/assessments/:id', R, async ({ store, auth, params }) => {
    const a = await own(store, auth.user.id, params.id);
    if (!a) return notFound('Assessment not found.');
    if (['assigned', 'in_progress'].includes(a.status))
      return conflict('The candidate has not submitted this assessment yet.');
    const candidate = await store.get('candidates', a.candidate_id);
    const responses = await store.list('responses', { assessment_id: a.id });
    const questions = sortedQuestions(a.snapshot_json);
    // Look responses up against the DE-DUPLICATED served set (sortedQuestions),
    // exactly as scoring does, and in O(1) per response rather than O(n²).
    const qById = new Map(questions.map((q) => [q.id, q]));
    const manualTotal = questions.filter(isManualQuestion).length;
    const manualScored = responses.filter((r) => r.assessor_score !== undefined && r.assessor_score !== null).length;
    return ok({
      assessment: {
        id: a.id, status: a.status, submitted_at: a.submitted_at, scored_at: a.scored_at,
        overall_pct: a.overall_pct, readiness_key: a.readiness_key, readiness_label: a.readiness_label,
        role: a.snapshot_json.role,
      },
      candidate: candidateForAssessor(candidate),
      competencies: a.snapshot_json.competencies,
      questions, // full: includes rubric + correct answers (assessor-only)
      responses: responses.map((r) => {
        const q = qById.get(r.question_id);
        const live = q && isAutoQuestion(q) ? (autoScore(q, r.answer) ?? 0) : r.auto_score;
        return {
          question_id: r.question_id, answer: answerForDetail(r.answer),
          auto_score: live, assessor_score: r.assessor_score, assessor_comment: r.assessor_comment || '',
        };
      }),
      scoring_progress: { manual_total: manualTotal, manual_scored: manualScored },
      // after finalization, the assessor may review the report they produced
      report: ['scored', 'validated'].includes(a.status) ? a.report_json : null,
    });
  });

  /**
   * One recorded answer, fetched on demand by the detail view. Same ownership
   * and status rules as the detail itself. A paper stored before recordings
   * had their own table still carries the clip on the response row, and is
   * served from there.
   */
  route('GET', '/assessor/assessments/:id/recordings/:question_id', R, async ({ store, auth, params }) => {
    const a = await own(store, auth.user.id, params.id);
    if (!a) return notFound('Assessment not found.');
    if (['assigned', 'in_progress'].includes(a.status))
      return conflict('The candidate has not submitted this assessment yet.');
    const qid = String(params.question_id || '');
    const [rec] = await store.list('recordings', { assessment_id: a.id, question_id: qid });
    if (rec?.audio?.b64) return ok({ question_id: qid, audio_b64: rec.audio.b64, audio_mime: rec.audio.mime || 'audio/webm' });
    const [row] = await store.list('responses', { assessment_id: a.id, question_id: qid });
    const inline = row?.answer && typeof row.answer === 'object' ? row.answer : null;
    if (inline?.audio_b64) return ok({ question_id: qid, audio_b64: inline.audio_b64, audio_mime: inline.audio_mime || 'audio/webm' });
    return notFound('No recording for this question.');
  });

  route('PUT', '/assessor/assessments/:id/scores', R, locked(async ({ store, auth, params, body }) => {
    const a = await own(store, auth.user.id, params.id);
    if (!a) return notFound('Assessment not found.');
    if (a.status !== 'submitted') return conflict('Scores can only be entered after submission and before finalization.');
    const entries = Array.isArray(body.scores) ? body.scores : [];
    if (!entries.length) return bad('Nothing to save.');
    const responses = await store.list('responses', { assessment_id: a.id });
    const byQid = new Map(responses.map((r) => [r.question_id, r]));
    // Score against the served (de-duplicated) set, as the detail view and
    // finalizeScoring do, so a legacy duplicate row can never accept a score
    // that finalization then ignores.
    const qById = new Map(sortedQuestions(a.snapshot_json).map((q) => [q.id, q]));
    const updates = [];
    const inserts = [];
    for (const e of entries) {
      // A null (or otherwise non-object) entry used to throw a TypeError on
      // `.question_id` and 500 the endpoint; it is malformed input instead.
      if (!e || typeof e !== 'object' || Array.isArray(e))
        return bad('Each score entry must be an object with a question_id.');
      const q = qById.get(e.question_id);
      if (!q) continue;
      const patch = {};
      if (isManualQuestion(q) && e.score !== undefined) {
        if (e.score === null || e.score === '') {
          // An explicit blank clears a score that was entered by mistake. The
          // entry used to be ignored, so the assessor's screen showed the
          // question as unscored while the stored score still counted at
          // finalization.
          patch.assessor_score = null;
        } else {
          // A score is a number (or the numeric string a form posts). `num()`
          // alone also coerced `true` → 1, `[2]` → 2, `"0x2"` → 2 into stored
          // marks: refuse anything that is not plainly numeric.
          const plain = typeof e.score === 'number'
            || (typeof e.score === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(e.score));
          const score = plain ? num(e.score, NaN) : NaN;
          if (Number.isNaN(score) || score < 0 || score > Number(q.points ?? 1))
            return unprocessable(`Score for "${q.prompt.slice(0, 60)}..." must be a number, 0-${q.points ?? 1}.`);
          patch.assessor_score = Math.round(score * 100) / 100;
        }
      }
      if (e.comment !== undefined) {
        if (!isTextish(e.comment)) return bad('Score comments must be plain text.');
        patch.assessor_comment = str(e.comment, 1500);
      }
      const existing = byQid.get(e.question_id);
      // Batched, like the candidate's submit: scoring a 30-question open set
      // used to be 30 whole-table rewrites on the file/blob adapters. An entry
      // carrying neither a score nor a comment has nothing to store.
      if (existing) {
        if (Object.keys(patch).length) updates.push({ id: existing.id, patch });
      } else {
        inserts.push({ assessment_id: a.id, question_id: e.question_id, answer: null, ...patch });
      }
    }
    await bulkUpdate(store, 'responses', updates);
    await bulkInsert(store, 'responses', inserts);
    return ok({ ok: true });
  }));

  route('POST', '/assessor/assessments/:id/finalize', R, locked(async ({ store, auth, params }) => {
    const a = await own(store, auth.user.id, params.id);
    if (!a) return notFound('Assessment not found.');
    if (a.status !== 'submitted') return conflict('Assessment is not awaiting scoring.');
    const result = await finalizeScoring(store, a);
    if (result.missing) return unprocessable('Some open questions have not been scored yet.', { missing: result.missing });
    const candidate = await store.get('candidates', a.candidate_id);
    await audit(store, auth.user, 'assessment_scored', 'assessments', a.id,
      `Assessment finalized for "${candidate?.name}" - ${result.report.band?.label} (${result.report.overall_pct}%)`);
    return ok({
      report: result.report,
      assessment_id: a.id,
      status: 'scored',
      candidate: candidateForAssessor(candidate),
    });
  }));
}
