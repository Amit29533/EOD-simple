import { dashboardRoutes } from './admin/dashboard.mjs';
import { peopleRoutes } from './admin/people.mjs';
import { trackRoutes } from './admin/tracks.mjs';
import { assessmentListRoutes } from './admin/assessment-list.mjs';
import { questionBankRoutes } from './admin/question-bank.mjs';
import { contentRoutes } from './admin/content.mjs';
import { assessmentRoutes } from './admin/assessments.mjs';
import { governanceRoutes } from './admin/governance.mjs';

/**
 * Administrator API. The routes live in ./admin/, one module per area; they are
 * registered here in their original order, which the router relies on when two
 * patterns could match the same path.
 */
export function adminHandlers(route) {
  dashboardRoutes(route);
  peopleRoutes(route);
  trackRoutes(route);
  assessmentListRoutes(route);
  questionBankRoutes(route);
  contentRoutes(route);
  assessmentRoutes(route);
  governanceRoutes(route);
}
