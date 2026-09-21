import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { createStore } from './src/storage/index.mjs';
import { createApp } from './src/api/app.mjs';
import { corsAllowOrigin, corsHeaders } from './src/api/cors.mjs';
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
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
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

function send(req, res, status, body, extraHeaders = {}) {
  const isHead = req?.method === 'HEAD';
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const rawPayload = isObj ? JSON.stringify(body) : body;
  const isHtml = extraHeaders['content-type']?.includes('text/html');
  const headers = {
    'content-type': isObj ? 'application/json; charset=utf-8' : (extraHeaders['content-type'] || 'application/octet-stream'),
    ...securityHeaders(isObj, isHtml),
    ...extraHeaders,
  };
  // Remove duplicate cache-control if extraHeaders already set
  if (extraHeaders['cache-control']) headers['cache-control'] = extraHeaders['cache-control'];

  if (status === 204 || status === 304) {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  const buf = Buffer.isBuffer(rawPayload)
    ? rawPayload
    : Buffer.from(typeof rawPayload === 'string' ? rawPayload : String(rawPayload || ''), 'utf8');

  // Gzip compression for compressible responses >= 1KB when client requests it
  const acceptEncoding = req?.headers?.['accept-encoding'] || '';
  const canCompress = /\bgzip\b/i.test(acceptEncoding) &&
    status >= 200 && status < 300 &&
    buf.length >= 1024 &&
    /^(text\/|application\/(json|javascript)|image\/svg\+xml)/i.test(headers['content-type'] || '');

  if (canCompress) {
    const compressed = zlib.gzipSync(buf);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(compressed.length);
    res.writeHead(status, headers);
    if (isHead) {
      res.end();
    } else {
      res.end(compressed);
    }
    return;
  }

  headers['content-length'] = String(buf.length);
  res.writeHead(status, headers);
  if (isHead) {
    res.end();
  } else {
    res.end(buf);
  }
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Pre-resolve public files for faster checks? Keep simple but async.
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, { error: 'Method not allowed' });
    return;
  }
  let safePath;
  try {
    safePath = decodeURIComponent(url.pathname);
  } catch {
    send(req, res, 400, { error: 'Bad request' });
    return;
  }
  let filePath = path.resolve(PUBLIC, '.' + (safePath === '/' ? '/index.html' : safePath));
  // Containment, not a string prefix: `p.startsWith('/x/public')` is also true
  // for '/x/public-archive/…', which would hand out files from a sibling
  // directory of the web root.
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    send(req, res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    let stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || stat.isDirectory()) {
      const ext = path.extname(filePath).toLowerCase();
      // If a specific file asset with an extension was requested and not found, return 404
      if (ext && ext !== '.html') {
        send(req, res, 404, { error: 'Not found' });
        return;
      }
      filePath = path.join(PUBLIC, 'index.html');
      stat = await fsp.stat(filePath).catch(() => null);
    }
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    const etag = stat ? `W/"${Math.floor(stat.mtimeMs).toString(16)}-${stat.size.toString(16)}"` : null;
    if (etag && req.headers['if-none-match'] === etag) {
      const headers = {
        etag,
        ...securityHeaders(false, isHtml),
      };
      send(req, res, 304, null, headers);
      return;
    }
    const data = await fsp.readFile(filePath);
    const extraHeaders = {
      'content-type': MIME[ext] || 'application/octet-stream',
    };
    if (etag) extraHeaders.etag = etag;
    send(req, res, 200, data, extraHeaders);
  } catch (err) {
    // If even index.html fails, 500
    if (filePath.endsWith('index.html')) {
      console.error('[static] failed to read index.html:', err.message);
      send(req, res, 500, { error: 'Internal error' });
    } else {
      // SPA fallback on any missing file
      try {
        const data = await fsp.readFile(path.join(PUBLIC, 'index.html'));
        send(req, res, 200, data, { 'content-type': 'text/html; charset=utf-8' });
      } catch {
        send(req, res, 500, { error: 'Internal error' });
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const reqId = randomBytes(6).toString('hex');
  const ip = clientIp(req);
  const start = Date.now();
  res.setHeader('x-request-id', reqId);

  // CORS: same-origin requests (and any origin listed in CORS_ORIGINS) get a
  // grant; in development every origin does. Production used to reflect any
  // Origin header back, which made the API callable from any web page.
  const allowOrigin = corsAllowOrigin({
    origin: req.headers.origin,
    host: req.headers['x-forwarded-host'] || req.headers.host,
    allowlist: process.env.CORS_ORIGINS,
    permissive: !IS_PROD,
  });
  for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) res.setHeader(k, v);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'content-length': '0', ...securityHeaders(true) });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check - fast, no auth
  // Served directly (ahead of rate limiting) so a monitor can always get a
  // verdict. The field set is IDENTICAL to `GET /health` in the router — the
  // Netlify function has no such short-circuit and reaches the router instead,
  // so the two surfaces must agree or a check passes locally and fails in
  // production. Do not add fields here without adding them to meta.mjs too
  // (tests/health-route.test.mjs pins the app-level shape).
  if (url.pathname === '/api/health' || url.pathname === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(req, res, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    send(req, res, 200, {
      ok: true,
      version: APP_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const isApi = url.pathname.startsWith('/api/');
  if (isRateLimited(ip, isApi)) {
    send(req, res, 429, { error: 'Too many requests. Please slow down.' }, { 'retry-after': '60' });
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
            send(req, res, 413, { error: 'Payload too large' });
            return;
          }
        }
      } catch {
        send(req, res, 400, { error: 'Failed to read request body' });
        return;
      }
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(req, res, 400, { error: 'Invalid JSON body' });
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
      send(req, res, result.status, result.body, result.headers);
    } catch (err) {
      console.error(`[api] ${req.method} ${url.pathname} [${reqId}] failed:`, err);
      send(req, res, 500, { error: 'Internal error. Please try again.' });
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

// A busy port is a configuration mistake, not a crash. Without this the raw
// EADDRINUSE surfaces through the uncaughtException hook as a stack trace and
// the operator has to read it to learn what to change.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[ecod] port ${PORT} is already in use — stop the other process or start elsewhere: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err; // every other listen failure keeps going through the crash hook
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
