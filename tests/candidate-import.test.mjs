import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

/** Bulk candidate + portal-user import: template, dry run, commit, credentials. */

let app, store, adminToken, candidateToken;
const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-cand-import-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);

  const mk = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mk({ username: 'admin', password: 'pw-admin', name: 'Admin', role: 'admin', email: '' });
  const candidate = await store.insert('candidates', { name: 'Existing Candidate', stage: 'intake' });
  await mk({
    username: 'cand', password: 'pw-cand', name: 'Existing Candidate', role: 'candidate',
    email: '', candidate_id: candidate.id,
  });

  // One assessment track so "Target role" can be resolved by name, key and id.
  const role = await store.insert('roles', {
    key: 'databricks-rsa', name: 'Resident Solutions Architect (RSA)',
    technology: 'Databricks', active: true,
  });
  global.__ROLE_ID = role.id;

  // An existing candidate + user to prove duplicate detection against the store.
  await store.insert('candidates', { name: 'Already There', email: 'dup@example.com', stage: 'intake' });
  await mk({ username: 'existing.user', password: 'pw-existing', name: 'Existing User', role: 'assessor', email: '' });

  adminToken = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'pw-admin' } })).body.token;
  candidateToken = (await call('POST', '/auth/login', { body: { username: 'cand', password: 'pw-cand' } })).body.token;
});

const csv = (rows) => rows.map((r) => r.join(',')).join('\n');

test('the import template is downloadable by admins only', async () => {
  const res = await call('GET', '/admin/candidates/import-template', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.filename, 'ecod-candidates-import-template.csv');
  assert.equal(res.body.content_type, 'text/csv');
  const keys = res.body.columns.map((c) => c.key);
  for (const k of ['Name', 'Email', 'Target role', 'Pipeline stage', 'Username', 'Password', 'Notes']) {
    assert.ok(keys.includes(k), `${k} advertised`);
  }
  assert.match(res.body.csv, /^Name,Email,Phone,Current title,Years of experience/);

  assert.equal((await call('GET', '/admin/candidates/import-template')).status, 401);
  assert.equal((await call('GET', '/admin/candidates/import-template', { token: candidateToken })).status, 403);
  assert.equal((await call('POST', '/admin/candidates/import', { token: candidateToken, body: { csv: 'a,b\n' } })).status, 403);
});

test('a dry run validates every row and writes nothing', async () => {
  const beforeCandidates = (await store.list('candidates')).length;
  const beforeUsers = (await store.list('users')).length;

  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true,
      create_users: true,
      filename: 'candidates.csv',
      csv: csv([
        ['Name', 'Email', 'Target role', 'Pipeline stage', 'Username', 'Password'],
        ['Asha Sharma', 'asha@example.com', 'Resident Solutions Architect (RSA)', 'Candidate Intake', 'asha.sharma', 'Onboard-2026!'],
        ['Bilal Khan', 'bilal@example.com', '', 'Role Mapping', '', ''],
        // missing name
        ['', 'noname@example.com', '', '', '', ''],
        // duplicate of the seeded candidate's email
        ['Second Dup', 'dup@example.com', '', '', 'dup.user', 'password-123'],
        // duplicate inside the same file (same email as Asha)
        ['Asha Again', 'asha@example.com', '', '', '', ''],
        // bad inputs
        ['Bad Role', 'badrole@example.com', 'Nope Track', '', 'bad.role', 'password-123'],
        ['Bad Stage', 'badstage@example.com', '', 'Quantum Leap', '', ''],
        ['Short Pass', 'short@example.com', '', '', 'short.user', 'tiny'],
      ]),
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 2, 'the two good rows are ready');
  assert.equal(res.body.rejected, 4, 'the four broken rows explain themselves');
  assert.equal(res.body.duplicates, 2, 'existing + in-file repeats are separate');
  assert.equal(res.body.dry_run, true);
  assert.equal(res.body.imported, 0);
  assert.equal(res.body.users_created, 0);
  assert.deepEqual(res.body.credentials, []);

  const preview = res.body.preview;
  assert.equal(preview.length, 2);
  assert.deepEqual(preview[0], {
    line: 2, name: 'Asha Sharma', target_role: 'Resident Solutions Architect (RSA)',
    stage: 'intake', username: 'asha.sharma',
  });
  // Username was blank -> derived from the email local part.
  assert.equal(preview[1].username, 'bilal', 'derived from the email local part');

  // Nothing was written by the dry run.
  assert.equal((await store.list('candidates')).length, beforeCandidates);
  assert.equal((await store.list('users')).length, beforeUsers);
});

