import { DEFAULT_FRAMEWORK_CONFIG, STAGE_KEYS } from '../core/constants.mjs';
import { autoScore, isAutoQuestion, computeReport } from '../core/scoring.mjs';

/**
 * Immutable snapshot of role + competencies + questions + framework taken at
 * allocation time. In-flight assessments are therefore never affected by
 * later configuration edits.
 */
export async function buildSnapshot(store, roleId) {
  const role = await store.get('roles', roleId);
  if (!role || role.active === false) return null;
  const [competencies, questions, frameworks] = await Promise.all([
    store.list('competencies', { role_id: roleId }),
    store.list('questions', { role_id: roleId }),
    store.list('frameworks', { role_id: roleId }),
  ]);
  const framework = frameworks.find((f) => f.active !== false)
    || { name: 'ECOD Readiness Framework (default)', config: DEFAULT_FRAMEWORK_CONFIG, role_id: roleId };
  return JSON.parse(JSON.stringify({
    role,
    framework,
    competencies: competencies.filter((c) => c.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    questions: questions.filter((q) => q.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  }));
}

/** Auto-score every auto-scorable response of an assessment (called at submit). */
export async function autoScoreResponses(store, assessment) {
  const responses = await store.list('responses', { assessment_id: assessment.id });
  const byQid = new Map(responses.map((r) => [r.question_id, r]));
  for (const q of assessment.snapshot_json.questions) {
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

  for (const q of assessment.snapshot_json.questions) {
    const r = byQid.get(q.id);
    if (isAutoQuestion(q)) {
      const score = r?.auto_score ?? autoScore(q, r?.answer) ?? 0;
      finalByQid[q.id] = { ...(r || { question_id: q.id, answer: null }), final_score: score };
      if (r) await store.update('responses', r.id, { final_score: score });
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

  const report = computeReport(assessment.snapshot_json, finalByQid);
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
