/**
 * The published Technology Risk Consultant - SAMA assessment catalogue: the
 * role definition, the ten module competencies (weights) and the full
 * question bank (100 published items — 60 objective + 40 open).
 *
 * This is *published content*, not seed-only data: the API layer serves it to
 * admins so a workspace can top its bank up from inside the app (see the
 * catalogue-sync admin endpoints), and scripts/seed.mjs reuses it for CLI
 * seeding. It is the track-level twin of the module Question Bank in
 * src/content/sama-question-bank.mjs (generated from the same source
 * workbook, "SAMA Question bank 1.1.xlsx"): the questions below are *derived*
 * from that bank here, so the served bank and the module bank can never drift
 * apart. Same construction as src/content/ai-bi-genie-catalogue.mjs.
 */

import { MODULES, QUESTIONS } from './sama-question-bank.mjs';

export const SAMA_ROLE = {
  key: 'technology-risk-sama',
  name: 'Technology Risk Consultant - SAMA',
  technology: 'Technology Risk',
  description:
    'Enterprise track for technology risk consultants serving SAMA-regulated banks and financial institutions in Saudi Arabia. Validates SAMA CSF and ITGF assessment, technology risk and control testing, IAM/PAM and segregation of duties, infrastructure and security operations, change/SDLC and application security, resilience and recovery, third-party, cloud and data protection (NCA ECC, PDPL), findings and remediation writing, and banking-grade reporting and client management.',
};

// weight totals 100. target_level is the enterprise-ready bar on the 1-5 scale.
// One competency per source-workbook module, in the bank's module order.
export const SAMA_COMPETENCIES = [
  { key: 'sama-csf-regulatory', name: 'SAMA CSF & Saudi Regulatory Assessment', category: 'regulatory', weight: 14, target_level: 4, order: 1,
    description: 'Assesses against the SAMA Cyber Security Framework and the Saudi regulatory landscape: control mapping, maturity, evidence, gaps and remediation.',
    enrichment_hint: 'Perform a SAMA CSF control-mapping and evidence-assessment exercise, distinguishing regulatory requirements, implementation evidence, maturity, gaps, and remediation.' },
  { key: 'sama-itgf-governance', name: 'SAMA ITGF & Technology Governance', category: 'regulatory', weight: 12, target_level: 4, order: 2,
    description: 'Maps IT governance, IT risk, operations and change practices to SAMA ITGF requirements and drives a governance improvement plan.',
    enrichment_hint: 'Map IT governance, IT risk, operations, and system-change practices to SAMA ITGF requirements and prepare a governance improvement plan.' },
  { key: 'risk-control-assessment', name: 'Technology Risk & Control Assessment', category: 'assessment', weight: 12, target_level: 4, order: 3,
    description: 'Scopes and executes control assessments: walkthroughs, design and operating-effectiveness testing, sampling, evidence evaluation and risk-rating calibration.',
    enrichment_hint: 'Practise scoping, walkthroughs, design and operating-effectiveness testing, sampling, evidence evaluation, inherent risk, residual risk, and risk-rating calibration.' },
  { key: 'iam-pam-sod', name: 'IAM, PAM & Segregation of Duties', category: 'security', weight: 10, target_level: 4, order: 4,
    description: 'Assesses identity and access controls: joiner-mover-leaver, privileged access, service accounts, recertification, emergency access and SoD.',
    enrichment_hint: 'Assess joiner-mover-leaver, privileged access, service accounts, recertification, authentication, emergency access, SoD, and access-monitoring controls.' },
  { key: 'infrastructure-secops', name: 'Infrastructure & Security Operations', category: 'security', weight: 10, target_level: 4, order: 5,
    description: 'Assesses vulnerability, patching, hardening, network, endpoint, database, logging and monitoring controls from technical evidence.',
    enrichment_hint: 'Assess vulnerability, patching, hardening, network, endpoint, database, logging, monitoring, asset, and security-operations controls using technical evidence.' },
  { key: 'change-sdlc-appsec', name: 'Change, SDLC & Application Security', category: 'security', weight: 9, target_level: 3, order: 6,
    description: 'Tests change, release, emergency change, secure SDLC, code review, application security and production-access controls.',
    enrichment_hint: 'Test change, release, emergency change, secure SDLC, code review, application security, production access, and configuration-management controls.' },
  { key: 'resilience-recovery', name: 'Resilience, Incident & Recovery', category: 'resilience', weight: 9, target_level: 3, order: 7,
    description: 'Evaluates incident response, backup and recovery, BCP/DR, crisis escalation, recovery objectives and resilience testing.',
    enrichment_hint: 'Evaluate incident response, backup, recovery, availability, BCP, disaster recovery, crisis escalation, recovery objectives, and resilience testing.' },
  { key: 'third-party-cloud-data', name: 'Third-Party, Cloud & Data Protection', category: 'governance', weight: 9, target_level: 4, order: 8,
    description: 'Assesses outsourcing and vendor oversight, cloud shared responsibility, concentration and exit risk, data protection, NCA ECC and Saudi PDPL dependencies.',
    enrichment_hint: 'Assess outsourcing, vendor oversight, cloud shared responsibility, concentration, exit planning, data protection, NCA ECC, and Saudi PDPL dependencies.' },
  { key: 'findings-remediation', name: 'Findings, Remediation & Closure', category: 'advisory', weight: 8, target_level: 4, order: 9,
    description: 'Writes defensible findings (condition, cause, risk, severity, action, owner, timeline) and validates remediation and closure evidence.',
    enrichment_hint: 'Write clear findings linking requirement, condition, cause, control gap, risk, impact, likelihood, severity, action, owner, timeline, and closure evidence.' },
  { key: 'banking-reporting-client', name: 'Banking, Reporting & Client Management', category: 'advisory', weight: 7, target_level: 4, order: 10,
    description: 'Handles banking-risk scenarios, stakeholder interviews, constructive challenge, senior reporting, dashboards, escalation and governance presentations.',
    enrichment_hint: 'Practise banking-risk scenarios, stakeholder interviews, constructive challenge, senior reporting, dashboards, issue escalation, and governance presentations.' },
];

/** Module key -> competency key, in the bank's module order. */
const COMPETENCY_FOR_MODULE = Object.fromEntries(
  MODULES.map((m, i) => [m.key, SAMA_COMPETENCIES[i].key])
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
 * (see core/spoken-answer.mjs), exactly like the RSA and AI/BI catalogues.
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
export const SAMA_QUESTIONS = (() => {
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
