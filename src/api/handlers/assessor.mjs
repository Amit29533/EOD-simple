import { ok, bad, notFound, conflict, unprocessable, audit, num, str } from '../helpers.mjs';
import { candidateForAssessor } from '../projections.mjs';
import { isManualQuestion, isAutoQuestion, autoScore } from '../../core/scoring.mjs';
import { finalizeScoring } from '../assessment-service.mjs';

const R = ['assessor'];

/** Load an assessment only if it belongs to the signed-in assessor (404 hides existence). */
async function own(store, assessorId, assessmentId) {
  const a = await store.get('assessments', assessmentId);
  return a && a.assessor_id === assessorId ? a : null;
}

export function assessorHandlers(route) {
  route('GET', '/assessor/assessments', R, async ({ store, auth }) => {
    const rows = await store.list('assessments', { assessor_id: auth.user.id });
    const candidates = await store.list('candidates');
    const cmap = Object.fromEntries(candidates.map((c) => [c.id, c]));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ok({
      assessments: rows.map((a) => ({
        id: a.id, status: a.status, created_at: a.created_at, submitted_at: a.submitted_at,
        scored_at: a.scored_at, overall_pct: a.overall_pct, readiness_label: a.readiness_label,
        role_name: a.snapshot_json?.role?.name || 'Assessment',
        question_count: (a.snapshot_json?.questions || []).length,
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
    const manualTotal = a.snapshot_json.questions.filter(isManualQuestion).length;
    const manualScored = responses.filter((r) => r.assessor_score !== undefined && r.assessor_score !== null).length;
    return ok({
      assessment: {
        id: a.id, status: a.status, submitted_at: a.submitted_at, scored_at: a.scored_at,
        overall_pct: a.overall_pct, readiness_label: a.readiness_label,
        role: a.snapshot_json.role,
      },
      candidate: candidateForAssessor(candidate),
      competencies: a.snapshot_json.competencies,
      questions: a.snapshot_json.questions, // full: includes rubric + correct answers (assessor-only)
      responses: responses.map((r) => {
        const q = a.snapshot_json.questions.find((x) => x.id === r.question_id);
        const live = q && isAutoQuestion(q) ? (autoScore(q, r.answer) ?? 0) : r.auto_score;
        return {
          question_id: r.question_id, answer: r.answer,
          auto_score: live, assessor_score: r.assessor_score, assessor_comment: r.assessor_comment || '',
        };
      }),
      scoring_progress: { manual_total: manualTotal, manual_scored: manualScored },
      // after finalization, the assessor may review the report they produced
      report: ['scored', 'validated'].includes(a.status) ? a.report_json : null,
    });
  });

  route('PUT', '/assessor/assessments/:id/scores', R, async ({ store, auth, params, body }) => {
    const a = await own(store, auth.user.id, params.id);
    if (!a) return notFound('Assessment not found.');
    if (a.status !== 'submitted') return conflict('Scores can only be entered after submission and before finalization.');
    const entries = Array.isArray(body.scores) ? body.scores : [];
    if (!entries.length) return bad('Nothing to save.');
    const responses = await store.list('responses', { assessment_id: a.id });
    const byQid = new Map(responses.map((r) => [r.question_id, r]));
    const qById = new Map(a.snapshot_json.questions.map((q) => [q.id, q]));
    for (const e of entries) {
      const q = qById.get(e.question_id);
      if (!q) continue;
      const patch = {};
      if (isManualQuestion(q) && e.score !== undefined && e.score !== null && e.score !== '') {
        const score = num(e.score, NaN);
        if (Number.isNaN(score) || score < 0 || score > Number(q.points ?? 1))
          return unprocessable(`Score for "${q.prompt.slice(0, 60)}..." must be 0-${q.points ?? 1}.`);
        patch.assessor_score = score;
      }
      if (e.comment !== undefined) patch.assessor_comment = str(e.comment, 1500);
      const existing = byQid.get(e.question_id);
      if (existing) await store.update('responses', existing.id, patch);
      else await store.insert('responses', { assessment_id: a.id, question_id: e.question_id, answer: null, ...patch });
    }
    return ok({ ok: true });
  });

  route('POST', '/assessor/assessments/:id/finalize', R, async ({ store, auth, params }) => {
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
  });
}
