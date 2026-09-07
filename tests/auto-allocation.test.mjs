import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';

/**
 * Automatic allotment: every user created with the candidate role is
 * allocated the default 50-question assessment for their track — single
 * provisioning and bulk Excel onboarding alike — instead of needing a
 * manual Allocate click per candidate.
 */

let app, store, adminToken, assessorId;
let alphaId, zuluId;

const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });
const csv = (rows) => rows.map((r) => r.join(',')).join('\n');

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-auto-alloc-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);

  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', email: '', active: true,
    password_hash: hashPassword('admin-pass-123'),
  });
  const assessor = await store.insert('users', {
    username: 'assessor.one', name: 'Assessor One', role: 'assessor', email: '', active: true,
    password_hash: hashPassword('assessor-pass-123'),
  });
  assessorId = assessor.id;
  adminToken = (await call('POST', '/auth/login', {
    body: { username: 'admin', password: 'admin-pass-123' },
  })).body.token;

  // Two tracks: Alpha (the workspace default by name) holds a tiny 2-question
  // bank, Zulu holds 60 so the 50-question default actually caps.
  const mkTrack = async (name, n) => {
    const role = await store.insert('roles', {
      key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, technology: 'General', active: true,
    });
    const comp = await store.insert('competencies', {
      role_id: role.id, key: 'core', name: 'Core', category: 'technical',
      weight: 100, target_level: 4, order: 1, active: true,
    });
    for (let i = 1; i <= n; i += 1) {
      await store.insert('questions', {
        role_id: role.id, competency_id: comp.id, type: 'mcq_single',
        prompt: `${name} question ${i}?`,
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        correct_option_ids: ['b'], points: 4, difficulty: 'foundation',
        rubric: '', order: i, active: true,
      });
    }
    return role.id;
  };
  alphaId = await mkTrack('Alpha Track', 2);
  zuluId = await mkTrack('Zulu Track', 60);
});

const mkCandidate = (name, target_role_id = zuluId) =>
  store.insert('candidates', { name, stage: 'intake', target_role_id });

test('a candidate user is auto-allocated 50 questions on creation', async () => {
  const cand = await mkCandidate('Auto Fifty');
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'auto.fifty', name: 'Auto Fifty', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const alloc = res.body.auto_allocation;
  assert.ok(alloc, 'the response reports the automatic allocation');
  assert.equal(alloc.allocated, true);
  assert.equal(alloc.question_count, 50);
  assert.equal(alloc.role_id, zuluId);
  assert.equal(alloc.assessor_id, null, 'the assessor is left unassigned for later distribution');

  const assessment = await store.get('assessments', alloc.assessment_id);
  assert.equal(assessment.status, 'assigned');
  assert.equal(assessment.snapshot_json.questions.length, 50);
  assert.equal(assessment.snapshot_json.question_limit, 50);
  assert.equal(assessment.snapshot_json.bank_total, 60);
  assert.equal((await store.get('candidates', cand.id)).stage, 'assessment');
  const audit = (await store.list('audit_log'))
    .find((e) => e.action === 'assessment_allocated' && e.entity_id === alloc.assessment_id);
  assert.ok(audit, 'the automatic allocation is audited like a manual one');
  assert.match(audit.message, /auto-allocated/);
});

test('a bank smaller than 50 serves its full bank instead of failing', async () => {
  const cand = await mkCandidate('Auto Small', alphaId);
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'auto.small', name: 'Auto Small', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation.allocated, true);
  assert.equal(res.body.auto_allocation.question_count, 2);
  const assessment = await store.get('assessments', res.body.auto_allocation.assessment_id);
  assert.equal(assessment.snapshot_json.questions.length, 2);
  assert.equal(assessment.snapshot_json.question_limit, null, 'a short bank serves whole, uncapped');
  assert.equal(assessment.snapshot_json.bank_total, 2);
});

test('auto_allocate:false provisions the login without an assessment', async () => {
  const cand = await mkCandidate('Manual Molly');
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'manual.molly', name: 'Manual Molly', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id, auto_allocate: false,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation.allocated, false);
  assert.equal(res.body.auto_allocation.skipped, true);
  assert.equal((await store.list('assessments', { candidate_id: cand.id })).length, 0);
  assert.equal((await store.get('candidates', cand.id)).stage, 'intake', 'no allocation, no stage move');
});

test('an existing open assessment is left alone — provisioning still succeeds', async () => {
  const cand = await mkCandidate('Already Allocated');
  const manual = await call('POST', '/admin/assessments', {
    token: adminToken, body: { candidate_id: cand.id, role_id: zuluId, question_count: 6 },
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));

  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'already.allocated', name: 'Already Allocated', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation.allocated, false);
  assert.match(res.body.auto_allocation.reason, /already has an open/i);
  assert.equal(res.body.auto_allocation.assessment_id, manual.body.id);
  assert.equal((await store.list('assessments', { candidate_id: cand.id })).length, 1, 'no duplicate paper');
});

