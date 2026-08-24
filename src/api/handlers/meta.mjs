import { PIPELINE_STAGES, ASSESSMENT_STATUSES, QUESTION_TYPES, USER_ROLES, DIFFICULTIES } from '../../core/constants.mjs';
import { ok } from '../helpers.mjs';

export function metaHandlers(route) {
  route('GET', '/meta/bootstrap', null, async () => ok({
    pipelineStages: PIPELINE_STAGES,
    assessmentStatuses: ASSESSMENT_STATUSES,
    questionTypes: QUESTION_TYPES,
    userRoles: USER_ROLES,
    difficulties: DIFFICULTIES,
  }));
}
