import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeWorld } from './helpers/world.mjs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { EXAM_SESSION_MS } from '../src/api/exam-expiry.mjs';

test('real HTTP booking survives server restarts and enforces opening, expiry and single use', { timeout: 30_000 }, async (t) => {
  const w = await makeWorld({ mcq: 2, open: 1 });
  const file = path.join(w.tmp, 'db.json');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let server, logs = '';
  const stop = async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited;
    }
  };
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(w.tmp), os.tmpdir()); assert.ok(path.basename(w.tmp).startsWith('ecod-pov-'));
    await fs.rm(w.tmp, { recursive: true, force: true });
  });
  const start = async () => {
    server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, STORAGE: 'json',
      DATA_FILE: file, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-6000); });
    server.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-6000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(server.exitCode, null, logs);
      try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Server startup failed: ${logs}`);
  };
  const call = async (method, url, token, body) => {
    const r = await fetch(origin + '/api' + url, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.match(r.headers.get('cache-control'), /no-store/);
    return { status: r.status, body: await r.json() };
  };
  await start();
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200); assert.match(await page.text(), /js\/app.js/);
  const publicModule = await fetch(origin + '/js/views/bookings.js');
  assert.equal(publicModule.status, 200); assert.match(await publicModule.text(), /publicBookingView/);
  assert.match(publicModule.headers.get('cache-control'), /no-cache/, 'unversioned application modules must revalidate after an update');
  const stylesheet = await fetch(origin + '/styles.css');
  assert.match(stylesheet.headers.get('cache-control'), /no-cache/);
  const cachedStylesheet = await fetch(origin + '/styles.css', { headers: { 'if-none-match': stylesheet.headers.get('etag') } });
  assert.equal(cachedStylesheet.status, 304); assert.match(cachedStylesheet.headers.get('cache-control'), /no-cache/);
  const link = await call('POST', '/admin/test-bookings/links', w.tok, { role_id: w.role.id });
  assert.equal(link.status, 201);
  const invitationToken = link.body.path.split('/').at(-1);
  assert.equal((await call('POST', '/public/test-bookings/lookup', null, { token: invitationToken })).status, 200);
  const body = { token: invitationToken, request_id: 'http-booking-request-1234', name: 'HTTP Candidate', email: 'http.booking@example.com',
    phone: '+91 9876543210', role_id: w.role.id, date: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10),
    time: '10:00', password: 'HTTP-candidate-password-2026', confirm_password: 'HTTP-candidate-password-2026' };
  const booked = await call('POST', '/public/test-bookings', null, body);
  assert.equal(booked.status, 200);
  assert.equal((await call('POST', '/public/test-bookings', null, { ...body, request_id: 'second-http-request-1234' })).status, 409);
  const login = await call('POST', '/auth/login', null, { username: body.email, password: body.password });
  assert.equal(login.status, 200); const token = login.body.token;
  const id = booked.body.exam_path.split('/')[2], base = `/candidate/assessments/${id}`;
  assert.equal((await call('GET', base, token)).status, 409);
  assert.equal((await call('GET', '/admin/dashboard', w.tok)).body.counts.upcoming_tests, 1);

  const setWindow = async (startTime) => {
    await stop();
    const store = createJsonStore(file);
    const values = { scheduled_at: new Date(startTime).toISOString(), scheduled_end_at: new Date(startTime + EXAM_SESSION_MS).toISOString() };
    await store.update('test_bookings', link.body.invitation.id, values);
    await store.update('assessments', id, values);
    await start();
  };
  await setWindow(Date.now() - 60_000);
  const opened = await call('GET', base, token);
  assert.equal(opened.status, 200); assert.equal(opened.body.assessment.status, 'in_progress');
  assert.ok(opened.body.exam.session_remaining_ms < EXAM_SESSION_MS);
  const q = opened.body.current_question;
  if (opened.body.exam.phase === 'review')
    assert.equal((await call('POST', base + '/phase', token, { phase: 'answer', question_id: q.id })).status, 200);
  const answer = q.type === 'text' ? { text: 'Persisted HTTP answer', transcript: 'Persisted HTTP answer' } : q.options[0].id;
  assert.equal((await call('PUT', base + '/answers', token, { answers: { [q.id]: answer } })).status, 200);
  const draft = (await call('GET', base, token)).body.current_answer;
  await setWindow(Date.now() - EXAM_SESSION_MS - 1000);
  const expired = await call('GET', base, token);
  assert.equal(expired.status, 200); assert.equal(expired.body.assessment.status, 'submitted');
  assert.equal(expired.body.assessment.exam_expired, true); assert.equal(expired.body.current_question, null);
  assert.equal((await call('PUT', base + '/answers', token, { answers: { [q.id]: answer } })).status, 409);
  assert.equal((await call('POST', '/public/test-bookings/lookup', null, { token: invitationToken })).status, 409);
  assert.equal((await call('GET', '/admin/dashboard', w.tok)).body.counts.upcoming_tests, 0);
  await stop();
  assert.deepEqual((await createJsonStore(file).list('responses', { assessment_id: id }))[0].answer, draft);
});