test('a candidate without a target track falls back to the workspace default', async () => {
  const cand = await store.insert('candidates', { name: 'No Target Ned', stage: 'intake', target_role_id: null });
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'no.target', name: 'No Target Ned', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation.allocated, true);
  assert.equal(res.body.auto_allocation.role_id, alphaId, 'first active track by name');
  assert.equal((await store.get('candidates', cand.id)).target_role_id, alphaId, 'the default track is recorded');
});

test('role_id / assessor_id / question_count steer the automatic paper', async () => {
  const cand = await mkCandidate('Steered Sam', alphaId);
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'steered.sam', name: 'Steered Sam', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id,
      role_id: zuluId, assessor_id: assessorId, question_count: 6,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const alloc = res.body.auto_allocation;
  assert.equal(alloc.allocated, true);
  assert.equal(alloc.role_id, zuluId, 'explicit track beats the candidate target');
  assert.equal(alloc.question_count, 6);
  assert.equal(alloc.assessor_id, assessorId);
});

test('a dead target track skips allocation with a reason instead of failing', async () => {
  const cand = await store.insert('candidates', { name: 'Ghost Gail', stage: 'intake', target_role_id: 'no-such-role' });
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: {
      username: 'ghost.gail', name: 'Ghost Gail', role: 'candidate',
      password: 'candidate-pass-123', candidate_id: cand.id,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation.allocated, false);
  assert.match(res.body.auto_allocation.reason, /no longer available/i);
  assert.equal((await store.list('assessments', { candidate_id: cand.id })).length, 0);
});

test('staff roles provision with no allocation attempt', async () => {
  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: { username: 'staff.sue', name: 'Staff Sue', role: 'assessor', password: 'assessor-pass-123' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation, undefined);
});

test('bulk onboarding auto-allocates every new portal user', async () => {
  const dry = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true, create_users: true, filename: 'bulk.csv',
      csv: csv([
        ['Name', 'Email', 'Target role', 'Username', 'Password'],
        ['Bulk Beth', 'beth@example.com', 'Zulu Track', 'bulk.beth', 'Beth-pass-123'],
        ['Bulk Bob', 'bob@example.com', '', 'bulk.bob', 'Bob-pass-123'],
      ]),
    },
  });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.auto_allocate, true, 'the dry run echoes the default');
  assert.equal(dry.body.would_auto_allocate, 2, 'explicit target + workspace default');

  const commit = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: false, create_users: true, filename: 'bulk.csv',
      csv: csv([
        ['Name', 'Email', 'Target role', 'Username', 'Password'],
        ['Bulk Beth', 'beth@example.com', 'Zulu Track', 'bulk.beth', 'Beth-pass-123'],
        ['Bulk Bob', 'bob@example.com', '', 'bulk.bob', 'Bob-pass-123'],
      ]),
    },
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.imported, 2);
  assert.equal(commit.body.users_created, 2);
  assert.equal(commit.body.auto_allocated, 2);
  assert.equal(commit.body.auto_allocations.length, 2);

  const beth = commit.body.auto_allocations.find((a) => a.username === 'bulk.beth');
  const bob = commit.body.auto_allocations.find((a) => a.username === 'bulk.bob');
  assert.equal(beth.allocated, true);
  assert.equal(beth.question_count, 50);
  assert.equal(beth.role_name, 'Zulu Track');
  assert.ok(beth.assessment_id);
  assert.equal(bob.allocated, true);
  assert.equal(bob.question_count, 2, 'the default track serves its short bank whole');
  assert.equal(bob.role_name, 'Alpha Track');

  const bethCand = (await store.list('candidates')).find((c) => c.email === 'beth@example.com');
  const bobCand = (await store.list('candidates')).find((c) => c.email === 'bob@example.com');
  assert.equal(bethCand.stage, 'assessment');
  assert.equal(bobCand.stage, 'assessment');
  assert.equal(bobCand.target_role_id, alphaId, 'the default track is filled in on import');
  const bethPaper = await store.get('assessments', beth.assessment_id);
  assert.equal(bethPaper.snapshot_json.questions.length, 50);
  const trail = (await store.list('audit_log')).filter((e) => e.action === 'assessment_allocated');
  assert.ok(trail.length >= 2, 'bulk allocations are audited per assessment');
  const batch = (await store.list('audit_log')).find((e) => e.action === 'candidates_bulk_imported');
  assert.match(batch.message, /2 assessment\(s\) auto-allocated/);
});

test('bulk onboarding with auto_allocate:false creates logins only', async () => {
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: false, create_users: true, auto_allocate: false, filename: 'bulk2.csv',
      csv: csv([
        ['Name', 'Email', 'Target role', 'Username', 'Password'],
        ['Bulk Una', 'una@example.com', 'Zulu Track', 'bulk.una', 'Una-pass-123'],
      ]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.users_created, 1);
  assert.equal(res.body.auto_allocated, 0);
  const cand = (await store.list('candidates')).find((c) => c.email === 'una@example.com');
  assert.equal((await store.list('assessments', { candidate_id: cand.id })).length, 0);
});
