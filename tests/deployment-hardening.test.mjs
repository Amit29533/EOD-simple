/**
 * Deployment-hardening regressions.
 *
 * One file pinning every bug class found during the pre-deployment sweep, so a
 * future refactor cannot silently reintroduce a 500, a laundered "[object
 * Object]", a lost write, or an uncapped hostile spreadsheet:
 *
 *  - malformed percent-encoding in a route parameter -> 400, not 500
 *  - assessor score entries that are null / non-objects -> 400, not a TypeError
 *  - framework configs with null / non-object bands -> 422 with problems
 *  - structured values (objects/arrays) in text fields are rejected everywhere
 *    instead of being String()-laundered into storage
 *  - quitting review after the window expired records a time_expired event
 *  - the Netlify wrapper fails fast (503) when no storage backend is configured
 *  - the Airtable setup schema covers every field the adapter reads/writes
 *  - hostile .xlsx files (zip bomb, millions of rows) are capped, not inflated
 *  - id-less legacy rows still get their weighted quota and pin reservations
 *  - blob-store mutations read fresh, so concurrent instances cannot drop rows
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';
import { selectQuestions } from '../src/core/question-selection.mjs';
import { parseSheet, MAX_SHEET_ROWS } from '../src/core/sheet-parser.mjs';
import { createBlobsStore } from '../src/storage/netlify-blobs.mjs';
import { SCHEMA } from '../scripts/airtable-setup.mjs';

let app, store, adminToken, candidateToken, assessorToken;
let roleA, compA, candA, candUserId, assessmentId;

const call = (method, route, { token, body, query } = {}) =>
  app({ method, path: route, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-deploy-hardening-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  const mk = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mk({ username: 'admin', password: 'pw-admin', name: 'Admin', role: 'admin', email: '' });
  await mk({ username: 'assessor', password: 'pw-assessor', name: 'Assessor', role: 'assessor', email: '' });
  candA = await store.insert('candidates', { name: 'Candidate A', stage: 'assessment' });
  candUserId = (await mk({
    username: 'cand', password: 'pw-cand', name: 'Candidate A', role: 'candidate',
    email: '', candidate_id: candA.id,
  })).id;
  roleA = await store.insert('roles', { key: 'role-a', name: 'Role A', technology: 'A', description: '', active: true });
  compA = await store.insert('competencies', {
    role_id: roleA.id, key: 'a', name: 'A', category: 'technical',
    weight: 100, target_level: 4, order: 1, active: true,
  });
  adminToken = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'pw-admin' } })).body.token;
  assessorToken = (await call('POST', '/auth/login', { body: { username: 'assessor', password: 'pw-assessor' } })).body.token;
  candidateToken = (await call('POST', '/auth/login', { body: { username: 'cand', password: 'pw-cand' } })).body.token;

  const assessor = (await store.list('users', { username: 'assessor' }))[0];
  const snap = {
    role: { id: roleA.id, name: roleA.name },
    competencies: [{ id: compA.id, name: 'A', category: 'technical', weight: 100 }],
    questions: [{
      id: 'q1', competency_id: compA.id, type: 'text', prompt: 'Explain the medallion architecture.',
      points: 5, position: 1,
    }],
  };
  const a = await store.insert('assessments', {
    candidate_id: candA.id, assessor_id: assessor.id, role_id: roleA.id,
    status: 'submitted', submitted_at: new Date().toISOString(),
    snapshot_json: snap,
    quiz_state: { index: 1, phase: 'answer', question_started_at: new Date().toISOString(), events: [] },
  });
  assessmentId = a.id;
  await store.insert('responses', { assessment_id: a.id, question_id: 'q1', answer: 'Bronze, silver, gold.', locked: true });
});

/* ------------------------------------------------- routing: bad encoding */

test('a path parameter that is not valid percent-encoding is a 400, not a 500', async () => {
  const bad = await call('GET', '/admin/candidates/%ff', { token: adminToken });
  assert.equal(bad.status, 400, `malformed encoding must be rejected, got ${bad.status}`);
  assert.match(bad.body?.error || '', /encoding/i, 'the 400 says what was wrong, like every other 400');
  const bare = await call('GET', '/admin/candidates/100%', { token: adminToken });
  assert.equal(bare.status, 400, `a bare % must be rejected, got ${bare.status}`);
  const control = await call('GET', '/admin/candidates', { token: adminToken });
  assert.equal(control.status, 200, 'the control route must still work');
});

