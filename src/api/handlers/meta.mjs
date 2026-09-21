import {
  PIPELINE_STAGES, ASSESSMENT_STATUSES, QUESTION_TYPES, USER_ROLES, DIFFICULTIES,
  MAX_ASSESSMENT_QUESTIONS, MODULE_TEST_STRUCTURE, APP_VERSION,
} from '../../core/constants.mjs';
import { MODULE_GROUPS, MODULES, FAMILIES } from '../../content/rsa-question-bank.mjs';
import { publishedModuleBanks, DEFAULT_MODULE_BANK_ROLE_KEY } from '../../content/module-banks.mjs';
import { ok } from '../helpers.mjs';

export function metaHandlers(route) {
  // Public on purpose: contains only static UI configuration (labels/enums),
  // no user data. The SPA needs it before sign-in, and requiring auth here
  // left `state.meta` null for fresh logins, crashing every view.
  route('GET', '/meta/bootstrap', 'public', async () => ok({
    pipelineStages: PIPELINE_STAGES,
    assessmentStatuses: ASSESSMENT_STATUSES,
    questionTypes: QUESTION_TYPES,
    userRoles: USER_ROLES,
    difficulties: DIFFICULTIES,
    maxAssessmentQuestions: MAX_ASSESSMENT_QUESTIONS,
    // Question Bank: module -> family structure and the fixed paper shape.
    // The top-level `modules`/`families` are the historical RSA bank (kept for
    // existing clients); `moduleBanks` is the per-role registry the Question
    // Bank screen uses to offer one bank per published track.
    moduleGroups: MODULE_GROUPS,
    modules: MODULES,
    families: FAMILIES,
    moduleTestStructure: MODULE_TEST_STRUCTURE,
    defaultModuleBankRoleKey: DEFAULT_MODULE_BANK_ROLE_KEY,
    moduleBanks: publishedModuleBanks(),
  }));
  route('GET', '/health', 'public', async () => ok({
    ok: true,
    version: APP_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));
}
