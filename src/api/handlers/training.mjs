import { ok, bad, audit } from '../helpers.mjs';
import { learningUrl } from './meta.mjs';

/**
 * Training Dashboard bridge to the learning platform (Anthroprime-LMS).
 *
 * The LMS owns courses, invitations and progress; ECOD owns accounts. These
 * admin-only routes forward the signed-in administrator's own session token to
 * the LMS's bounded `/api/integration/training` API, which re-validates it
 * against ECOD (`/auth/me`) before doing anything. Nothing here touches the
 * ECOD store except the audit log, and the two apps never share a database.
 *
 * Safety rules the LMS contract test pins:
 *  - only `LMS_WEB_URL` (https, or http on loopback) is ever called, and a
 *    redirect is an error, so the token cannot be bounced to another host;
 *  - the token is sent in a header only — never in a URL or a response body;
 *  - a candidate is refused by the router before anything is forwarded;
 *  - an LMS outage is a 503 for this dashboard and never ends the ECOD session.
 */
const TIMEOUT_MS = 15_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,150}$/;
const unavailable = (error) => ({ status: 503, body: { error } });

async function forward(auth, method, path, body) {
  const base = learningUrl();
  // Not configured is a state of this deployment, not an outage: answer it as
  // a conflict so it is never mistaken for (or alerted on as) a server fault.
  if (!base) return { status: 409, body: { error: 'Training is not connected yet. Set LMS_WEB_URL to the learning platform address and redeploy.', code: 'TRAINING_NOT_CONFIGURED' } };
  let response;
  try {
    response = await fetch(`${base}/api/integration/training${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${auth.token}`,
        accept: 'application/json',
        // The LMS server refuses writes that do not name its own origin and
        // carry its request marker (its browser anti-forgery check). This is a
        // server-to-server call authenticated by the bearer token, so it states
        // both explicitly; without them every invite and assignment was a 403.
        ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: new URL(base).origin, 'x-lms-request': '1' }),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch {
    return unavailable('The learning platform could not be reached. Your ECOD session is unaffected; please try again shortly.');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return unavailable('The learning platform sent an unreadable response. Please try again shortly.');
  }
  if (!response.ok) {
    const error = typeof data?.error === 'string' && data.error ? data.error.slice(0, 300) : 'The learning platform refused this request.';
    // A 401 from the LMS means it could not verify this session against ECOD
    // (misconfigured EOD_API_URL, clock skew). Passing it through would make
    // the ECOD portal sign the administrator out of ECOD itself.
    if (response.status === 401) return { status: 502, body: { error: `The learning platform could not verify your ECOD session. ${error}` } };
    return { status: response.status >= 500 ? 503 : response.status, body: { error } };
  }
  return ok(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
}

export function trainingHandlers(route) {
  const A = ['admin'];

  route('GET', '/admin/training', A, async ({ auth }) => forward(auth, 'GET', ''));

  route('POST', '/admin/training/invitations', A, async ({ store, auth, body }) => {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Enter the email address on the candidate\'s ECOD account.');
    const result = await forward(auth, 'POST', '/invitations', { email });
    if (result.status === 200) await audit(store, auth.user, 'training_invited', 'training', result.body.invitation?.id || '', `Training access granted to ${email.toLowerCase()}`);
    return result;
  });

  route('PUT', '/admin/training/invitations/:id', A, async ({ store, auth, params, body }) => {
    if (!SAFE_ID.test(params.id)) return bad('Invalid invitation.');
    if (!['active', 'revoked'].includes(body.status)) return bad('Choose whether training access is active or revoked.');
    const result = await forward(auth, 'PUT', `/invitations/${encodeURIComponent(params.id)}`, { status: body.status });
    if (result.status === 200) await audit(store, auth.user, body.status === 'revoked' ? 'training_revoked' : 'training_restored', 'training', params.id, `Training access ${body.status === 'revoked' ? 'revoked' : 'restored'}`);
    return result;
  });

  route('POST', '/admin/training/assign', A, async ({ store, auth, body }) => {
    if (!['course', 'path'].includes(body.kind) || !SAFE_ID.test(String(body.id || '')) || !SAFE_ID.test(String(body.candidate_id || '')))
      return bad('Choose a candidate and a published course.');
    const result = await forward(auth, 'POST', '/assign', { kind: body.kind, id: body.id, candidate_id: body.candidate_id });
    if (result.status === 200) await audit(store, auth.user, 'training_assigned', 'candidates', body.candidate_id, `Training ${body.kind} assigned`, { kind: body.kind, id: body.id });
    return result;
  });
}
