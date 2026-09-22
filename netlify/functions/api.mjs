import { createStore } from '../../src/storage/index.mjs';
import { createApp } from '../../src/api/app.mjs';
import { corsAllowOrigin, corsHeaders } from '../../src/api/cors.mjs';
import { MAX_SPREADSHEET_BYTES } from '../../src/core/constants.mjs';

/**
 * Netlify Function wrapper around the transport-agnostic app.
 * All routes live under /api/* (see netlify.toml redirects).
 *
 * Production hardening: security headers, CORS, payload limits.
 */
let appPromise;
/**
 * The JSON file store cannot work inside a function: the bundle filesystem is
 * read-only (every write throws) and each invocation starts from an empty
 * in-memory copy, so without STORAGE set the app fails every login and write
 * with misleading errors. Fail fast with the fix instead — reads and writes
 * alike, since an empty store would only serve convincing-looking lies.
 */
const getApp = () => (appPromise ||= createStore()
  .then(async (store) => ({ kind: store.kind, app: await createApp(store) }))
  .catch((err) => {
    // A failed start (bad Airtable env, a transient error while the first
    // request warmed the store) must not be memoised: the rejected promise
    // used to be reused by every later invocation of the same warm function
    // instance, so one hiccup meant 500s until the instance was recycled.
    appPromise = undefined;
    throw err;
  }));

const isConfigError = (err) => /STORAGE=|AIRTABLE_|Netlify Blobs|@netlify\/blobs/i.test(String(err?.message || ''));

const storageMisconfigured = () => ({
  statusCode: 503,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({
    error: 'Storage backend is not configured. Set STORAGE=blobs (recommended) or STORAGE=airtable with AIRTABLE_API_KEY and AIRTABLE_BASE_ID in the site environment, then redeploy.',
  }),
});

/**
 * Request body caps — the same two tiers `server.mjs` enforces, so a payload
 * that is refused locally is refused here too (and vice versa). Ordinary JSON
 * is capped tight; the two spreadsheet imports get room for a base64-encoded
 * file up to MAX_SPREADSHEET_BYTES. Note that Netlify itself stops buffered
 * synchronous function payloads at 6 MB (≈4.5 MB of binary once base64
 * encoded) before this code runs, so on this transport the import ceiling is
 * effectively that platform limit — see the deploy notes in the README.
 */
const MAX_BODY_BYTES = 2e6;
const MAX_UPLOAD_BODY_BYTES = MAX_SPREADSHEET_BYTES * 1.5 + 1024 * 1024;
const UPLOAD_PATHS = ['/admin/candidates/import', '/admin/question-bank/import'];

/** The header set every API response carries — mirrors `server.mjs`. */
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
  'x-dns-prefetch-control': 'off',
  // netlify.toml [[headers]] rules only cover static files; a function
  // response has to carry HSTS itself for the API origin to be pinned.
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

/**
 * The caller's address for the login throttle: Netlify sets
 * `x-nf-client-connection-ip` on every function invocation; the first
 * `x-forwarded-for` hop is the fallback (same rule as `server.mjs`).
 */
export const clientIp = (event) => {
  const h = event.headers || {};
  const direct = h['x-nf-client-connection-ip'];
  if (direct) return String(direct).trim();
  const forwarded = h['x-forwarded-for'];
  return forwarded ? String(forwarded).split(',')[0].trim() : '';
};

const apiPath = (event) => (event.path || '/').replace(/^\/.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';

export async function handler(event) {
  const cors = corsHeaders(corsAllowOrigin({
    origin: event.headers?.origin,
    host: event.headers?.['x-forwarded-host'] || event.headers?.host,
    allowlist: process.env.CORS_ORIGINS,
  }));
  const reply = (statusCode, body, extra = {}) => ({
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...cors, ...extra },
    body: JSON.stringify(body),
  });
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: { ...cors, 'cache-control': 'no-store' },
        body: '',
      };
    }

    const path = apiPath(event);
    // Size is checked before anything touches storage: an oversized request
    // is refused the same way whether or not the backend is up.
    let body;
    if (event.body) {
      const limit = UPLOAD_PATHS.includes(path) ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
      const size = event.isBase64Encoded ? Buffer.byteLength(event.body, 'base64') : Buffer.byteLength(event.body, 'utf8');
      if (size > limit) return reply(413, { error: 'Payload too large' });
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        return reply(400, { error: 'Invalid JSON body' });
      }
    }

    let started;
    try {
      started = await getApp();
    } catch (err) {
      console.error('[api] store init failed:', err);
      if (isConfigError(err)) return storageMisconfigured();
      throw err;
    }
    const { kind, app } = started;
    if (kind === 'json-file') return storageMisconfigured();
    const result = await app({
      method: event.httpMethod,
      path,
      query: event.queryStringParameters || {},
      headers: event.headers || {},
      body,
      ip: clientIp(event),
    });
    return reply(result.status, result.body, result.headers || {});
  } catch (err) {
    console.error('[api] fatal:', err);
    return reply(500, { error: 'Internal error. Please try again.' });
  }
}

