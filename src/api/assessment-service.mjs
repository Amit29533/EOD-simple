import { DEFAULT_FRAMEWORK_CONFIG, STAGE_KEYS, MAX_ASSESSMENT_QUESTIONS } from '../core/constants.mjs';
import { autoScore, isAutoQuestion, computeReport } from '../core/scoring.mjs';
import { selectQuestions, dedupeQuestions } from '../core/question-selection.mjs';
import { sortedQuestions } from './quiz-session.mjs';
import { applySpokenContract } from './catalogue-service.mjs';

/**
 * The active question bank for a role, in display order, with its competencies.
 * Shared by the snapshot builder and the allocation preview endpoint so the
 * admin UI always previews exactly what allocation will produce.
 */
export async function roleBank(store, roleId) {
  const role = await store.get('roles', roleId);
  if (!role || role.active === false) return null;
  const [competencies, questions, frameworks] = await Promise.all([
    store.list('competencies', { role_id: roleId }),
    store.list('questions', { role_id: roleId }),
    store.list('frameworks', { role_id: roleId }),
  ]);
  const framework = frameworks.find((f) => f.active !== false)
    || { name: 'ECOD Readiness Framework (default)', config: DEFAULT_FRAMEWORK_CONFIG, role_id: roleId };
  return {
    role,
    framework,
    competencies: competencies.filter((c) => c.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    questions: applySpokenContract(dedupeQuestions(questions.filter((q) => q.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)))),
  };
}

/**
 * Immutable snapshot of role + competencies + questions + framework taken at
 * allocation time. In-flight assessments are therefore never affected by
 * later configuration edits.
 *
 * `questionLimit` (optional) caps the assessment at X questions, spread across
 * competencies in proportion to their weight (see core/question-selection.mjs).
 * The snapshot only ever contains the questions actually served, so scoring,
 * gap mapping and the report card all operate on the served set.
 */
export async function buildSnapshot(store, roleId, { questionLimit = null } = {}) {
  const bank = await roleBank(store, roleId);
  if (!bank) return null;
  // The HTTP handler validates this input, but keep the service boundary safe
  // for other callers too. A direct snapshot build can never freeze more than
  // the supported capped-allocation size into an assessment.
  const requested = Number(questionLimit);
  const normalizedLimit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_ASSESSMENT_QUESTIONS)
    : null;
  const served = selectQuestions(bank.questions, bank.competencies, normalizedLimit, {
    randomize: normalizedLimit !== null && normalizedLimit < bank.questions.length,
  });
  return JSON.parse(JSON.stringify({
    role: bank.role,
    framework: bank.framework,
    competencies: bank.competencies,
    questions: served,
    question_limit: normalizedLimit,
    bank_total: bank.questions.length,
  }));
}

/** Auto-score every auto-scorable response of an assessment (called at submit). */
export async function autoScoreResponses(store, assessment) {
  const responses = await store.list('responses', { assessment_id: assessment.id });
  const byQid = new Map(responses.map((r) => [r.question_id, r]));
  for (const q of sortedQuestions(assessment.snapshot_json)) {
    if (!isAutoQuestion(q)) continue;
    const r = byQid.get(q.id);
    if (!r) continue;
    await store.update('responses', r.id, { auto_score: autoScore(q, r.answer) ?? 0 });
  }
}

/** Move a candidate's pipeline stage forward, never backwards. */
export async function advanceStage(store, candidateId, targetStage) {
  const candidate = await store.get('candidates', candidateId);
  if (!candidate) return;
  const cur = STAGE_KEYS.indexOf(candidate.stage || 'intake');
  const next = STAGE_KEYS.indexOf(targetStage);
  if (next > cur) await store.update('candidates', candidateId, { stage: targetStage });
  else if (cur === -1) await store.update('candidates', candidateId, { stage: targetStage });
}

/**
 * Finalize scoring: every manual question must have an assessor score.
 * Computes final scores, builds the report, marks the assessment scored and
 * advances the candidate to Gap Mapping.
 */
export async function finalizeScoring(store, assessment) {
  const responses = await store.list('responses', { assessment_id: assessment.id });
  const byQid = new Map(responses.map((r) => [r.question_id, r]));
  const missingScores = [];
  const finalByQid = {};
  // Score the de-duplicated served set so old snapshots that were built before
  // duplicate protection never double-count a question in the report.
  const questions = sortedQuestions(assessment.snapshot_json);

  for (const q of questions) {
    const r = byQid.get(q.id);
    if (isAutoQuestion(q)) {
      const score = autoScore(q, r?.answer) ?? 0;
      finalByQid[q.id] = { ...(r || { question_id: q.id, answer: null }), auto_score: score, final_score: score };
      if (r) await store.update('responses', r.id, { auto_score: score, final_score: score });
    } else {
      const score = r?.assessor_score;
      if (score === undefined || score === null || Number.isNaN(Number(score))) {
        missingScores.push({ question_id: q.id, prompt: q.prompt });
      } else {
        finalByQid[q.id] = { ...r, final_score: Number(score) };
        await store.update('responses', r.id, { final_score: Number(score) });
      }
    }
  }
  if (missingScores.length) return { missing: missingScores };

  const report = computeReport({ ...assessment.snapshot_json, questions }, finalByQid);
  const updated = await store.update('assessments', assessment.id, {
    status: 'scored',
    scored_at: new Date().toISOString(),
    overall_pct: report.overall_pct,
    readiness_key: report.band?.key || '',
    readiness_label: report.band?.label || '',
    report_json: report,
  });
  await advanceStage(store, assessment.candidate_id, 'gap_mapping');
  return { report, assessment: updated };
}
