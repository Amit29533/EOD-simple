import { notFound, forbidden, unauthorized } from './helpers.mjs';
import { authHandlers } from './handlers/auth.mjs';
import { adminHandlers } from './handlers/admin.mjs';
import { assessorHandlers } from './handlers/assessor.mjs';
import { candidateHandlers } from './handlers/candidate.mjs';
import { metaHandlers } from './handlers/meta.mjs';

/** Route tables, kept in handler modules and registered here in order. */
const HANDLER_MODULES = [
  authHandlers, adminHandlers, assessorHandlers, candidateHandlers, metaHandlers,
];

/**
 * Tiny router: route(method, pattern, roles, handler).
 * roles=null means any authenticated user; a pattern like /admin/candidates/:id
 * is compiled once and cached. Guards are enforced here, not in handlers.
 */
export function registerRoutes() {
  const routes = [];
  const route = (method, pattern, roles, handler) =>
    routes.push({ method, pattern, roles, handler, ...compile(pattern) });

  for (const register of HANDLER_MODULES) register(route);
  return routes;
}

function compile(pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
  return { keys, regex };
}

export async function dispatch(routes, ctx) {
  for (const r of routes) {
    if (r.method !== ctx.method) continue;
    const m = ctx.path.match(r.regex);
    if (!m) continue;
    if (r.roles !== 'public') {
      if (!ctx.auth) return unauthorized();
      if (r.roles && !r.roles.includes(ctx.auth.user.role)) return forbidden();
    }
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return r.handler({ ...ctx, params });
  }
  return notFound();
}
