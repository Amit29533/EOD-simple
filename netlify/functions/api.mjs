import { createStore } from '../../src/storage/index.mjs';
import { createApp } from '../../src/api/app.mjs';

/**
 * Netlify Function wrapper around the transport-agnostic app.
 * All routes live under /api/* (see netlify.toml redirects).
 */
let appPromise;
const getApp = () => (appPromise ||= createStore().then(createApp));

export async function handler(event) {
  try {
    const app = await getApp();
    let body;
    if (event.body) {
      try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); }
      catch { return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
    }
    const path = (event.path || '/').replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';
    const result = await app({
      method: event.httpMethod,
      path,
      query: event.queryStringParameters || {},
      headers: event.headers || {},
      body,
    });
    return {
      statusCode: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify(result.body),
    };
  } catch (err) {
    console.error('[api] fatal:', err);
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Internal error. Please try again.' }) };
  }
}