test('the commit creates candidates and linked portal users with credentials returned once', async () => {
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: false,
      create_users: true,
      filename: 'candidates.csv',
      csv: csv([
        ['Name', 'Email', 'Current title', 'Years of experience', 'Target role', 'Stage', 'Username', 'Password', 'Notes'],
        ['Asha Sharma', 'asha@example.com', 'Data Engineer', '8', 'Resident Solutions Architect (RSA)', 'Candidate Intake', 'asha.sharma', 'Onboard-2026!', 'Delta Lake depth'],
        ['Bilal Khan', 'bilal@example.com', 'Solutions Architect', '12', '', 'Role Mapping', '', '', ''],
      ]),
    },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported, 2);
  assert.equal(res.body.users_created, 2);
  assert.equal(res.body.credentials.length, 2);

  const asha = (await store.list('candidates')).find((c) => c.email === 'asha@example.com');
  const bilal = (await store.list('candidates')).find((c) => c.email === 'bilal@example.com');
  assert.ok(asha && bilal, 'both candidates persisted');
  assert.equal(asha.target_role_id, global.__ROLE_ID, 'target role resolved by name');
  assert.equal(asha.stage, 'intake', 'explicit stage kept');
  assert.equal(asha.notes, 'Delta Lake depth');
  assert.equal(bilal.target_role_id, null);
  assert.equal(bilal.stage, 'role_mapped', 'a role-less row with a stage keeps it');

  const ashaUser = (await store.list('users')).find((u) => u.username === 'asha.sharma');
  const bilalUser = (await store.list('users')).find((u) => u.username === 'bilal');
  assert.ok(ashaUser && bilalUser, 'both portal users created');
  assert.equal(ashaUser.role, 'candidate');
  assert.equal(ashaUser.candidate_id, asha.id, 'user linked to its candidate');
  assert.equal(ashaUser.active, true);
  assert.equal(bilalUser.candidate_id, bilal.id);

  const ashaCred = res.body.credentials.find((c) => c.username === 'asha.sharma');
  assert.equal(ashaCred.password, 'Onboard-2026!', 'supplied password used verbatim');
  const bilalCred = res.body.credentials.find((c) => c.username === 'bilal');
  assert.match(bilalCred.password, /^Ecod-[A-Za-z0-9]+$/, 'blank password generated once');
  assert.ok(bilalCred.password.length >= 15, 'generated password is comfortably long');

  // The generated credentials are real: the new user can sign in.
  const login = await call('POST', '/auth/login', {
    body: { username: 'bilal', password: bilalCred.password },
  });
  assert.equal(login.status, 200, 'generated credentials work');

  const audit = (await store.list('audit_log')).find((e) => e.action === 'candidates_bulk_imported');
  assert.ok(audit, 'one batch audit entry');
  assert.match(audit.message, /2 candidate\(s\) imported/);
  assert.match(audit.message, /2 portal user\(s\) created/);
});

test('create_users=false imports candidates only, ignoring credentials columns', async () => {
  const beforeUsers = (await store.list('users')).length;
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: false,
      create_users: false,
      csv: csv([
        ['Name', 'Username', 'Password'],
        ['No Login Candidate', 'no.login', 'whatever'],
      ]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.users_created, 0);
  assert.deepEqual(res.body.credentials, []);
  assert.equal((await store.list('users')).length, beforeUsers);
  const c = (await store.list('candidates')).find((x) => x.name === 'No Login Candidate');
  assert.equal(c.stage, 'intake');
});

test('a re-upload of the same rows is idempotent (reported duplicate, not re-created)', async () => {
  const before = (await store.list('candidates')).length;
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true,
      create_users: true,
      csv: csv([
        ['Name', 'Email', 'Username'],
        ['Asha Sharma', 'asha@example.com', 'asha.sharma'],
        ['Bilal Khan', 'bilal@example.com', 'bilal.khan'],
      ]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 0);
  assert.equal(res.body.duplicates, 2);
  assert.equal((await store.list('candidates')).length, before);
});

test('usernames handed out in the sheet are validated and collisions are reported', async () => {
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true,
      create_users: true,
      csv: csv([
        ['Name', 'Username'],
        ['Taken Name', 'existing.user'],   // collides with the seeded assessor
        ['Bad Name', 'Not A Username!'],
        ['Short Name', 'ab'],
      ]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 0);
  assert.equal(res.body.duplicates, 1, 'taken username is a duplicate');
  assert.equal(res.body.duplicate_rows[0].errors[0], 'This username already exists.');
  const reasons = res.body.errors.map((e) => e.errors.join(' ')).join(' | ');
  assert.match(reasons, /Username must be 3\+ characters/);
});

test('an explicit username repeated in the same sheet is a duplicate', async () => {
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true,
      create_users: true,
      csv: csv([
        ['Name', 'Username'],
        ['First Person', 'same.login'],
        ['Second Person', 'same.login'],
      ]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.duplicates, 1);
  assert.equal(res.body.duplicate_rows[0].errors[0], 'This username appears earlier in the same sheet.');
});

test('generated usernames are collision-free within one upload', async () => {
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true,
      create_users: true,
      csv: csv([
        ['Name', 'Email'],
        ['Jane Doe', 'jane@example.com'],
        ['Jane Doe Again', 'jane@other.example.com'],
      ]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const names = res.body.preview.map((p) => p.username);
  assert.deepEqual(names, ['jane', 'jane2'], 'second row gets a numbered suffix');
});

test('too many rows is refused', async () => {
  const header = ['Name', 'Email'];
  const rows = Array.from({ length: 2001 }, (_, i) => [`Person ${i}`, `p${i}@example.com`]);
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: { dry_run: true, csv: csv([header, ...rows]) },
  });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /limit is 2000/);
});
