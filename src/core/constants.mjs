/**
 * ECOD domain constants.
 * Everything here is *configuration*, not per-role logic: new roles/competencies/
 * questions/frameworks live in the database and are managed from the Admin UI.
 */

export const USER_ROLES = ['admin', 'assessor', 'candidate', 'validator', 'trainer'];

export const PIPELINE_STAGES = [
  { key: 'intake',           label: 'Candidate Intake' },
  { key: 'role_mapped',      label: 'Role Mapping' },
  { key: 'assessment',       label: 'Assessment' },
  { key: 'gap_mapping',      label: 'Gap Mapping' },
  { key: 'enrichment',       label: 'Enrichment' },
  { key: 'validation',       label: 'Independent Validation' },
  { key: 'enterprise_ready', label: 'Enterprise Ready' },
];
export const STAGE_KEYS = PIPELINE_STAGES.map((s) => s.key);

export const ASSESSMENT_STATUSES = [
  { key: 'assigned',    label: 'Allocated',        tone: 'grey'  },
  { key: 'in_progress', label: 'In progress',      tone: 'blue'  },
  { key: 'submitted',   label: 'Awaiting scoring', tone: 'amber' },
  { key: 'scored',      label: 'Scored',           tone: 'green' },
  { key: 'validated',   label: 'Validated',        tone: 'green' },
];

/**
 * Question type registry. Adding a new type later = one entry here plus one
 * case in core/scoring.mjs (if auto-scorable). No other application changes.
 */
export const QUESTION_TYPES = [
  { key: 'mcq_single', label: 'Multiple choice - single answer',     scoring: 'auto'   },
  { key: 'mcq_multi',  label: 'Multiple choice - multiple answers',  scoring: 'auto'   },
  { key: 'scale',      label: 'Proficiency scale (1-5 self rating)', scoring: 'auto'   },
  { key: 'text',       label: 'Open / scenario response',            scoring: 'manual' },
];
export const QUESTION_TYPE_KEYS = QUESTION_TYPES.map((t) => t.key);

export const DIFFICULTIES = ['foundation', 'intermediate', 'advanced'];

/** Default scoring/readiness framework applied to new roles. Editable per role from Admin. */
export const DEFAULT_FRAMEWORK_CONFIG = {
  readiness_bands: [
    { key: 'enterprise_ready',   label: 'Enterprise Ready',   min: 80, tone: 'green',
      description: 'Ready to be deployed on enterprise engagements.' },
    { key: 'development_needed', label: 'Development Needed', min: 55, tone: 'amber',
      description: 'Promising; targeted enrichment required before deployment.' },
    { key: 'not_ready',          label: 'Not Yet Ready',      min: 0,  tone: 'red',
      description: 'Significant capability gaps; revisit after structured development.' },
  ],
  // pct -> observed capability level 1..5 (count of thresholds the score meets)
  level_thresholds: [0, 20, 40, 60, 80],
  // competency gap (target_level - observed_level) severity cutoffs
  gap_severity: { moderate: 1, critical: 2 },
};

/** Maximum number of questions an allocation may cap an assessment at. */
export const MAX_ASSESSMENT_QUESTIONS = 50;

/**
 * Module-structured test generation (the module Question Bank).
 *
 * A generated paper is assembled from fixed per-module quotas rather than by
 * competency-weight apportionment. See src/core/test-generation.mjs for the
 * selection logic and src/content/rsa-question-bank.mjs for the bank.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for the shape of a paper. Every number
 * below is PER MODULE (except the module counts and the derived total);
 * test-generation.mjs derives the paper-wide totals (TEST_BLUEPRINT) from it,
 * so the two can never drift apart.
 *
 * There is no mandatory/common question: a paper is exactly the sum of the
 * per-module quotas below.
 */
export const MODULE_TEST_STRUCTURE = {
  technical_modules: 10,     // T01-T10
  technical_objective: 3,    // per technical module
  technical_open: 1,         // per technical module
  non_technical_modules: 10, // C01-C04, P01-P04, F01-F02
  non_technical_open: 1,     // per non-technical module
};
// (10 x (3 + 1)) + (10 x 1) = 50. Derived, never typed twice.
MODULE_TEST_STRUCTURE.total =
  MODULE_TEST_STRUCTURE.technical_modules
    * (MODULE_TEST_STRUCTURE.technical_objective + MODULE_TEST_STRUCTURE.technical_open)
  + MODULE_TEST_STRUCTURE.non_technical_modules * MODULE_TEST_STRUCTURE.non_technical_open;

export const SESSION_TTL_HOURS = 12;
export const DEFAULT_PORT = 3000;

/** Timed exam budgets (candidate portal). */
export const EXAM_MCQ_SECONDS = 30;
export const EXAM_OPEN_REVIEW_SECONDS = 60;
export const EXAM_OPEN_ANSWER_SECONDS = 120;

/** How many questions from the RSA oral set a capped (e.g. 50) paper must include. */
export const RSA_ORAL_IN_CAP = 5;
export const RSA_ORAL_SET = 'rsa-oral';

/** Max base64 characters stored with an open-response audio clip (~300 KB). */
export const MAX_AUDIO_B64 = 400_000;

/** Largest spreadsheet (xlsx/csv) an import endpoint will accept, in bytes. */
export const MAX_SPREADSHEET_BYTES = 8_000_000;
