/**
 * Registry of published module Question Banks, keyed by the stable role key
 * of the track they serve.
 *
 * Every role that has a module bank gets the same treatment: the published
 * content below (generated from the source workbook, read-only at runtime),
 * admin-authored additions merged over it (bank_questions rows scoped by
 * `role_key`), the module -> family tree, the plan, the generated-paper
 * preview, import and authoring — see src/api/bank-service.mjs.
 *
 * The RSA bank is the historical default: calls without an explicit role key
 * resolve to it, which keeps single-track workspaces (and every existing
 * client) behaving exactly as before the registry existed.
 */

import * as RSA from './rsa-question-bank.mjs';
import * as AIBI from './ai-bi-genie-question-bank.mjs';
import { OPTIONAL_QUESTIONS, OPTIONAL_FAMILIES, optionalSummary } from './rsa-optional-bank.mjs';

export const DEFAULT_MODULE_BANK_ROLE_KEY = 'databricks-rsa';

export const MODULE_BANKS = {
  'databricks-rsa': {
    roleKey: 'databricks-rsa',
    role_name: 'Resident Solutions Architect (RSA)',
    version: RSA.QUESTION_BANK_VERSION,
    authoredPrefix: 'RSA',
    groups: RSA.MODULE_GROUPS,
    modules: RSA.MODULES,
    questions: RSA.QUESTIONS,
    families: RSA.FAMILIES,
    findFamily: RSA.findFamily,
    // The retired RSA competency catalogue, kept as the fallback pool
    // (never drawn while a family can fill its module's quota).
    optional: {
      questions: OPTIONAL_QUESTIONS,
      families: OPTIONAL_FAMILIES,
      summary: optionalSummary(),
    },
  },
  'databricks-ai-bi-genie': {
    roleKey: 'databricks-ai-bi-genie',
    role_name: 'Senior Databricks AI/BI & Genie Consultant',
    version: AIBI.QUESTION_BANK_VERSION,
    authoredPrefix: 'AIBI',
    groups: AIBI.MODULE_GROUPS,
    modules: AIBI.MODULES,
    questions: AIBI.QUESTIONS,
    families: AIBI.FAMILIES,
    findFamily: AIBI.findFamily,
    optional: null,
  },
};

/** The published module bank for a role key, or null. */
export function moduleBankFor(roleKey) {
  if (roleKey === undefined || roleKey === null || roleKey === '') return MODULE_BANKS[DEFAULT_MODULE_BANK_ROLE_KEY];
  return MODULE_BANKS[roleKey] || null;
}

/** Every published module bank, in registry order, for UI selectors. */
export function publishedModuleBanks() {
  return Object.values(MODULE_BANKS).map((b) => ({
    role_key: b.roleKey,
    role_name: b.role_name,
    version: b.version,
    groups: b.groups,
    modules: b.modules,
  }));
}

/**
 * The authored-question id prefix for a bank (RSA-T01-A001, AIBI-G01-A001).
 * Each bank declares its own prefix, so the banks can never mint colliding ids.
 */
export function authoredIdPrefix(roleKey) {
  return moduleBankFor(roleKey)?.authoredPrefix || 'RSA';
}
