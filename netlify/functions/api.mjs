import { createStore } from '../../src/storage/index.mjs';
import { createApp } from '../../src/api/app.mjs';

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
const getApp = () => (appPromise ||= createStore().then(async (store) => ({
  kind: store.kind,
  app: await createApp(store),
})));

const storageMisconfigured = () => ({
  statusCode: 503,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({
    error: 'Storage backend is not configured. Set STORAGE=blobs (recommended) or STORAGE=airtable with AIRTABLE_API_KEY and AIRTABLE_BASE_ID in the site environment, then redeploy.',
  }),
});

const MAX_BODY = 12_000_000; // 12MB max for uploads

export async function handler(event) {
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'access-control-allow-origin': event.headers?.origin || '*',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '86400',
          'cache-control': 'no-store',
        },
        body: '',
      };
    }

    const { kind, app } = await getApp();
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
        'access-control-allow-origin': event.headers?.origin || '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
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

