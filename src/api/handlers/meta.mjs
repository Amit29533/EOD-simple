import {
  PIPELINE_STAGES, ASSESSMENT_STATUSES, QUESTION_TYPES, USER_ROLES, DIFFICULTIES,
  MAX_ASSESSMENT_QUESTIONS, MODULE_TEST_STRUCTURE,
} from '../../core/constants.mjs';
import { MODULE_GROUPS, MODULES, FAMILIES } from '../../content/rsa-question-bank.mjs';
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
    moduleGroups: MODULE_GROUPS,
    modules: MODULES,
    families: FAMILIES,
    moduleTestStructure: MODULE_TEST_STRUCTURE,
  }));
}