/* ------------------------------------------------- assessor score entries */

const putScores = (scores) => call('PUT', `/assessor/assessments/${assessmentId}/scores`, {
  token: assessorToken, body: { scores },
});

test('a null score entry is malformed input (400), not a TypeError (500)', async () => {
  const res = await putScores([null]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /question_id/);
});

test('non-object score entries (string, array, number) are 400, not 500', async () => {
  for (const entry of ['q1', ['q1'], 42, true]) {
    const res = await putScores([entry]);
    assert.equal(res.status, 400, `entry ${JSON.stringify(entry)} must be rejected, got ${res.status}`);
  }
});

test('a score entry for an unknown question is skipped, not fatal', async () => {
  const res = await putScores([{ question_id: 'no-such-question', score: 3 }]);
  assert.equal(res.status, 200);
});

test('an out-of-range score is 422 and a structured comment is 400', async () => {
  const range = await putScores([{ question_id: 'q1', score: 99 }]);
  assert.equal(range.status, 422);
  assert.match(range.body.error, /0-5/);
  const comment = await putScores([{ question_id: 'q1', comment: { text: 'nice' } }]);
  assert.equal(comment.status, 400);
  assert.match(comment.body.error, /plain text/);
});

test('a valid score still saves through the hardened path', async () => {
  const res = await putScores([{ question_id: 'q1', score: 4, comment: 'Solid.' }]);
  assert.equal(res.status, 200);
  const rows = await store.list('responses', { assessment_id: assessmentId });
  assert.equal(rows[0].assessor_score, 4);
  assert.equal(rows[0].assessor_comment, 'Solid.');
});

/* ------------------------------------------------- framework config bands */

const putFramework = (config, extra = {}) => call('PUT', '/admin/frameworks', {
  token: adminToken, body: { role_id: roleA.id, name: 'Custom', config, ...extra },
});

test('null readiness bands are a 422 with problems, not a TypeError', async () => {
  const config = structuredClone(DEFAULT_FRAMEWORK_CONFIG);
  config.readiness_bands = [null, null];
  const res = await putFramework(config);
  assert.equal(res.status, 422);
  assert.ok(res.body.problems?.length >= 1, 'the caller must learn what is wrong');
});

test('non-object readiness bands are a 422, not a crash', async () => {
  const config = structuredClone(DEFAULT_FRAMEWORK_CONFIG);
  config.readiness_bands = ['excellent', ['not', 'a', 'band']];
  const res = await putFramework(config);
  assert.equal(res.status, 422);
});

test('a structured framework name is rejected as plain-text-only', async () => {
  const res = await putFramework(structuredClone(DEFAULT_FRAMEWORK_CONFIG), { name: { v: 1 } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /plain text/);
});

test('a valid framework config still saves', async () => {
  const res = await putFramework(structuredClone(DEFAULT_FRAMEWORK_CONFIG));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, 'Custom');
});

/* ------------------------------------------------- structured-text laundering */

test('objects and arrays in text fields are rejected, never stored as "[object Object]"', async () => {
  const admin = { token: adminToken };
  const cases = [
    ['POST', '/admin/candidates', { name: { first: 'Ada' } }],
    ['PATCH', `/admin/candidates/${candA.id}`, { name: ['Ada'] }],
    ['POST', '/admin/users', { username: 'x', password: 'pw-x-12345', name: { v: 1 }, role: 'candidate' }],
    ['PATCH', `/admin/users/${candUserId}`, { name: ['x'] }],
    ['POST', '/admin/roles', { key: 'k', name: { v: 1 }, technology: 't' }],
    ['PATCH', `/admin/roles/${roleA.id}`, { technology: { v: 1 } }],
    ['POST', '/admin/competencies', { role_id: roleA.id, name: { v: 1 } }],
    ['PATCH', `/admin/competencies/${compA.id}`, { description: { v: 1 } }],
    ['POST', '/admin/questions', {
      role_id: roleA.id, competency_id: compA.id, type: 'mcq_single',
      prompt: 'Pick one.', help_text: { v: 1 },
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['a'],
    }],
    ['POST', '/admin/questions', {
      role_id: roleA.id, competency_id: compA.id, type: 'mcq_single',
      prompt: 'Pick one.', rubric: ['x'],
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correct_option_ids: ['a'],
    }],
  ];
  for (const [method, route, body] of cases) {
    const res = await call(method, route, { ...admin, body });
    assert.equal(res.status, 400, `${method} ${route} accepted ${JSON.stringify(body)} (got ${res.status})`);
    assert.match(String(res.body.error), /plain text/, `${method} ${route} must name the plain-text rule`);
  }
});

