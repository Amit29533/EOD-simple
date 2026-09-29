import { MAX_ASSESSMENT_QUESTIONS } from './constants.mjs';

/** Defaults shipped with the published tracks. Stored role values win. */
export const PUBLISHED_AUTO_ALLOCATION_DEFAULTS = Object.freeze({
  'databricks-rsa': 50,
  'databricks-ai-bi-genie': 50,
  'technology-risk-sama': 30,
});

/**
 * The effective automatic paper size for a role.
 *
 * Older workspaces do not yet have `default_question_count` on their role
 * rows. Falling back by stable role key makes the new policy take effect on
 * those workspaces immediately, while a value saved in Roles & frameworks
 * remains the administrator's source of truth.
 */
export function defaultQuestionCountForRole(role) {
  const stored = Number(role?.default_question_count);
  if (Number.isInteger(stored) && stored >= 1 && stored <= MAX_ASSESSMENT_QUESTIONS) return stored;
  return PUBLISHED_AUTO_ALLOCATION_DEFAULTS[role?.key] || MAX_ASSESSMENT_QUESTIONS;
}

/** A request-level override, when supplied, otherwise the role's setting. */
export function automaticQuestionCount(role, requested = null) {
  const explicit = Number(requested);
  if (requested !== null && requested !== undefined && requested !== ''
    && Number.isInteger(explicit) && explicit >= 1 && explicit <= MAX_ASSESSMENT_QUESTIONS) return explicit;
  return defaultQuestionCountForRole(role);
}

/**
 * SAMA's published 30-question paper has an authored module blueprint. This
 * policy is only active at that configured size; an administrator who chooses
 * another default still gets the ordinary weighted allocator for that size.
 */
export function automaticAllocationBlueprint(role, questionCount) {
  if (role?.key !== 'technology-risk-sama' || Number(questionCount) !== 30) return null;
  return [
    ['sama-csf-regulatory', 2, 1],
    ['sama-itgf-governance', 3, 0],
    ['risk-control-assessment', 2, 1],
    ['iam-pam-sod', 3, 0],
    ['infrastructure-secops', 2, 1],
    ['change-sdlc-appsec', 3, 0],
    ['resilience-recovery', 2, 1],
    ['third-party-cloud-data', 3, 0],
    ['findings-remediation', 2, 1],
    ['banking-reporting-client', 3, 0],
  ].map(([competency_key, objective, open]) => ({ competency_key, objective, open }));
}
