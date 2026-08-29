/**
 * Pure scoring & gap-mapping engine. No I/O - fully unit-testable and
 * reusable if the storage backend changes. All inputs come from the
 * assessment *snapshot* (immutable copy of role/competencies/questions/framework).
 */

export const isManualQuestion = (q) => q.type === 'text';
export const isAutoQuestion = (q) => !isManualQuestion(q);

/** Coerce stored answers (string, array, or {ids}) into option-id strings. */
export function optionIds(answer) {
  if (Array.isArray(answer)) return answer.map(String).filter(Boolean);
  if (typeof answer === 'string' && answer.trim()) return [answer.trim()];
  if (answer && typeof answer === 'object' && Array.isArray(answer.ids)) {
    return answer.ids.map(String).filter(Boolean);
  }
  return [];
}

/**
 * Auto-score an answer for an auto-scorable question.
 * Returns null for manually scored (open text) questions.
 *  - mcq_single: full points iff the selected option is the correct one.
 *  - mcq_multi : proportional credit. Each correct pick earns points/|correct|;
 *                each incorrect pick subtracts the same unit (floor 0).
 *  - scale     : (value / 5) * points, self-reported proficiency.
 */
export function autoScore(question, answer) {
  const points = Number(question.points ?? 1);
  switch (question.type) {
    case 'mcq_single': {
      const correct = String((question.correct_option_ids || [])[0] ?? '');
      const picked = optionIds(answer)[0];
      return picked && correct && picked === correct ? points : 0;
    }
    case 'mcq_multi': {
      const correct = new Set((question.correct_option_ids || []).map(String));
      if (!correct.size) return 0;
      const selected = optionIds(answer);
      let hits = 0;
      let wrong = 0;
      for (const id of new Set(selected)) {
        if (correct.has(id)) hits += 1;
        else wrong += 1;
      }
      const ratio = Math.max(0, (hits - wrong) / correct.size);
      return Math.round(points * ratio * 100) / 100;
    }
    case 'scale': {
      const v = Number(answer);
      if (!Number.isFinite(v) || v < 1 || v > 5) return 0;
      return Math.round((v / 5) * points * 100) / 100;
    }
    default:
      return null; // manual
  }
}

/** Map a percentage to a capability level 1..5 using framework thresholds. */
export function pctToLevel(pct, thresholds = [0, 20, 40, 60, 80]) {
  let level = 0;
  for (const t of thresholds) if (pct >= t) level += 1;
  return Math.max(1, level);
}

/** Readiness band for an overall percentage, from framework config. */
export function readinessBand(overallPct, config) {
  const bands = [...(config.readiness_bands || [])].sort((a, b) => b.min - a.min);
  return bands.find((b) => overallPct >= b.min) || bands[bands.length - 1] || null;
}

/**
 * Compute the full capability report for an assessment.
 *  snapshot: { role, framework:{config}, competencies[], questions[] }
 *  responsesByQid: { [question_id]: { final_score, auto_score, assessor_score, assessor_comment, answer } }
 * Uses final_score (auto for auto questions, assessor for manual) - call after finalization.
 */
