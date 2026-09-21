/**
 * The published Senior Databricks AI/BI & Genie Consultant assessment
 * catalogue: the role definition, the ten module competencies (weights) and
 * the full question bank (100 published items — 60 objective + 40 open).
 *
 * This is *published content*, not seed-only data: the API layer serves it to
 * admins so a workspace can top its bank up from inside the app (see the
 * catalogue-sync admin endpoints), and scripts/seed.mjs reuses it for CLI
 * seeding. It is the track-level twin of the module Question Bank in
 * src/content/ai-bi-genie-question-bank.mjs (generated from the same source
 * workbook): the questions below are *derived* from that bank here, so the
 * served bank and the module bank can never drift apart.
 */

import { MODULES, QUESTIONS } from './ai-bi-genie-question-bank.mjs';

export const AIBI_ROLE = {
  key: 'databricks-ai-bi-genie',
  name: 'Senior Databricks AI/BI & Genie Consultant',
  technology: 'Databricks',
  description:
    'Enterprise track for senior Databricks AI/BI & Genie consultants. Validates use-case discovery, Genie space design and optimization, semantic layer and data quality, target architecture, Unity Catalog governance, OBO authentication and role security, QA and evaluation evidence, release readiness, commercial workflows and documentation handover for AI/BI & Genie engagements.',
};

// weight totals 100. target_level is the enterprise-ready bar on the 1-5 scale.
// One competency per source-workbook module, in the bank's module order.
export const AIBI_COMPETENCIES = [
  { key: 'genie-space-design', name: 'Genie Space Design & Optimization', category: 'data-ai', weight: 14, target_level: 4, order: 1,
    description: 'Designs and tunes Genie spaces: trusted assets, instructions, benchmarks and iterative response-quality evaluation.',
    enrichment_hint: 'Build and critique a Genie space using representative questions, trusted assets, instructions, benchmarks, and iterative response-quality evaluation.' },
  { key: 'semantic-layer-data-quality', name: 'Semantic Layer & Data Quality', category: 'engineering', weight: 13, target_level: 4, order: 2,
    description: 'Builds governed semantic models: certified metrics, joins, business definitions, quality checks and source ownership.',
    enrichment_hint: 'Create a governed semantic model with certified metrics, clear joins, business definitions, quality checks, and traceable source ownership.' },
  { key: 'target-architecture', name: 'Target Architecture & Environments', category: 'architecture', weight: 12, target_level: 4, order: 3,
    description: 'Defines the target Databricks architecture: workspaces, catalogs, environments, deployment paths and operational ownership.',
    enrichment_hint: 'Produce a target-state Databricks architecture covering workspaces, catalogs, environments, dependencies, deployment paths, and operational ownership.' },
  { key: 'unity-catalog-governance', name: 'Unity Catalog Governance', category: 'governance', weight: 11, target_level: 4, order: 4,
    description: 'Implements governance on AI/BI assets: least privilege, ownership, lineage, auditing and controlled data-product access.',
    enrichment_hint: 'Design a Unity Catalog governance model with least privilege, ownership, lineage, auditing, catalog boundaries, and controlled data-product access.' },
  { key: 'obo-authentication-security', name: 'OBO Authentication & Role Security', category: 'governance', weight: 9, target_level: 4, order: 5,
    description: 'Secures identity-to-data authorization: OBO flows, service principals, groups, row filters, column masks and audit evidence.',
    enrichment_hint: 'Implement and test an identity-to-data authorization design covering OBO flows, service principals, groups, row filters, column masks, and audit evidence.' },
  { key: 'qa-evaluation-evidence', name: 'QA, Evaluation & Test Evidence', category: 'engineering', weight: 10, target_level: 4, order: 6,
    description: 'Produces evaluation and test evidence: golden questions, expected outputs, permission and performance tests, signed sign-off.',
    enrichment_hint: 'Create a QA pack with golden questions, expected outputs, permissions tests, performance thresholds, regression criteria, defects, and signed evidence.' },
  { key: 'release-production-readiness', name: 'Release & Production Readiness', category: 'platform', weight: 10, target_level: 3, order: 7,
    description: 'Runs release readiness: configuration promotion, approvals, rollback, monitoring, support and change control.',
    enrichment_hint: 'Build a release-readiness checklist covering configuration promotion, approvals, rollback, monitoring, support, change control, and post-release validation.' },
  { key: 'use-case-discovery', name: 'Use-Case Discovery & Acceptance Criteria', category: 'advisory', weight: 8, target_level: 4, order: 8,
    description: 'Structures AI/BI use cases: user journeys, measurable acceptance criteria, data requirements, risks and phased delivery.',
    enrichment_hint: 'Practise converting a commercial workflow into user journeys, measurable acceptance criteria, data requirements, risks, and a phased delivery plan.' },
  { key: 'commercial-workflows-ux', name: 'Commercial Workflows & User Experience', category: 'advisory', weight: 8, target_level: 4, order: 9,
    description: 'Maps commercial workflows (planning, pre-call, field execution) to actionable Genie experiences with adoption measures.',
    enrichment_hint: 'Map planning, pre-call, and field-execution journeys to actionable Genie experiences, adoption measures, feedback loops, and business outcomes.' },
  { key: 'documentation-handover', name: 'Consulting, Documentation & Handover', category: 'advisory', weight: 5, target_level: 3, order: 10,
    description: 'Delivers the consulting handover: recommendation, architecture pack, decision log, runbook, test evidence and stakeholder transfer.',
    enrichment_hint: 'Prepare an executive recommendation, architecture pack, decision log, runbook, test evidence, and stakeholder handover for a production launch.' },
];

