import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createStore } from './src/storage/index.mjs';
import { createApp } from './src/api/app.mjs';
import {
  DEFAULT_PORT, MAX_SPREADSHEET_BYTES, APP_VERSION,
} from './src/core/constants.mjs';

/** Ordinary JSON payloads are capped tight (this is the 413 the feature suite pins).
 * Spreadsheet imports need more headroom: the app accepts files up to
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
 *
 * Production hardening:
 *  - async file I/O (no blocking stat/readSync in request path)
 *  - security headers (HSTS, CSP-lite, etc.)
 *  - simple per-IP rate limiting
 *  - request id + structured logging
 *  - graceful shutdown
 *  - health endpoint
 *  - CORS handling
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// ---- env validation at startup ----
function validateEnv() {
  if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  const storage = (process.env.STORAGE || 'json').toLowerCase();
  if (storage === 'airtable' && (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID)) {
    throw new Error('STORAGE=airtable requires AIRTABLE_API_KEY and AIRTABLE_BASE_ID');
  }
}
validateEnv();


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// ---- rate limiting (per-IP, in-memory, simple sliding window) ----
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = IS_PROD ? 300 : 1000; // per minute per IP
const RATE_MAX_API = IS_PROD ? 200 : 1000;
const ipHits = new Map(); // ip -> { count, resetAt, apiCount, apiResetAt }

function isRateLimited(ip, isApi) {
  const now = Date.now();
  let entry = ipHits.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS, apiCount: 0, apiResetAt: now + RATE_WINDOW_MS };
    ipHits.set(ip, entry);
  }
  if (isApi) {
    if (entry.apiResetAt <= now) {
      entry.apiCount = 0;
      entry.apiResetAt = now + RATE_WINDOW_MS;
    }
    entry.apiCount += 1;
    if (entry.apiCount > RATE_MAX_API) return true;
  }
  entry.count += 1;
  return entry.count > RATE_MAX_REQUESTS;
}

// Cleanup old entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipHits) {
    if (v.resetAt <= now && v.apiResetAt <= now) ipHits.delete(k);
  }
}, 60_000).unref?.();

// ---- security headers ----
function securityHeaders(isApi = false, isHtml = false) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
    'x-dns-prefetch-control': 'off',
  };
  if (IS_PROD) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  if (isApi) {
    headers['cache-control'] = 'no-store';
  } else if (isHtml) {
    headers['cache-control'] = 'no-cache, no-store, must-revalidate';
  } else {
    headers['cache-control'] = 'public, max-age=3600';
  }
  return headers;
}

const store = await createStore();
const app = await createApp(store);
console.log(`[ecod] storage backend: ${store.kind} | env: ${NODE_ENV}`);

function send(res, status, body, extraHeaders = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  const isHtml = extraHeaders['content-type']?.includes('text/html');
  const headers = {
    'content-type': isObj ? 'application/json; charset=utf-8' : (extraHeaders['content-type'] || 'application/octet-stream'),
    ...securityHeaders(isObj, isHtml),
    ...extraHeaders,
  };
  // Remove duplicate cache-control if extraHeaders already set
  if (extraHeaders['cache-control']) headers['cache-control'] = extraHeaders['cache-control'];
  res.writeHead(status, headers);
  res.end(payload);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Pre-resolve public files for faster checks? Keep simple but async.
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'Method not allowed' });
    return;
  }
  let filePath = path.resolve(PUBLIC, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  // Containment, not a string prefix: `p.startsWith('/x/public')` is also true
  // for '/x/public-archive/…', which would hand out files from a sibling
  // directory of the web root.
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    send(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || stat.isDirectory()) filePath = path.join(PUBLIC, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const data = await fsp.readFile(filePath);
    send(res, 200, data, { 'content-type': MIME[ext] || 'application/octet-stream' });
  } catch (err) {
    // If even index.html fails, 500
    if (filePath.endsWith('index.html')) {
      console.error('[static] failed to read index.html:', err.message);
      send(res, 500, { error: 'Internal error' });
    } else {
      // SPA fallback on any missing file
      try {
        const data = await fsp.readFile(path.join(PUBLIC, 'index.html'));
        send(res, 200, data, { 'content-type': 'text/html; charset=utf-8' });
      } catch {
        send(res, 500, { error: 'Internal error' });
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const reqId = randomBytes(6).toString('hex');
  const ip = clientIp(req);
  const start = Date.now();
  res.setHeader('x-request-id', reqId);

  // CORS for API (allow same origin, but also handle preflight)
  const origin = req.headers.origin;
  if (origin) {
    // In production, you may want to restrict origins. For now allow all but with safe defaults
    res.setHeader('access-control-allow-origin', IS_PROD ? origin : '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'content-length': '0', ...securityHeaders(true) });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check - fast, no auth
  // Served directly (ahead of rate limiting) so a monitor can always get a
  // verdict. The field set matches `GET /health` in the router — the Netlify
  // function has no such short-circuit and reaches the router instead, so the
  // two surfaces must agree or a check passes locally and fails in production.
  if (url.pathname === '/api/health' || url.pathname === '/health') {
    send(res, 200, {
      ok: true,
      version: APP_VERSION,
      storage: store.kind,
      env: NODE_ENV,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const isApi = url.pathname.startsWith('/api/');
  if (isRateLimited(ip, isApi)) {
    send(res, 429, { error: 'Too many requests. Please slow down.' }, { 'retry-after': '60' });
    return;
  }

  if (isApi) {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const limit = UPLOAD_PATHS.includes(url.pathname) ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
      const chunks = [];
      let size = 0;
      try {
        for await (const c of req) {
          chunks.push(c);
          size += c.length;
          if (size > limit) {
            send(res, 413, { error: 'Payload too large' });
            return;
          }
        }
      } catch {
        send(res, 400, { error: 'Failed to read request body' });
        return;
      }
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(res, 400, { error: 'Invalid JSON body' });
          return;
        }
      } else {
        body = {};
      }
    }
    try {
      const result = await app({
        method: req.method,
        path: url.pathname.replace(/^\/api/, '') || '/',
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
      send(res, result.status, result.body);
    } catch (err) {
      console.error(`[api] ${req.method} ${url.pathname} [${reqId}] failed:`, err);
      send(res, 500, { error: 'Internal error. Please try again.' });
    } finally {
      const dur = Date.now() - start;
      if (dur > 500 || IS_PROD) {
        console.log(`[req] ${req.method} ${url.pathname} ${res.statusCode} ${dur}ms ip=${ip} id=${reqId}`);
      }
    }
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => console.log(`[ecod] server on http://${HOST}:${PORT} (pid ${process.pid})`));

// Graceful shutdown
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ecod] ${signal} received, shutting down...`);
  server.close(() => {
    console.log('[ecod] http server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => {
    console.error('[ecod] forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[ecod] uncaughtException:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('[ecod] unhandledRejection:', err);
});
