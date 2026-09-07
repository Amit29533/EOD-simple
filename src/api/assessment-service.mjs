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
  return snapshotFromBank(bank, questionLimit);
}

/**
 * Freeze a snapshot from an already-loaded bank (a `roleBank()` result).
 *
 * `buildSnapshot` is this plus the load; the bulk auto-allocation path loads
 * each track's bank once and then freezes one snapshot per candidate from the
 * cached copy, so a 2000-row onboarding does not re-read the bank 2000 times.
 * Both paths freeze identical papers because they share this function.
 */
export function snapshotFromBank(bank, questionLimit = null) {
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

/**
 * The cap an automatic allocation should request for a bank of `bankTotal`
 * questions: `questionCount` (default 50), except a bank smaller than the ask
 * serves its full bank instead of failing. Returns the `questionLimit` to
 * freeze — null means "the whole bank".
 */
export function autoQuestionLimit(bankTotal, questionCount = MAX_ASSESSMENT_QUESTIONS) {
  const want = Number(questionCount);
  const n = Number.isInteger(want) && want > 0
    ? Math.min(want, MAX_ASSESSMENT_QUESTIONS)
    : MAX_ASSESSMENT_QUESTIONS;
  return n < bankTotal ? n : null;
}

/**
 * Which track an automatic allocation serves: an explicit role id first, then
 * the candidate's own target track, then the workspace default — the first
 * active track by name (single-track workspaces have exactly one).
 *
 * Returns `{ role }` or `{ role: null, reason }` explaining why no track
 * could be chosen. A candidate whose target track was deactivated or deleted
 * is *not* silently moved onto another track — the reason says so.
 */
export async function resolveAutoRole(store, candidate, roleId = null) {
  if (roleId) {
    const role = await store.get('roles', roleId);
    if (!role || role.active === false) return { role: null, reason: 'The selected assessment track is not available.' };
    return { role };
  }
  if (candidate?.target_role_id) {
    const role = await store.get('roles', candidate.target_role_id);
    if (!role || role.active === false) {
      return { role: null, reason: `“${candidate.name}” targets a track that is no longer available — pick a track and allocate manually.` };
    }
    return { role };
  }
  const actives = (await store.list('roles'))
    .filter((r) => r.active !== false)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (!actives.length) return { role: null, reason: 'No active assessment track exists yet — create one with questions first.' };
  return { role: actives[0] };
}

/**
 * Allocate the default assessment for a freshly provisioned candidate user.
 *
 * Every user created with the candidate role gets a 50-question assessment
 * (or the track's full bank when it holds fewer than 50) without an admin
 * having to open the Allocate dialog per candidate. The assessor is left
 * unassigned so the admin can distribute scoring later via Reassign.
 *
 * Best-effort by design: it returns `{ allocated: false, reason }` instead of
 * throwing, so user provisioning can never fail because allocation did.
 * Callers surface `reason` to explain a skip (no track, empty bank, or an
 * open assessment already exists for that candidate and track).
 */
export async function autoAllocateAssessment(store, candidate, {
  actor = null, roleId = null, assessorId = null, questionCount = MAX_ASSESSMENT_QUESTIONS,
  auditFn = null,
} = {}) {
  const fail = (reason, extra = {}) => ({ allocated: false, reason, ...extra });
  if (!candidate) return fail('Candidate record not found.');

  const { role, reason } = await resolveAutoRole(store, candidate, roleId);
  if (!role) return fail(reason);

  let assessor_id = null;
  if (assessorId) {
    const assessor = await store.get('users', assessorId);
    if (assessor && assessor.role === 'assessor' && assessor.active !== false) assessor_id = assessor.id;
  }

  const open = (await store.list('assessments', { candidate_id: candidate.id }))
    .find((a) => a.role_id === role.id && ['assigned', 'in_progress', 'submitted'].includes(a.status));
  if (open) {
    return fail(`“${candidate.name}” already has an open ${role.name} assessment.`,
      { role, assessment_id: open.id });
  }

  const bank = await roleBank(store, role.id);
  if (!bank?.questions.length) {
    return fail(`“${role.name}” has no active questions yet — add questions, then allocate manually.`, { role });
  }
  const snapshot = snapshotFromBank(bank, autoQuestionLimit(bank.questions.length, questionCount));
  if (!snapshot.questions.length) {
    return fail(`“${role.name}” has no active questions yet — add questions, then allocate manually.`, { role });
  }

  const rec = await store.insert('assessments', {
    candidate_id: candidate.id, role_id: role.id, assessor_id,
    status: 'assigned', snapshot_json: snapshot, report_json: null,
    question_count: snapshot.questions.length,
    overall_pct: null, readiness_key: '', readiness_label: '', created_by: actor?.id || null,
  });
  if (!candidate.target_role_id) {
    await store.update('candidates', candidate.id, { target_role_id: role.id });
  }
  await advanceStage(store, candidate.id, 'assessment');
  const scope = snapshot.question_limit
    ? `${snapshot.questions.length} of ${snapshot.bank_total} questions`
    : `all ${snapshot.questions.length} questions`;
  if (typeof auditFn === 'function') {
    await auditFn('assessment_allocated', 'assessments', rec.id,
      `Assessment auto-allocated to “${candidate.name}” (${scope} · ${role.name})${assessor_id ? '' : ' — assessor to be assigned'}`);
  }
  return { allocated: true, assessment: rec, role, question_count: snapshot.questions.length };
}

/**
 * Plan one automatic allocation per accepted bulk-import row.
 *
 * The commit path needs the snapshots *before* it writes the candidates, so
 * freshly imported rows land with the right target track and pipeline stage
 * in the same batched write instead of needing a per-row update afterwards.
 * Dry runs reuse the same plan for their counts, so the preview and the
 * commit can never disagree.
 *
 * `accepted` is the validator's `[{ candidate }]` rows; each plan is aligned
 * by index: `{ ok, role, snapshot, question_count }` or `{ ok: false, reason }`.
 * Track banks are loaded once and shared across every row on that track.
 */
export async function planBulkAutoAllocation(store, accepted = [], { roles = [], questionCount = MAX_ASSESSMENT_QUESTIONS } = {}) {
  const byId = new Map((roles || []).map((r) => [r.id, r]));
  const fallback = [...(roles || [])]
    .filter((r) => r.active !== false)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))[0] || null;
  const banks = new Map();
  const bankFor = async (role) => {
    if (!banks.has(role.id)) banks.set(role.id, await roleBank(store, role.id));
    return banks.get(role.id);
  };

  const plans = [];
  for (const { candidate } of accepted) {
    let role = candidate?.target_role_id ? byId.get(candidate.target_role_id) || null : null;
    if (role && role.active === false) role = null;
    if (!candidate?.target_role_id) role = role || fallback;
    if (!role) {
      plans.push({
        ok: false,
        reason: candidate?.target_role_id
          ? 'Target track is not available.'
          : 'No target track and no active track to default to.',
      });
      continue;
    }
    const bank = await bankFor(role);
    if (!bank?.questions.length) {
      plans.push({ ok: false, role, reason: `“${role.name}” has no active questions yet.` });
      continue;
    }
    const snapshot = snapshotFromBank(bank, autoQuestionLimit(bank.questions.length, questionCount));
    if (!snapshot.questions.length) {
      plans.push({ ok: false, role, reason: `“${role.name}” has no active questions yet.` });
      continue;
    }
    plans.push({ ok: true, role, snapshot, question_count: snapshot.questions.length });
  }
  return plans;
}

// NOTE: auto-scoring is NOT performed here. The submit handler
// (POST /candidate/assessments/:id/submit) scores each answer as it persists
// it, and finalizeScoring below re-scores from the snapshot at finalize time.
// A third copy of that logic used to live here, unused, documented as "called
// at submit" — which it never was.

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
