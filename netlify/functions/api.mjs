import { createStore } from '../../src/storage/index.mjs';
import { createApp } from '../../src/api/app.mjs';
import { corsAllowOrigin, corsHeaders } from '../../src/api/cors.mjs';

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

const MAX_BODY = 12_000_000; // 12MB max for uploads

export async function handler(event) {
  const cors = corsHeaders(corsAllowOrigin({
    origin: event.headers?.origin,
    host: event.headers?.['x-forwarded-host'] || event.headers?.host,
    allowlist: process.env.CORS_ORIGINS,
  }));
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: { ...cors, 'cache-control': 'no-store' },
        body: '',
      };
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
    let body;
    if (event.body) {
      if (event.body.length > MAX_BODY) {
        return {
          statusCode: 413,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          body: JSON.stringify({ error: 'Payload too large' }),
        };
      }
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }
    }
    const path = (event.path || '/').replace(/^\/.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';
    const result = await app({
      method: event.httpMethod,
      path,
      query: event.queryStringParameters || {},
      headers: event.headers || {},
      body,
    });
    return {
      statusCode: result.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
        ...cors,
      },
      body: JSON.stringify(result.body),
    };
  } catch (err) {
    console.error('[api] fatal:', err);
    return {
      statusCode: 500,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
      body: JSON.stringify({ error: 'Internal error. Please try again.' }),
    };
  }
}

