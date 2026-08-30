/**
 * The legacy RSA catalogue, re-shaped as the OPTIONAL question pool.
 *
 * Before the finalized Question Bank v1.2 (src/content/rsa-question-bank.mjs)
 * the platform served a 115-question bank organised by *competency*. Those
 * questions are no longer part of a generated test: v1.2 is the authoritative
 * bank and its MODULE -> FAMILY structure drives selection.
 *
 * They are not discarded, though. Each one is mapped onto the closest v1.2
 * module, tagged `optional: true`, and kept as a **fallback pool**: the
 * generator ignores optional questions while a module can satisfy its quota
 * from the v1.2 bank, and only draws on them when a module would otherwise
 * come up short (see src/core/test-generation.mjs). That keeps a generated
 * paper at its full length even if an admin deactivates or deletes a chunk of
 * the primary bank.
 *
 * Deriving the pool from the legacy catalogue - rather than copying 115
 * records - means an edit to the legacy content stays reflected here, and the
 * mapping below is the single place that records where each retired
 * competency now belongs.
 */

import { RSA_QUESTIONS, RSA_COMPETENCIES, RSA_ORAL_SET } from './rsa-catalogue.mjs';
import { MODULES } from './rsa-question-bank.mjs';

/**
 * Retired competency -> the v1.2 module that now covers it.
 * Chosen by subject overlap, so a fallback question is always at least
 * on-topic for the module it stands in for.
 */
export const LEGACY_COMPETENCY_TO_MODULE = {
  'lakehouse-architecture': 'T01', // Databricks Architecture, Lakehouse & Data Intelligence
  'data-engineering':       'T02', // Data Ingestion, Streaming & Change Processing
  'governance-security':    'T06', // Unity Catalog, Security & Data Governance
  'ml-genai':               'T10', // GenAI, RAG & Agent Operations
  'performance-cost':       'T05', // Delta Lake, Performance, Compute & Cost Optimization
  'devops-production':      'T08', // Migration, Troubleshooting & Production Operations
  'customer-advisory':      'C03', // Objection Handling & Consultative Influence
};

/**
 * Target module -> the top-level group it sits in, read from the published
 * bank rather than restated here: a hand-kept copy would silently disagree
 * with MODULES the moment a module were regrouped.
 */
const groupOf = (moduleKey) =>
  MODULES.find((m) => m.key === moduleKey)?.group || 'technical';

const COMPETENCY_NAME = Object.fromEntries(
  RSA_COMPETENCIES.map((c) => [c.key, c.name])
);

/**
 * Retired questions keep their own identity rather than being forced into one
 * of the v1.2 families: each retired competency becomes a "Legacy - <name>"
 * family inside its target module. That way the optional pool is visible in
 * the same MODULE -> FAMILY tree without diluting the curated families a new
 * question should be added to.
 */
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const familyNameFor = (competency) => `Legacy - ${COMPETENCY_NAME[competency] || competency}`;
const familyIdFor = (module, competency) => `${module}:legacy-${slug(competency)}`;

/** Legacy storage types map onto the two v1.2 answer modes. */
const isOpenType = (type) => type === 'text';

/**
 * Priority decides which optional question is preferred when several could
 * cover the same shortfall. Spoken customer-advisory items rank highest (they
 * were the curated set), then open scenarios, then everything else.
 */
function priorityOf(question) {
  if (question.question_set === RSA_ORAL_SET) return 3;
  if (isOpenType(question.type)) return 2;
  return 1;
}

let sequence = 0;
const nextId = (module) => {
  sequence += 1;
  return `RSA-${module}-OPT-${String(sequence).padStart(3, '0')}`;
};

/**
 * The optional pool, in the shape the generator and the storage layer expect
 * (identical to a v1.2 question, plus the `optional` flags).
 */
export const OPTIONAL_QUESTIONS = RSA_QUESTIONS
  .filter((q) => LEGACY_COMPETENCY_TO_MODULE[q.competency])
  .map((q) => {
    const module = LEGACY_COMPETENCY_TO_MODULE[q.competency];
    const open = isOpenType(q.type);
    return {
      id: nextId(module),
      module,
      family_id: familyIdFor(module, q.competency),
      family: familyNameFor(q.competency),
      type: open ? 'open' : 'objective',
      source_type: 'Legacy catalogue',
      difficulty: q.difficulty === 'advanced' ? 5 : q.difficulty === 'foundation' ? 2 : 3,
      band: q.difficulty === 'advanced' ? 'Advanced' : 'Intermediate',
      mode: q.audio_required === true ? 'Live assessor' : 'Online assessment',
      minutes: open ? 5 : 2,
      status: 'Active',
      version: '1.1',
      randomizable: true,
      mandatory: false,

      // What marks these as the fallback pool.
      optional: true,
      optional_priority: priorityOf(q),
      legacy_competency: q.competency,

      prompt: q.prompt,
      ...(open
        ? { probes: [], rubric: q.rubric || '' }
        : {
            options: (q.options || []).map((o) => ({ id: o.id, label: o.label })),
            correct_option_ids: q.correct_option_ids || [],
            rationale: '',
            needs_option_review: false,
          }),
      red_flags: '',
      gap_tag: `${COMPETENCY_NAME[q.competency] || q.competency} - legacy`,
      enrichment: '',
      help_text: q.help_text || '',
      question_set: q.question_set || '',
      audio_required: q.audio_required === true,
    };
  });

/**
 * The legacy families this pool contributes, so the Admin UI can show them in
 * the MODULE -> FAMILY tree alongside the curated v1.2 families.
 */
export const OPTIONAL_FAMILIES = [...new Map(
  OPTIONAL_QUESTIONS.map((q) => [q.family_id, {
    id: q.family_id,
    key: q.family_id.split(':')[1],
    name: q.family,
    module: q.module,
    group: groupOf(q.module),
    role: 'mixed',
    legacy: true,
    objective: 0,
    open: 0,
  }])
).values()].map((family) => {
  const rows = OPTIONAL_QUESTIONS.filter((q) => q.family_id === family.id);
  return {
    ...family,
    objective: rows.filter((q) => q.type === 'objective').length,
    open: rows.filter((q) => q.type === 'open').length,
  };
}).sort((a, b) => a.id.localeCompare(b.id));

/** Per-module counts, for the admin UI. */
export function optionalSummary() {
  const byModule = {};
  for (const q of OPTIONAL_QUESTIONS) {
    const row = byModule[q.module] || (byModule[q.module] = {
      module: q.module, group: groupOf(q.module), objective: 0, open: 0,
    });
    if (q.type === 'open') row.open += 1;
    else row.objective += 1;
  }
  return {
    total: OPTIONAL_QUESTIONS.length,
    families: OPTIONAL_FAMILIES.length,
    modules: Object.values(byModule).sort((a, b) => a.module.localeCompare(b.module)),
  };
}
