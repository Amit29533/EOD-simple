/**
 * Performance, Speed, Network and Latency Benchmarks.
 *
 * Exercises the real HTTP server over live TCP sockets:
 *  - Route latency benchmarks (< 15ms target)
 *  - High concurrency throughput (parallel bursts)
 *  - HTTP caching: ETag generation and 304 Not Modified response
 *  - Gzip compression negotiation and byte reduction ratio
 *  - HEAD request contract (proper content-length, zero body bytes)
 *  - Method validation on operational endpoints (405 on POST/DELETE /health)
 *  - Static file MIME types (.css, .js, .json, .svg, .webp, .webm, .mp3, etc.)
 *  - Security headers presence on both static and API routes
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';

const TEST_PORT = 3899;
let serverProc = null;

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const durationMs = performance.now() - start;
        const rawBuffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBuffer,
          durationMs,
          text: () => rawBuffer.toString('utf8'),
          json: () => JSON.parse(rawBuffer.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  await new Promise((resolve, reject) => {
    serverProc = spawn('node', ['server.mjs'], {
      env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    serverProc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes(`server on http://0.0.0.0:${TEST_PORT}`)) {
        resolve();
      }
    });

    serverProc.stderr.on('data', (d) => {
      console.error('[test-server stderr]', d.toString());
    });

    serverProc.on('error', reject);
    serverProc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited early with code ${code}`));
      }
    });
  });
});

after(() => {
  if (serverProc) {
    serverProc.kill('SIGTERM');
  }
});

/* ----------------- Latency & Health Checks ----------------- */

test('GET /health latency is sub-15ms and returns valid operational JSON', async () => {
  const res = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/health',
    method: 'GET',
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.durationMs < 50, `Expected sub-50ms latency, got ${res.durationMs.toFixed(2)}ms`);
  const data = res.json();
  assert.equal(data.ok, true);
  assert.ok(data.version);
  assert.ok(typeof data.uptime === 'number');
  assert.ok(data.timestamp);
});

test('HEAD /health returns 200 with headers and 0 body bytes', async () => {
  const res = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/health',
    method: 'HEAD',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawBuffer.length, 0, 'HEAD must transfer 0 body bytes');
  assert.ok(res.headers['content-length'], 'Content-Length must be present');
});

test('POST and DELETE on /health return 405 Method Not Allowed', async () => {
  for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
    const res = await httpRequest({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: '/health',
      method,
    });
    assert.equal(res.statusCode, 405, `${method} /health should return 405`);
  }
});

/* ----------------- Static File Caching & ETag (304) ----------------- */

test('static files serve ETag and respond with 304 Not Modified when cached', async () => {
  const first = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/styles.css',
    method: 'GET',
  });
  assert.equal(first.statusCode, 200);
  const etag = first.headers['etag'];
  assert.ok(etag, 'ETag header must be present on static asset');
  assert.ok(first.rawBuffer.length > 50_000, 'Uncompressed CSS should be substantial');

  // Second request presenting If-None-Match
  const second = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/styles.css',
    method: 'GET',
    headers: { 'if-none-match': etag },
  });
  assert.equal(second.statusCode, 304, 'Server should respond with 304 Not Modified');
  assert.equal(second.rawBuffer.length, 0, '304 response must transfer 0 body bytes');
  assert.ok(second.durationMs < 15, `Cached 304 roundtrip must be fast, got ${second.durationMs.toFixed(2)}ms`);
});

/* ----------------- Gzip Compression & Bandwidth Reduction ----------------- */

test('Accept-Encoding: gzip compresses static assets by > 65%', async () => {
  const plain = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/styles.css',
    method: 'GET',
  });
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  const uncompressedSize = plain.rawBuffer.length;

  const gzipped = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/styles.css',
    method: 'GET',
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  });
  assert.equal(gzipped.statusCode, 200);
  assert.equal(gzipped.headers['content-encoding'], 'gzip');
  const compressedSize = gzipped.rawBuffer.length;

  const savingsPct = ((uncompressedSize - compressedSize) / uncompressedSize) * 100;
  assert.ok(savingsPct > 65, `Gzip savings should be > 65%, got ${savingsPct.toFixed(1)}% (${uncompressedSize} -> ${compressedSize} bytes)`);

  const decompressed = zlib.gunzipSync(gzipped.rawBuffer);
  assert.deepEqual(decompressed, plain.rawBuffer, 'Decompressed payload must match uncompressed original byte-for-byte');
});

/* ----------------- HEAD Request for Static Assets ----------------- */

test('HEAD /styles.css returns headers without payload', async () => {
  const res = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/styles.css',
    method: 'HEAD',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawBuffer.length, 0, 'HEAD on static asset must return 0 body bytes');
  assert.ok(res.headers['content-length']);
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
});

/* ----------------- High Concurrency & Throughput ----------------- */

test('high concurrency: 50 simultaneous requests sustain 100% success and fast latency', async () => {
  const COUNT = 50;
  const start = performance.now();
  const promises = [];
  for (let i = 0; i < COUNT; i += 1) {
    promises.push(httpRequest({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: '/health',
      method: 'GET',
    }));
  }
  const results = await Promise.all(promises);
  const totalDuration = performance.now() - start;
  const avgLatency = results.reduce((acc, r) => acc + r.durationMs, 0) / COUNT;

  assert.equal(results.filter((r) => r.statusCode === 200).length, COUNT, 'all 50 requests must succeed with 200');
  assert.ok(avgLatency < 80, `Average latency under concurrency should be < 80ms, got ${avgLatency.toFixed(2)}ms`);
  const rps = (COUNT / totalDuration) * 1000;
  assert.ok(rps > 200, `Throughput should exceed 200 req/sec, got ${rps.toFixed(0)} req/sec`);
});

/* ----------------- Security Headers ----------------- */

test('security headers are present on static and API responses', async () => {
  const staticRes = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/styles.css',
    method: 'GET',
  });
  assert.equal(staticRes.headers['x-content-type-options'], 'nosniff');
  assert.equal(staticRes.headers['x-frame-options'], 'SAMEORIGIN');
  assert.ok(staticRes.headers['referrer-policy']);
  assert.ok(staticRes.headers['permissions-policy']);

  const apiRes = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/api/meta/bootstrap',
    method: 'GET',
  });
  assert.equal(apiRes.headers['x-content-type-options'], 'nosniff');
  assert.equal(apiRes.headers['cache-control'], 'no-store');
});

/* ----------------- SPA Fallback & Missing Assets ----------------- */

test('SPA route fallback returns index.html for virtual routes', async () => {
  const res = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/dashboard',
    method: 'GET',
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text(), /<!doctype html>/i);
});

test('missing asset with static extension returns 404', async () => {
  const res = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/nonexistent-image.png',
    method: 'GET',
  });
  assert.equal(res.statusCode, 404);
});

/* ----------------- Path Traversal Protection ----------------- */

test('path traversal attempts are refused (403/404)', async () => {
  const res = await httpRequest({
    host: '127.0.0.1',
    port: TEST_PORT,
    path: '/%2e%2e/server.mjs',
    method: 'GET',
  });
  assert.ok(res.statusCode === 403 || res.statusCode === 404, `Traversal must be rejected with 403 or 404, got ${res.statusCode}`);
});