/** Module key -> competency key, in the bank's module order. */
const COMPETENCY_FOR_MODULE = Object.fromEntries(
  MODULES.map((m, i) => [m.key, AIBI_COMPETENCIES[i].key])
);

const difficultyFromBand = (band) => {
  const b = String(band || '').toLowerCase();
  return b === 'foundation' ? 'foundation' : b === 'advanced' ? 'advanced' : 'intermediate';
};

/**
 * The served-bank shape of one published module-bank question.
 *
 * Objective items become single-answer MCQs (points 4); every other item
 * becomes an open / scenario response (points 6) scored against a rubric that
 * combines the expected evidence with the workbook's follow-up probes, since
 * the rubric is the one scoring field the assessor sees. The "Correct answer"
 * note stays in the module bank (rationale) and is deliberately NOT put in
 * help_text — help_text is shown to the candidate and must never leak the key.
 * Open questions inherit the microphone requirement from the question *type*
 * (see core/spoken-answer.mjs), exactly like the RSA catalogue.
 */
function toServedQuestion(q, competency, order) {
  const base = {
    competency,
    difficulty: difficultyFromBand(q.band),
    order,
    prompt: q.prompt,
    help_text: '',
    options: [],
    correct_option_ids: [],
    rubric: '',
    question_set: '',
    pin_first: false,
  };
  if (q.type === 'objective') {
    return {
      ...base,
      type: 'mcq_single',
      points: 4,
      options: (q.options || []).map((o) => ({ id: o.id, label: o.label })),
      correct_option_ids: q.correct_option_ids || [],
    };
  }
  const parts = [`Expected evidence: ${q.rubric || ''}`];
  if (q.probes && q.probes.length) parts.push(`Follow-up probes: ${q.probes.join('; ')}`);
  return { ...base, type: 'text', points: 6, rubric: parts.join('\n\n') };
}

/**
 * The 100 published questions for the served bank, module by module (in the
 * bank's module order) and within each module in workbook order, so the
 * served set mirrors the module tree one-for-one.
 */
export const AIBI_QUESTIONS = (() => {
  const out = [];
  const orderInModule = {};
  for (const q of QUESTIONS) {
    const competency = COMPETENCY_FOR_MODULE[q.module];
    if (!competency) continue;
    orderInModule[q.module] = (orderInModule[q.module] || 0) + 1;
    out.push(toServedQuestion(q, competency, orderInModule[q.module]));
  }
  return out;
})();