export function computeReport(snapshot, responsesByQid) {
  const config = snapshot.framework?.config || {};
  const severity = config.gap_severity || { moderate: 1, critical: 2 };
  const comps = (snapshot.competencies || []).filter((c) => c.active !== false);

  const perCompetency = comps.map((comp) => {
    const qs = (snapshot.questions || []).filter(
      (q) => q.competency_id === comp.id && q.active !== false
    );
    let earned = 0;
    let max = 0;
    const breakdown = qs.map((q) => {
      const points = Number(q.points ?? 1);
      max += points;
      const r = responsesByQid[q.id];
      const score = r ? Number(r.final_score ?? r.auto_score ?? r.assessor_score ?? 0) : 0;
      earned += score;
      return {
        question_id: q.id,
        prompt: q.prompt,
        type: q.type,
        difficulty: q.difficulty,
        points,
        score,
        scored_by: q.type === 'text' ? 'assessor' : 'auto',
        assessor_comment: r?.assessor_comment || '',
      };
    });
    const score_pct = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;
    const observed_level = pctToLevel(score_pct, config.level_thresholds);
    const target_level = Number(comp.target_level ?? 4);
    const gap = target_level - observed_level;
    let status = 'met';
    if (gap >= (severity.critical ?? 2)) status = 'critical_gap';
    else if (gap >= (severity.moderate ?? 1)) status = 'moderate_gap';
    else if (gap < 0) status = 'strength';
    return {
      competency_id: comp.id,
      name: comp.name,
      category: comp.category || '',
      description: comp.description || '',
      weight: Number(comp.weight ?? 0),
      target_level,
      observed_level,
      gap,
      status,
      score_pct,
      earned: Math.round(earned * 100) / 100,
      max,
      recommended_focus: comp.enrichment_hint || comp.description || '',
      breakdown,
    };
  });

  const weightTotal = perCompetency.reduce((s, c) => s + c.weight, 0) || 1;
  const overall_pct =
    Math.round(
      (perCompetency.reduce((s, c) => s + c.score_pct * c.weight, 0) / weightTotal) * 10
    ) / 10;
  const band = readinessBand(overall_pct, config);

  const gaps = perCompetency
    .filter((c) => c.gap > 0)
    .sort((a, b) => b.gap - a.gap || b.weight - a.weight)
    .map((c) => ({
      competency_id: c.competency_id,
      competency: c.name,
      score_pct: c.score_pct,
      observed_level: c.observed_level,
      target_level: c.target_level,
      gap: c.gap,
      severity: c.status,
      weight: c.weight,
      recommended_focus: c.recommended_focus,
    }));

  const strengths = perCompetency
    .filter((c) => c.gap <= 0)
    .sort((a, b) => b.score_pct - a.score_pct)
    .map((c) => ({
      competency: c.name,
      score_pct: c.score_pct,
      observed_level: c.observed_level,
      target_level: c.target_level,
    }));

  return {
    role: snapshot.role ? { id: snapshot.role.id, name: snapshot.role.name, key: snapshot.role.key } : null,
    framework_name: snapshot.framework?.name || 'ECOD Readiness Framework',
    overall_pct,
    band: band ? { key: band.key, label: band.label, tone: band.tone, description: band.description } : null,
    competencies: perCompetency,
    areas_to_improve: gaps,
    strengths,
    generated_at: new Date().toISOString(),
  };
}

/** Validate a framework config. Returns an array of human-readable problems (empty = valid). */
export function validateFrameworkConfig(config) {
  const problems = [];
  const bands = config?.readiness_bands;
  if (!Array.isArray(bands) || bands.length < 2) {
    problems.push('At least two readiness bands are required.');
  } else {
    for (const b of bands) {
      if (!b.key || !b.label) problems.push('Every band needs a key and a label.');
      if (!Number.isFinite(Number(b.min)) || b.min < 0 || b.min > 100)
        problems.push(`Band "${b.label || b.key}" min must be between 0 and 100.`);
    }
  }
  const lt = config?.level_thresholds;
  if (!Array.isArray(lt) || lt.length !== 5 || lt.some((v) => !Number.isFinite(Number(v)))) {
    problems.push('Level thresholds must be exactly 5 numbers.');
  } else {
    const sorted = [...lt].every((v, i, a) => i === 0 || Number(v) > Number(a[i - 1]));
    if (!sorted || Number(lt[0]) !== 0 || Math.max(...lt.map(Number)) > 100)
      problems.push('Level thresholds must be ascending, start at 0, and not exceed 100.');
  }
  const gs = config?.gap_severity;
  if (!gs || !(Number(gs.moderate) >= 1) || Number(gs.critical) <= Number(gs.moderate))
    problems.push('Gap severity must have critical > moderate >= 1.');
  return problems;
}
