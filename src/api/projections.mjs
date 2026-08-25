/**
 * Response projections - the heart of compartmentalization.
 * Each audience only ever receives what its function requires; these are the
 * ONLY shapes handlers may return, so leaks fail at code review, not at runtime.
 */

/** Safe user shape (never includes password_hash). */
export const publicUser = (u) => u && ({
  id: u.id, username: u.username, name: u.name, email: u.email || '',
  role: u.role, candidate_id: u.candidate_id || null, active: u.active !== false,
});

/**
 * Candidate as seen by an ASSESSOR: professional background only.
 * No contact details, no source, no notes, no pipeline internals, no commercials.
 */
export const candidateForAssessor = (c) => c && ({
  id: c.id, name: c.name, current_title: c.current_title || '',
  years_experience: c.years_experience ?? null, target_role_id: c.target_role_id || null,
});

/** Full candidate (admin only). */
export const candidateForAdmin = (c) => c && ({ ...c });

/**
 * Question as seen by a CANDIDATE: prompt + options only.
 * correct_option_ids and the assessor rubric are never sent.
 */
export const questionForCandidate = (q) => ({
  id: q.id, competency_id: q.competency_id, type: q.type, prompt: q.prompt,
  help_text: q.help_text || '',
  options: (q.options || []).map((o) => ({ id: o.id, label: o.label })),
  points: q.points ?? 1, difficulty: q.difficulty || 'intermediate', order: q.order ?? 0,
});

export const competencyForCandidate = (c) => ({
  id: c.id, name: c.name, category: c.category || '', description: c.description || '', order: c.order ?? 0,
});

/**
 * Report card as seen by the CANDIDATE: scores, levels, gaps, focus areas.
 * Assessor identity and per-question assessor comments are withheld.
 */
export function reportForCandidate(report, assessment) {
  return {
    role: report.role,
    framework_name: report.framework_name,
    overall_pct: report.overall_pct,
    band: report.band,
    submitted_at: assessment.submitted_at || null,
    scored_at: assessment.scored_at || null,
    competencies: (report.competencies || []).map((c) => ({
      competency_id: c.competency_id, name: c.name, category: c.category,
      weight: c.weight, score_pct: c.score_pct,
      observed_level: c.observed_level, target_level: c.target_level, gap: c.gap, status: c.status,
    })),
    areas_to_improve: report.areas_to_improve || [],
    strengths: report.strengths || [],
    // Safe aggregate metrics for the candidate's printable report. The
    // question-level answers and assessor feedback remain excluded.
    questions_evaluated: (report.competencies || []).reduce((sum, c) => sum + (c.breakdown?.length || 0), 0),
    points_earned: (report.competencies || []).reduce((sum, c) => sum + Number(c.earned || 0), 0),
    points_available: (report.competencies || []).reduce((sum, c) => sum + Number(c.max || 0), 0),
    generated_at: report.generated_at,
  };
}