test('options with structured ids or labels cannot become served answer choices', async () => {
  const res = await call('POST', '/admin/questions', {
    token: adminToken,
    body: {
      role_id: roleA.id, competency_id: compA.id, type: 'mcq_single',
      prompt: 'Pick one.',
      options: [{ id: 'a', label: { text: 'A' } }, { id: 'b', label: 'B' }],
      correct_option_ids: ['b'],
    },
  });
  // The structured label is dropped, leaving one usable option — too few.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /two options/);
});

test('numbers in options still survive (stringified), as before', async () => {
  const res = await call('POST', '/admin/questions', {
    token: adminToken,
    body: {
      role_id: roleA.id, competency_id: compA.id, type: 'mcq_single',
      prompt: 'Pick the number.',
      options: [{ id: 1, label: 'One' }, { id: 2, label: 'Two' }],
      correct_option_ids: ['1'],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

/* ------------------------------------------------- bank authoring (form path) */

let bankPrompt = 0;
const bankQuestion = (overrides = {}) => ({
  module: 'T01', family: 'Advanced Technical Judgment', type: 'open',
  prompt: `Deployment-hardening probe ${++bankPrompt}: what breaks first under load?`,
  rubric: 'Names the bottleneck and the evidence for it.',
  ...overrides,
});

test('the bank form path rejects structured scalars instead of laundering them', async () => {
  for (const [field, value] of [['family', { name: 'T01' }], ['rubric', { text: 'x' }], ['module', ['T01']], ['mode', { m: 1 }]]) {
    const res = await call('POST', '/admin/question-bank/questions', {
      token: adminToken, body: bankQuestion({ [field]: value }),
    });
    assert.equal(res.status, 422, `${field}=${JSON.stringify(value)} must be rejected, got ${res.status}`);
    assert.match(JSON.stringify(res.body.errors || res.body), /plain text/);
  }
});

test('a structured tag inside an otherwise fine list is rejected', async () => {
  const res = await call('POST', '/admin/question-bank/questions', {
    token: adminToken, body: bankQuestion({ tags: ['latency', { tag: 'cost' }] }),
  });
  assert.equal(res.status, 422);
  assert.match(JSON.stringify(res.body.errors || res.body), /plain text/);
});

test('a plain list of tags is still accepted (no regression for array input)', async () => {
  const res = await call('POST', '/admin/question-bank/questions', {
    token: adminToken, body: bankQuestion({ tags: ['latency', 'cost'] }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // An open-question form post has no `options`, so it travels the sheet
  // canonicalization path — which used to drop the list without a word.
  assert.deepEqual(res.body.question.tags, ['latency', 'cost'], 'array tags must survive, not be silently dropped');
});

test('a bank PATCH with a structured scalar is rejected, not merged over the stored row', async () => {
  const created = await call('POST', '/admin/question-bank/questions', {
    token: adminToken, body: bankQuestion(),
  });
  assert.equal(created.status, 201);
  const res = await call('PATCH', `/admin/question-bank/questions/${created.body.question.id}`, {
    token: adminToken, body: { rubric: { deep: { value: 1 } } },
  });
  assert.equal(res.status, 422);
  assert.match(JSON.stringify(res.body.errors || res.body), /plain text/);
});

/* ------------------------------------------------- review-expiry integrity event */

async function reviewAssessment(questionStartedAt) {
  const a = await store.get('assessments', assessmentId);
  await store.update('assessments', assessmentId, {
    status: 'in_progress',
    submitted_at: null,
    quiz_state: {
      index: 0, phase: 'review', question_started_at: questionStartedAt, events: [],
    },
  });
  return a;
}

test('leaving review after the window expired records time_expired and still transitions', async () => {
  await reviewAssessment(new Date(Date.now() - 15 * 60_000).toISOString());
  const res = await call('POST', `/candidate/assessments/${assessmentId}/phase`, {
    token: candidateToken, body: { phase: 'answer' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.phase, 'answer');
  const a = await store.get('assessments', assessmentId);
  assert.equal(a.quiz_state.phase, 'answer');
  const events = a.quiz_state.events.map((e) => e.event);
  assert.ok(events.includes('time_expired'), `the overrun must be in the integrity trail, got ${JSON.stringify(events)}`);
});

test('leaving review inside the window transitions with no integrity event', async () => {
  await reviewAssessment(new Date().toISOString());
  const res = await call('POST', `/candidate/assessments/${assessmentId}/phase`, {
    token: candidateToken, body: { phase: 'answer' },
  });
  assert.equal(res.status, 200);
  const a = await store.get('assessments', assessmentId);
  assert.deepEqual(a.quiz_state.events, []);
});

/* ------------------------------------------------- netlify wrapper fail-fast */

test('the Netlify wrapper fails fast with 503 when no storage backend is configured', async () => {
  const saved = {
    STORAGE: process.env.STORAGE,
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  };
  delete process.env.STORAGE;
  delete process.env.AIRTABLE_API_KEY;
  delete process.env.AIRTABLE_BASE_ID;
  try {
    const { handler } = await import('../netlify/functions/api.mjs');
    for (const httpMethod of ['GET', 'POST', 'PUT', 'DELETE']) {
      const res = await handler({
        httpMethod, path: '/.netlify/functions/api/health',
        headers: {}, queryStringParameters: {},
      });
      assert.equal(res.statusCode, 503, `${httpMethod} must fail fast, got ${res.statusCode}`);
      assert.match(res.body, /STORAGE=blobs/, 'the 503 must tell the deployer exactly what to set');
    }
    // Preflight never touches storage, so it answers even when unconfigured.
    const pre = await handler({
      httpMethod: 'OPTIONS', path: '/.netlify/functions/api/health',
      headers: { origin: 'https://example.com', host: 'example.com' }, queryStringParameters: {},
    });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://example.com', 'the site itself is granted');
    assert.equal(pre.headers.vary, 'Origin');

    // The grant is same-origin (or CORS_ORIGINS) only: the wrapper used to
    // reflect any Origin header, turning the API into a cross-site target.
    const foreign = await handler({
      httpMethod: 'OPTIONS', path: '/.netlify/functions/api/health',
      headers: { origin: 'https://evil.example', host: 'example.com' }, queryStringParameters: {},
    });
    assert.equal(foreign.statusCode, 204);
    assert.equal(foreign.headers['access-control-allow-origin'], undefined, 'a foreign origin gets no grant');
    const savedCors = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = 'https://partner.example, https://evil.example';
    try {
      const listed = await handler({
        httpMethod: 'OPTIONS', path: '/.netlify/functions/api/health',
        headers: { origin: 'https://evil.example', host: 'example.com' }, queryStringParameters: {},
      });
      assert.equal(listed.headers['access-control-allow-origin'], 'https://evil.example', 'an allowlisted origin is granted');
    } finally {
      if (savedCors === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = savedCors;
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the Netlify wrapper enforces the same body caps and security headers as server.mjs', async () => {
  // Parity: the local server refuses ordinary JSON over 2 MB and gives the two
  // spreadsheet imports headroom for a base64 file; the function used to allow
  // 12 MB on every route. Every function response also has to carry the
  // security header set itself (netlify.toml [[headers]] only covers static
  // files) — including HSTS, which the wrapper did not send.
  const saved = { STORAGE: process.env.STORAGE, AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY, AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID };
  delete process.env.STORAGE; delete process.env.AIRTABLE_API_KEY; delete process.env.AIRTABLE_BASE_ID;
  try {
    const { handler } = await import('../netlify/functions/api.mjs');
    const post = (path, body, extra = {}) => handler({
      httpMethod: 'POST', path: `/.netlify/functions/api${path}`, headers: { host: 'example.com' },
      queryStringParameters: {}, body, ...extra,
    });
    const big = JSON.stringify({ pad: 'x'.repeat(2_100_000) });
    const huge = JSON.stringify({ pad: 'x'.repeat(14_000_000) });

    // Ordinary route: the 2 MB tier, checked before storage is even consulted.
    const tooBig = await post('/auth/login', big);
    assert.equal(tooBig.statusCode, 413, 'a 2.1 MB login body is refused');
    assert.match(tooBig.body, /too large/i);
    assert.equal(tooBig.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    assert.equal(tooBig.headers['x-content-type-options'], 'nosniff');
    assert.equal(tooBig.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(tooBig.headers['cache-control'], 'no-store');

    // Import route: the upload tier (a 2.1 MB body passes the size check and
    // reaches the storage guard — 503 here, because no backend is configured).
    const upload = await post('/admin/candidates/import', big);
    assert.equal(upload.statusCode, 503, 'the same body is inside the import tier');
    const uploadTooBig = await post('/admin/candidates/import', huge);
    assert.equal(uploadTooBig.statusCode, 413, 'but the import tier has a ceiling too');

    // A base64-encoded body is measured by its decoded size.
    const encoded = await post('/auth/login', Buffer.from(big).toString('base64'), { isBase64Encoded: true });
    assert.equal(encoded.statusCode, 413);

    // Malformed JSON is a 400 with the full header set.
    const badJson = await post('/auth/login', '{nope');
    assert.equal(badJson.statusCode, 400);
    assert.match(badJson.body, /Invalid JSON/);
    assert.equal(badJson.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

/* ------------------------------------------------- airtable setup coverage */

test('the Airtable setup schema covers every field the adapter reads and writes', () => {
  const names = (table) => new Set((SCHEMA[table] || []).map((f) => f.name));
  const expectFields = (table, fields) => {
    assert.ok(SCHEMA[table], `schema must define the ${table} table`);
    for (const f of fields) assert.ok(names(table).has(f), `schema.${table} is missing the ${f} field`);
  };
  expectFields('users', ['username', 'name', 'email', 'role', 'password_hash', 'candidate_id', 'active', 'created_at', 'updated_at']);
  expectFields('sessions', ['token', 'user_id', 'expires_at', 'created_at']);
  expectFields('candidates', ['name', 'email', 'years_experience', 'target_role_id', 'stage', 'created_at', 'updated_at']);
  expectFields('roles', ['key', 'name', 'technology', 'description', 'active', 'created_at', 'updated_at']);
  expectFields('competencies', ['role_id', 'key', 'name', 'category', 'description', 'weight', 'target_level', 'order', 'active']);
  expectFields('questions', ['role_id', 'competency_id', 'type', 'question_set', 'prompt', 'help_text',
    'options', 'correct_option_ids', 'rubric', 'points', 'difficulty', 'order',
    'active', 'pin_first', 'audio_required', 'created_at', 'updated_at']);
  expectFields('bank_questions', ['module', 'family_id', 'family', 'type', 'prompt', 'options',
    'correct_option_ids', 'rationale', 'probes', 'rubric', 'tags', 'red_flags', 'enrichment',
    'difficulty', 'band', 'minutes', 'mode', 'gap_tag', 'active', 'randomizable']);
  expectFields('bank_question_overrides', ['question_id', 'active', 'created_by', 'created_at']);
  expectFields('frameworks', ['role_id', 'name', 'config', 'active']);
  expectFields('assessments', ['candidate_id', 'role_id', 'assessor_id', 'status', 'snapshot_json',
    'report_json', 'quiz_state', 'overall_pct', 'question_count', 'total_points', 'question_limit', 'bank_total', 'role_name',
    'readiness_key', 'started_at', 'submitted_at', 'scored_at']);
  expectFields('responses', ['assessment_id', 'question_id', 'answer', 'auto_score',
    'assessor_score', 'assessor_comment', 'final_score', 'locked']);
  expectFields('recordings', ['assessment_id', 'question_id', 'audio', 'audio__2', 'audio__3', 'audio__4', 'audio__5', 'created_at', 'updated_at']);
  expectFields('audit_log', ['actor_id', 'actor_name', 'action', 'entity', 'entity_id', 'message', 'meta']);
});

/* ------------------------------------------------- hostile spreadsheets */

/** Minimal real zip (stored or raw-deflate entries) for the xlsx tests. */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.declared ?? e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.method, 10);
    c.writeUInt32LE(e.data.length, 20);
    c.writeUInt32LE(e.declared ?? e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + e.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const sheetXml = (rows) => Buffer.from(
  `<worksheet><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${
    cells.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')
  }</row>`).join('')}</sheetData></worksheet>`, 'utf8');

test('a worksheet part that declares an absurd size is refused, not inflated', () => {
  const zip = buildZip([{
    name: 'xl/worksheets/sheet1.xml',
    method: 8,
    data: deflateRawSync(Buffer.from('<worksheet/>')),
    declared: 100_000_000,
  }]);
  assert.throws(() => parseSheet(zip), /zip bomb/);
});

test('a hostile sheet with far more rows than allowed is capped, not read to the end', () => {
  const rows = [['Prompt', 'Answer']];
  for (let i = 0; i < MAX_SHEET_ROWS + 50; i += 1) rows.push([`Question ${i}`, `Answer ${i}`]);
  const zip = buildZip([{ name: 'xl/worksheets/sheet1.xml', method: 0, data: sheetXml(rows) }]);
  const { headers, rows: out } = parseSheet(zip);
  assert.deepEqual(headers, ['prompt', 'answer']);
  assert.equal(out.length, MAX_SHEET_ROWS - 1, `the grid must stop at ${MAX_SHEET_ROWS} rows`);
  assert.equal(out[0].prompt, 'Question 0');
});

test('a normal small workbook still parses end to end', () => {
  const zip = buildZip([{
    name: 'xl/worksheets/sheet1.xml', method: 0,
    data: sheetXml([['Prompt', 'Answer'], ['What is 2+2?', '4']]),
  }]);
  const { headers, rows } = parseSheet(zip);
  assert.deepEqual(headers, ['prompt', 'answer']);
  assert.deepEqual(rows, [{ prompt: 'What is 2+2?', answer: '4' }]);
});

test('self-closing empty rows are read as rows, never merged into the next one', () => {
  // `<row r="2"/>` used to be taken as an opening tag, so the row after it was
  // parsed as its content. The values survived because blank rows are dropped
  // afterwards; this pins the output shape while the grid is made to mirror
  // the sheet (so the row cap counts real rows).
  const xml = Buffer.from(
    '<worksheet><sheetData>'
    + '<row r="1"/>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>Prompt</t></is></c><c r="B2" t="inlineStr"><is><t>Answer</t></is></c></row>'
    + '<row r="3" spans="1:2"/>'
    + '<row r="4"><c r="A4" t="inlineStr"><is><t>What is 2+2?</t></is></c><c r="B4" t="inlineStr"><is><t>4</t></is></c></row>'
    + '<row r="5"/><row r="6"/>'
    + '<row r="7"><c t="inlineStr"><is><t>Capital of France?</t></is></c><c t="inlineStr"><is><t>Paris</t></is></c></row>'
    + '<row r="8"/>'
    + '</sheetData></worksheet>', 'utf8');
  const zip = buildZip([{ name: 'xl/worksheets/sheet1.xml', method: 0, data: xml }]);
  const { headers, rows } = parseSheet(zip);
  assert.deepEqual(headers, ['prompt', 'answer']);
  assert.deepEqual(rows, [
    { prompt: 'What is 2+2?', answer: '4' },
    { prompt: 'Capital of France?', answer: 'Paris' },
  ]);
});

/* ------------------------------------------------- id-less legacy rows in selection */

const idless = (competency_id, prompt, extra = {}) => ({
  competency_id, type: 'mcq_single', prompt, ...extra,
});
const COMPS = [{ id: 'c1', weight: 50 }, { id: 'c2', weight: 50 }];

test('id-less rows still get exactly the quota they are apportioned, no more', () => {
  const bank = [];
  for (const c of ['c1', 'c2']) for (let i = 0; i < 3; i += 1) bank.push(idless(c, `Question ${c}-${i}`));
  // Two competencies, quota two each: keying the keep-set by id collapsed
  // every id-less row onto the key `undefined` and served all six.
  const paper = selectQuestions(bank, COMPS, 4, { shuffle: false });
  assert.equal(paper.length, 4);
  const per = {};
  for (const q of paper) per[q.competency_id] = (per[q.competency_id] || 0) + 1;
  assert.deepEqual(per, { c1: 2, c2: 2 });
});

test('two id-less pinned questions are both reserved and both served first', () => {
  const bank = [
    idless('c1', 'Pinned opener one', { pin_first: true }),
    idless('c2', 'Pinned opener two', { pin_first: true }),
    idless('c1', 'Regular one'),
    idless('c2', 'Regular two'),
    idless('c1', 'Regular three'),
    idless('c2', 'Regular four'),
  ];
  const paper = selectQuestions(bank, COMPS, 3, { shuffle: false });
  assert.equal(paper.length, 3);
  assert.deepEqual(paper.slice(0, 2).map((q) => q.prompt), ['Pinned opener one', 'Pinned opener two']);
});

test('rows with ids are unaffected by the identity-based fix', () => {
  const bank = [];
  for (const c of ['c1', 'c2']) for (let i = 0; i < 3; i += 1) {
    bank.push({ id: `${c}-q${i}`, ...idless(c, `Question ${c}-${i}`) });
  }
  const paper = selectQuestions(bank, COMPS, 4, { shuffle: false });
  assert.equal(paper.length, 4);
});

/* ------------------------------------------------- blob-store fresh-read mutations */

function fakeBlobsBackend() {
  const data = {};
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    getStore: () => ({
      get: async (t) => (t in data ? clone(data[t]) : null),
      setJSON: async (t, rows) => { data[t] = clone(rows); },
    }),
  };
}

test('two blob-store instances inserting concurrently lose neither row', async () => {
  const backend = fakeBlobsBackend();
  const a = await createBlobsStore({ blobsModule: backend });
  const b = await createBlobsStore({ blobsModule: backend });
  await a.list('users'); // primes A's TTL cache with the then-empty table
  await b.insert('users', { id: 'u-x', username: 'x' });
  await a.insert('users', { id: 'u-y', username: 'y' });
  // Read through a third instance so no cache can hide a dropped write.
  const c = await createBlobsStore({ blobsModule: backend });
  const ids = (await c.list('users')).map((r) => r.id).sort();
  assert.deepEqual(ids, ['u-x', 'u-y'], 'the instance with the stale cache must not clobber the other write');
});

test('a failed blob read on the write path throws and leaves the table intact', async () => {
  // `readFresh` used to swallow a read error and hand back `{}`: the mutation
  // then ran its read-modify-write over an EMPTY table and wrote that back, so
  // one transient blob-service hiccup collapsed a 50-answer paper to the one
  // row being written. A read that fails must fail the write.
  const data = {};
  let failReads = 0;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const backend = {
    getStore: () => ({
      get: async (t) => {
        if (failReads > 0) { failReads -= 1; throw new Error('503 from the blob service'); }
        return t in data ? clone(data[t]) : null;
      },
      setJSON: async (t, rows) => { data[t] = clone(rows); },
    }),
  };
  const store = await createBlobsStore({ blobsModule: backend });
  for (let i = 0; i < 20; i += 1) await store.insert('roles', { id: `r${i}`, answer: 'b' });
  failReads = 1;
  await assert.rejects(store.insert('roles', { id: 'r-new', answer: 'b' }), /503/);
  assert.equal(Object.keys(data.roles).length, 20, 'the table was not replaced by the one row being written');
  failReads = 1;
  await assert.rejects(store.update('roles', 'r1', { answer: 'a' }), /503/);
  failReads = 1;
  await assert.rejects(store.removeMany('roles', ['r1', 'r2']), /503/);
  assert.equal(Object.keys(data.roles).length, 20);
  // A failed read on the query side is an error too, not an empty table (a
  // login used to fail as "invalid credentials" instead of a retryable 500).
  failReads = 1;
  await assert.rejects(store.list('users'), /503/);
  // Once the service is back, everything works and nothing was lost.
  await store.insert('roles', { id: 'r-new', answer: 'b' });
  assert.equal(Object.keys(data.roles).length, 21);
});

test('blob-store mutations and session reads use strong consistency; cached reads stay eventual', async () => {
  // Netlify Blobs reads are eventually consistent by default (a read may
  // return the previous copy for up to a minute). A read-modify-write over
  // such a copy resurrects whatever it lacked, and a session written by one
  // function instance is invisible to the next — so those reads ask for
  // `consistency: 'strong'`. Ordinary list/get reads keep the fast path.
  const data = {};
  const calls = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const backend = {
    getStore: () => ({
      get: async (t, o) => { calls.push(`${t}:${o?.consistency || 'eventual'}`); return t in data ? clone(data[t]) : null; },
      setJSON: async (t, rows) => { data[t] = clone(rows); },
    }),
  };
  const store = await createBlobsStore({ blobsModule: backend });
  await store.insert('users', { id: 'u1' });
  await store.update('users', 'u1', { n: 1 });
  await store.updateMany('users', [{ id: 'u1', patch: { n: 2 } }]);
  await store.remove('users', 'u1');
  await store.insertMany('users', [{ id: 'u2' }]);
  await store.removeMany('users', ['u2']);
  assert.deepEqual([...new Set(calls)], ['users:strong'], 'every mutation reads its table strongly');
  calls.length = 0;
  await store.list('sessions');
  await store.get('sessions', 'nope');
  assert.deepEqual(calls, ['sessions:strong', 'sessions:strong'], 'sessions are never served stale');
  calls.length = 0;
  await store.get('assessments', 'a1');
  await store.get('assessments', 'a1'); // no TTL cache either: the exam decides from this read
  await store.list('responses', { assessment_id: 'a1' });
  await store.list('responses', { assessment_id: 'a1' });
  // responses are one blob per assessment (`shards/responses/a1`); an absent
  // shard checks the pre-shard `responses` table once for rows to move over.
  assert.deepEqual(calls, ['assessments:strong', 'assessments:strong', 'shards/responses/a1:strong', 'responses:strong', 'shards/responses/a1:strong'],
    'the exam tables are read strongly and never from the cache');
  calls.length = 0;
  const other = await createBlobsStore({ blobsModule: backend });
  await other.list('roles');
  await other.get('roles', 'x'); // TTL cache hit — no read at all
  assert.deepEqual(calls, ['roles:eventual'], 'plain reads keep the fast eventual path and the TTL cache');
});

test('an environment without strong-consistency support falls back to eventual reads once', async () => {
  // Outside the Netlify runtime the SDK has no uncached edge URL and throws
  // BlobsConsistencyError for a strong read. The adapter must keep working
  // (eventual reads) instead of failing every write.
  const data = {};
  const calls = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const backend = {
    getStore: () => ({
      get: async (t, o) => {
        calls.push(o?.consistency || 'eventual');
        if (o?.consistency === 'strong') { const e = new Error('no uncachedEdgeURL'); e.name = 'BlobsConsistencyError'; throw e; }
        return t in data ? clone(data[t]) : null;
      },
      setJSON: async (t, rows) => { data[t] = clone(rows); },
    }),
  };
  const store = await createBlobsStore({ blobsModule: backend });
  await store.insert('users', { id: 'u1' });
  await store.insert('users', { id: 'u2' });
  await store.list('sessions');
  assert.deepEqual(calls, ['strong', 'eventual', 'eventual', 'eventual'], 'one strong attempt, then eventual for good');
  assert.deepEqual(Object.keys(data.users), ['u1', 'u2']);
});

test('an update over a stale cache keeps the other instance\'s patch', async () => {
  const backend = fakeBlobsBackend();
  const a = await createBlobsStore({ blobsModule: backend });
  const b = await createBlobsStore({ blobsModule: backend });
  await a.insert('users', { id: 'u1', n: 'a' });
  await a.get('users', 'u1'); // primes A's cache with { n: 'a' }
  await b.update('users', 'u1', { n: 'b' });
  await a.update('users', 'u1', { m: 1 }); // must merge onto { n: 'b' }, not onto the stale copy
  const c = await createBlobsStore({ blobsModule: backend });
  const row = await c.get('users', 'u1');
  assert.equal(row.n, 'b');
  assert.equal(row.m, 1);
});
