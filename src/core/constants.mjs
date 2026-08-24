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

export const SESSION_TTL_HOURS = 12;
export const DEFAULT_PORT = 3000;
