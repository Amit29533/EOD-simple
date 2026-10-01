/** Allocation-oriented v2 bank. Source IDs and content remain stable for overrides and old attempts. */
import { QUESTIONS as SOURCE } from './ai-bi-genie-source-bank.mjs';

export const QUESTION_BANK_VERSION = '2.0';
export const MODULE_GROUPS = [
  { key: 'technical', name: 'Technical', order: 1 },
  { key: 'consulting', name: 'Consulting', order: 2 },
  { key: 'professional', name: 'Professional', order: 3 },
  { key: 'foundation', name: 'Foundation', order: 4 },
];
const definitions = [
  ['T01', 'Genie Space Scope & Design'], ['T02', 'Genie Instructions & Answer Optimization'],
  ['T03', 'Semantic Models & Governed Metrics'], ['T04', 'Data Quality & Historical Attribution'],
  ['T05', 'Target Architecture & Ownership'], ['T06', 'Environments & Configuration Promotion'],
  ['T07', 'Unity Catalog Governance'], ['T08', 'OBO Authentication & Role Security'],
  ['T09', 'QA, Evaluation & Test Evidence'], ['T10', 'Release & Production Operations'],
  ['C01', 'Discovery & Scope'], ['C02', 'Prioritization & Delivery Judgment'],
  ['C03', 'Adoption & Workflow Improvement'], ['C04', 'Responsible Recommendations'],
  ['P01', 'Stakeholder Decisions'], ['P02', 'Challenge & Trust'],
  ['P03', 'Documentation & Accountability'], ['P04', 'Operational Handover'],
  ['F01', 'Acceptance Criteria & Business Value'], ['F02', 'User Journeys & Engagement Design'],
];
export const MODULES = definitions.map(([key, name], i) => ({
  key, name, order: i + 1, technical: key.startsWith('T'),
  group: key.startsWith('T') ? 'technical' : key.startsWith('C') ? 'consulting' : key.startsWith('P') ? 'professional' : 'foundation',
  families: [{ id: `${key}:assessment`, key: 'assessment', name, role: key.startsWith('T') ? 'mixed' : 'open' }],
}));
const targets = new Map(MODULES.map((m) => [m.key, m]));
// Topic-aware split of the three broad source technical modules. Numbers are stable source ID suffixes.
const split = {
  G01: { T01: ['001', '009', '010', '005', '006'], T02: ['004', '007', '008', '002', '003'] },
  G02: { T03: ['001', '004', '008', '002', '003'], T04: ['007', '009', '010', '005', '006'] },
  A01: { T05: ['001', '009', '010', '002', '006'], T06: ['003', '007', '008', '004', '005'] },
  S01: { T07: null }, S02: { T08: null }, Q01: { T09: null }, R01: { T10: null },
  F01: { C01: ['001', '004', '005', '007'], C02: ['006', '008', '009'], F01: ['003', '010'], F02: ['002'] },
  C01: { C03: ['004', '006', '008'], C04: ['005', '010'], F02: ['001', '002', '007', '009'], F01: ['003'] },
  D01: { P01: ['003', '008'], P02: ['005'], P03: ['002', '004', '009'], P04: ['006', '007'], F01: ['001', '010'] },
};
export const LEGACY_MODULE_DEFAULTS = { G01: 'T01', G02: 'T03', A01: 'T05', S01: 'T07', S02: 'T08', Q01: 'T09', R01: 'T10', F01: 'C01', C01: 'C03', D01: 'P03' };
export function remapLegacyQuestion(q) {
  const suffix = String(q.id || '').split('-').at(-1);
  const mapping = split[q.module];
  const module = mapping ? Object.entries(mapping).find(([, ids]) => ids === null || ids.includes(suffix))?.[0]
    || LEGACY_MODULE_DEFAULTS[q.module] : q.module;
  const target = targets.get(module);
  if (!target) return q;
  return { ...q, source_module: q.source_module || q.module, module, family_id: `${module}:assessment`, family: target.name, version: QUESTION_BANK_VERSION };
}
// Legacy authored F01/C01 module names are ambiguous with v2 names: callers
// remap only rows created against a pre-v2 bank version.
export const QUESTIONS = SOURCE.map(remapLegacyQuestion);
for (const module of MODULES) {
  const rows = QUESTIONS.filter((q) => q.module === module.key);
  module.families[0].objective = rows.filter((q) => q.type === 'objective').length;
  module.families[0].open = rows.filter((q) => q.type === 'open').length;
  module.families[0].role = module.families[0].objective ? 'mixed' : 'open';
}
export const FAMILIES = MODULES.flatMap((m) => m.families.map((f) => ({ ...f, module: m.key, group: m.group })));
export const findFamily = (id) => FAMILIES.find((f) => f.id === id);
