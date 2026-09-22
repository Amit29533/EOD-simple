/**
 * Pure scoring & gap-mapping engine. No I/O - fully unit-testable and
 * reusable if the storage backend changes. All inputs come from the
 * assessment *snapshot* (immutable copy of role/competencies/questions/framework).
 */

export const isManualQuestion = (q) => q.type === 'text';
export const isAutoQuestion = (q) => !isManualQuestion(q);

/** Unique, stringified option ids (empty strings dropped). */
function optionIdSet(ids) {
  return new Set((ids || []).map(String).filter(Boolean));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Coerce stored answers (string, number, array, or {ids}) into unique
 * option-id strings. Option ids are compared as strings everywhere else —
 * the answer validator accepts a numeric id for a single-choice question
 * and the assessor view renders it as the picked option — so the scorer
 * must see `2` and `'2'` as the same pick, not score the number as wrong.
 */
export function optionIds(answer) {
  if (Array.isArray(answer)) return [...optionIdSet(answer)];
  if (typeof answer === 'number' && Number.isFinite(answer)) return [String(answer)];
  if (typeof answer === 'string' && answer.trim()) return [answer.trim()];
  if (answer && typeof answer === 'object' && Array.isArray(answer.ids)) {
    return [...optionIdSet(answer.ids)];
  }
  return [];
}

/**
 * Auto-score an answer for an auto-scorable question.
 * Returns null for manually scored (open text) questions.
 *  - mcq_single: full points iff the selected option is the correct one.
 *  - mcq_multi : exact-match only. Full points iff the selected set equals the
 *                correct set (order-independent). Any incorrect pick, any
 *                missing correct option, or an empty key → 0. No partial credit.
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
      const correct = optionIdSet(question.correct_option_ids);
      if (!correct.size) return 0;
      const selected = optionIdSet(optionIds(answer));
      return setsEqual(selected, correct) ? points : 0;
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
    // A capped paper can leave a competency unserved (the apportionment only
    // guarantees one question each when the cap allows it). Such a competency
    // was never tested, so it must NOT be reported at 0%: that both invented a
    // "critical gap" for it and dragged the weighted overall down, which could
    // turn a flawless 3-question paper into a 30% "Not Yet Ready".
    const assessed = qs.length > 0;
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
    const target_level = Number(comp.target_level ?? 4);
    // Nothing on this paper covered the competency: report it as untested rather
    // than as a 0% failure. `score_pct`/`observed_level`/`gap` stay null so no
    // caller can mistake "not asked" for "answered badly".
    if (!assessed) {
      return {
        competency_id: comp.id,
        name: comp.name,
        category: comp.category || '',
        description: comp.description || '',
        weight: Number(comp.weight ?? 0),
        target_level,
        observed_level: null,
        gap: null,
        status: 'untested',
        score_pct: null,
        earned: 0,
        max: 0,
        recommended_focus: comp.enrichment_hint || comp.description || '',
        breakdown: [],
      };
    }
    const score_pct = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;
    const observed_level = pctToLevel(score_pct, config.level_thresholds);
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

  // The weighted blend runs over what was actually served, so a short paper is
  // read as a sample of the competencies it covered — never as a penalty for
  // the ones it did not.
  const assessedComps = perCompetency.filter((c) => c.status !== 'untested');
  // A competency with weight 0 is one the admin has not weighted yet (0 is the
  // default, and the framework editor allows it): it must not silently zero
  // the whole paper. When the assessed set carries no weight at all, fall back
  // to a plain mean of the competency scores — the `|| 1` guard used to divide
  // by one instead, so a flawless paper on unweighted competencies came out as
  // 0% "Not Yet Ready". A mix of weighted and unweighted competencies still
  // blends on the weights (the 0-weight ones contribute nothing, as before).
  const weightTotal = assessedComps.reduce((s, c) => s + c.weight, 0);
  const blended = weightTotal > 0
    ? assessedComps.reduce((s, c) => s + c.score_pct * c.weight, 0) / weightTotal
    : assessedComps.reduce((s, c) => s + c.score_pct, 0) / (assessedComps.length || 1);
  const overall_pct = Math.round(blended * 10) / 10;
  const band = readinessBand(overall_pct, config);

  const gaps = assessedComps
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

  const strengths = assessedComps
    .filter((c) => c.gap <= 0)
    .sort((a, b) => b.score_pct - a.score_pct)
    .map((c) => ({
      competency: c.name,
      score_pct: c.score_pct,
      observed_level: c.observed_level,
      target_level: c.target_level,
    }));

  // Reported separately so a reader of a capped paper knows which parts of the
  // role this sitting simply did not cover.
  const not_assessed = perCompetency
    .filter((c) => c.status === 'untested')
    .map((c) => ({
      competency_id: c.competency_id,
      competency: c.name,
      weight: c.weight,
      target_level: c.target_level,
      recommended_focus: c.recommended_focus,
    }));

  return {
    role: snapshot.role ? { id: snapshot.role.id, name: snapshot.role.name, key: snapshot.role.key } : null,
    framework_name: snapshot.framework?.name || 'ECOD Readiness Framework',
    overall_pct,
    band: band ? { key: band.key, label: band.label, tone: band.tone, description: band.description } : null,
    competencies: perCompetency,
    areas_to_improve: gaps,
    strengths,
    not_assessed,
    generated_at: new Date().toISOString(),
  };
}

/** Validate a framework config. Returns an array of human-readable problems (empty = valid). */
export function validateFrameworkConfig(config) {
  const problems = [];
  const plainText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;
  const bands = config?.readiness_bands;
  if (!Array.isArray(bands) || bands.length < 2) {
    problems.push('At least two readiness bands are required.');
  } else {
    const keys = new Set();
    const mins = new Set();
    for (const b of bands) {
      // A null/array/string band entry is invalid input, not a crash: reading
      // `.key` off null used to throw a TypeError and 500 the endpoint.
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        problems.push('Every readiness band must be an object with a key, a label and a min.');
        continue;
      }
      // Keys and labels are rendered as badges and stored on every report; a
      // structured or 5,000-character value is not a band name.
      if (!plainText(b.key) || !plainText(b.label)) problems.push('Every band needs a plain-text key and label (up to 120 characters).');
      if (b.description !== undefined && b.description !== null && (typeof b.description !== 'string' || b.description.length > 500))
        problems.push(`Band "${plainText(b.label) ? b.label : b.key}" description must be plain text (up to 500 characters).`);
      const min = Number(b.min);
      if (!Number.isFinite(min) || min < 0 || min > 100)
        problems.push(`Band "${plainText(b.label) ? b.label : b.key}" min must be between 0 and 100.`);
      // Two bands with one key are indistinguishable downstream (the report
      // card and the stage badges look bands up by key); two with one min
      // make the verdict depend on array order.
      if (plainText(b.key)) {
        if (keys.has(b.key)) problems.push(`Band key "${b.key}" is used more than once.`);
        keys.add(b.key);
      }
      if (Number.isFinite(min)) {
        if (mins.has(min)) problems.push(`Two readiness bands start at ${min}%; each band needs its own minimum.`);
        mins.add(min);
      }
    }
    // readinessBand() picks the highest band the score reaches; with no band
    // at 0% a low score would fall back to the lowest band by accident of
    // ordering rather than by rule. Make the floor explicit.
    if (!problems.length && !mins.has(0)) problems.push('One readiness band must start at 0% so every score has a verdict.');
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
  const moderate = Number(gs?.moderate);
  const critical = Number(gs?.critical);
  // Gaps are whole capability levels (target 1-5 minus observed 1-5), so the
  // cutoffs are whole levels between 1 and 4; "critical ≥ 1.7 levels" or
  // "critical ≥ Infinity" (never critical) are not meaningful settings.
  if (!gs || typeof gs !== 'object' || !Number.isInteger(moderate) || !Number.isInteger(critical)
    || moderate < 1 || critical > 4 || critical <= moderate)
    problems.push('Gap severity must be whole levels with 4 >= critical > moderate >= 1.');
  return problems;
}
