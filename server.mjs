import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/storage/index.mjs';
import { createApp } from './src/api/app.mjs';
import { DEFAULT_PORT, MAX_SPREADSHEET_BYTES } from './src/core/constants.mjs';

/** Ordinary JSON payloads are capped tight (this is the 413 the feature suite
 * pins). Spreadsheet imports need more headroom: the app accepts files up to
 * MAX_SPREADSHEET_BYTES, sent as base64, so ~1/3 extra + JSON overhead. */
const MAX_BODY_BYTES = 2e6;
const MAX_UPLOAD_BODY_BYTES = MAX_SPREADSHEET_BYTES * 1.5 + 1024 * 1024;
const UPLOAD_PATHS = [
  '/api/admin/candidates/import',
  '/api/admin/question-bank/import',
];

/**
 * Local development server: serves the static SPA from /public and routes
 * /api/* through the same transport-agnostic app the Netlify function uses.
 * Mirrors netlify.toml redirects: /api/* -> function, * -> /index.html.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const store = await createStore();
const app = await createApp(store);
console.log(`[ecod] storage backend: ${store.kind}`);

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': isObj ? 'application/json; charset=utf-8' : (headers['content-type'] || 'application/octet-stream'),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const limit = UPLOAD_PATHS.includes(url.pathname) ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
      const chunks = [];
      let size = 0;
      for await (const c of req) { chunks.push(c); size += c.length; if (size > limit) { send(res, 413, { error: 'Payload too large' }); return; } }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
      catch { send(res, 400, { error: 'Invalid JSON body' }); return; }
    }
    const result = await app({
      method: req.method,
      path: url.pathname.replace(/^\/api/, '') || '/',
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });
    send(res, result.status, result.body);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'Method not allowed' }); return; }
  let filePath = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(PUBLIC)) { send(res, 403, { error: 'Forbidden' }); return; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC, 'index.html'); // SPA fallback
  const ext = path.extname(filePath);
  send(res, 200, fs.readFileSync(filePath), { 'content-type': MIME[ext] || 'application/octet-stream' });
});

server.listen(PORT, HOST, () => console.log(`[ecod] dev server on http://${HOST}:${PORT}`));
