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

/* ------------------------------------------------------------------------ */
/* The assessor of an auto-allocated paper.                                  */
/*                                                                          */
/* Auto-allocation used to leave every paper "unassigned" because nothing in */
/* the UI ever sent an assessor. The candidate record now carries a default  */
/* `assessor_id` (Add/Edit form, spreadsheet column) that the automatic      */
/* paper inherits, and editing it moves the candidate's open papers too.     */
/* ------------------------------------------------------------------------ */

test('the candidate form accepts an assessor and the automatic paper inherits it', async () => {
  const created = await call('POST', '/admin/candidates', {
    token: adminToken,
    body: { name: 'Default Dana', target_role_id: zuluId, assessor_id: assessorId },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.assessor_id, assessorId);

  const listed = await call('GET', '/admin/candidates', { token: adminToken, query: { q: 'Default Dana' } });
  assert.equal(listed.body.candidates[0].assessor_name, 'Assessor One', 'the directory shows the assessor by name');

  const res = await call('POST', '/admin/users', {
    token: adminToken,
    body: { username: 'default.dana', name: 'Default Dana', role: 'candidate', candidate_id: created.body.id, password: 'dana-pass-123' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.auto_allocation.allocated, true);
  assert.equal(res.body.auto_allocation.assessor_id, assessorId, 'the paper goes to the candidate\'s assessor, not "unassigned"');
  const paper = await store.get('assessments', res.body.auto_allocation.assessment_id);
  assert.equal(paper.assessor_id, assessorId);

  const detail = await call('GET', `/admin/candidates/${created.body.id}`, { token: adminToken });
  assert.equal(detail.body.assessor_name, 'Assessor One');
  assert.equal(detail.body.assessments[0].assessor_name, 'Assessor One');
});

test('a rejected assessor on the candidate form is a 400, not a silent unassign', async () => {
  const staff = await store.insert('users', {
    username: 'not.assessor', name: 'Not An Assessor', role: 'trainer', email: '', active: true,
    password_hash: hashPassword('trainer-pass-123'),
  });
  const res = await call('POST', '/admin/candidates', {
    token: adminToken, body: { name: 'Wrong Wanda', assessor_id: staff.id },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error || JSON.stringify(res.body), /active assessor/i);
  const nope = await call('POST', '/admin/candidates', {
    token: adminToken, body: { name: 'Wrong Wanda', assessor_id: 'no-such-user' },
  });
  assert.equal(nope.status, 400);
});

test('editing the assessor on a candidate moves their open papers and leaves scored ones alone', async () => {
  const other = await store.insert('users', {
    username: 'assessor.two', name: 'Assessor Two', role: 'assessor', email: '', active: true,
    password_hash: hashPassword('assessor-pass-123'),
  });
  const cand = await mkCandidate('Edit Eddie');
  const user = await call('POST', '/admin/users', {
    token: adminToken,
    body: { username: 'edit.eddie', name: 'Edit Eddie', role: 'candidate', candidate_id: cand.id, password: 'eddie-pass-123' },
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const openId = user.body.auto_allocation.assessment_id;
  assert.equal((await store.get('assessments', openId)).assessor_id, null, 'no default assessor -> unassigned');
  // A finalized paper on another track must keep the assessor who scored it.
  const scored = await store.insert('assessments', {
    candidate_id: cand.id, role_id: alphaId, assessor_id: assessorId, status: 'scored',
    snapshot_json: { questions: [] }, report_json: null, overall_pct: 80,
  });

  const edit = await call('PATCH', `/admin/candidates/${cand.id}`, {
    token: adminToken, body: { name: 'Edit Eddie', assessor_id: other.id },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.assessor_id, other.id, JSON.stringify(edit.body));
  assert.equal(edit.body.reassigned_assessments, 1);
  assert.equal((await store.get('assessments', openId)).assessor_id, other.id, 'the open paper follows the edit');
  assert.equal((await store.get('assessments', scored.id)).assessor_id, assessorId, 'the scored paper does not');
  const trail = (await store.list('audit_log', { entity: 'assessments', entity_id: openId }))
    .filter((e) => e.action === 'assessment_reassigned');
  assert.equal(trail.length, 1, 'the move is audited against the paper');

  // Saving the form again without touching the assessor changes nothing.
  const same = await call('PATCH', `/admin/candidates/${cand.id}`, {
    token: adminToken, body: { name: 'Edit Eddie', assessor_id: other.id },
  });
  assert.equal(same.body.reassigned_assessments, 0);

  // Clearing it unassigns the open paper again.
  const clear = await call('PATCH', `/admin/candidates/${cand.id}`, {
    token: adminToken, body: { assessor_id: '' },
  });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.assessor_id, null);
  assert.equal((await store.get('assessments', openId)).assessor_id, null);

  // An inactive assessor is refused on edit too.
  await store.update('users', other.id, { active: false });
  const off = await call('PATCH', `/admin/candidates/${cand.id}`, { token: adminToken, body: { assessor_id: other.id } });
  assert.equal(off.status, 400);
  await store.update('users', other.id, { active: true });
});

test('the spreadsheet Assessor column and the dialog default both reach the automatic paper', async () => {
  const two = (await store.list('users', { username: 'assessor.two' }))[0];
  const sheet = csv([
    ['Name', 'Email', 'Target role', 'Assessor', 'Username', 'Password'],
    ['Sheet Sam', 'sam@example.com', 'Zulu Track', 'Assessor One', 'sheet.sam', 'Sam-pass-1234'],      // by display name
    ['Sheet Sue', 'sue@example.com', 'Zulu Track', 'assessor.two', 'sheet.sue', 'Sue-pass-1234'],      // by username
    ['Sheet Sid', 'sid@example.com', 'Zulu Track', '', 'sheet.sid', 'Sid-pass-1234'],                  // blank -> dialog default
    ['Sheet Sal', 'sal@example.com', 'Zulu Track', 'Nobody Here', 'sheet.sal', 'Sal-pass-1234'],       // unknown -> rejected
  ]);
  const dry = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: { dry_run: true, create_users: true, filename: 'assessors.csv', csv: sheet, assessor_id: two.id },
  });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.accepted, 3);
  assert.equal(dry.body.rejected, 1);
  assert.match(dry.body.errors[0].errors.join(' '), /Unknown assessor "Nobody Here"/);
  assert.equal(dry.body.default_assessor_name, 'Assessor Two');
  assert.deepEqual(dry.body.preview.map((p) => p.assessor), ['Assessor One', 'Assessor Two', 'Assessor Two']);

  const commit = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: { dry_run: false, create_users: true, filename: 'assessors.csv', csv: sheet, assessor_id: two.id },
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.auto_allocated, 3);
  const by = Object.fromEntries(commit.body.auto_allocations.map((a) => [a.username, a]));
  assert.equal(by['sheet.sam'].assessor_id, assessorId, 'the row column wins');
  assert.equal(by['sheet.sam'].assessor_name, 'Assessor One');
  assert.equal(by['sheet.sue'].assessor_id, two.id);
  assert.equal(by['sheet.sid'].assessor_id, two.id, 'a blank cell takes the dialog default');
  for (const u of ['sheet.sam', 'sheet.sue', 'sheet.sid']) {
    const paper = await store.get('assessments', by[u].assessment_id);
    assert.equal(paper.assessor_id, by[u].assessor_id);
    const cand = await store.get('candidates', paper.candidate_id);
    assert.equal(cand.assessor_id, by[u].assessor_id, 'the candidate record remembers the assessor too');
  }
  const trail = (await store.list('audit_log', { entity: 'assessments', entity_id: by['sheet.sam'].assessment_id }));
  assert.ok(!/assessor to be assigned/.test(trail[0].message), 'an assigned paper is not audited as pending');
});

test('an unknown dialog default is ignored, not fatal; an active assessor is still required per row', async () => {
  const res = await call('POST', '/admin/candidates/import', {
    token: adminToken,
    body: {
      dry_run: true, create_users: true, filename: 'x.csv', assessor_id: 'no-such-user',
      csv: csv([['Name', 'Email', 'Target role'], ['Lone Lou', 'lou@example.com', 'Zulu Track']]),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.default_assessor_id, null);
  assert.equal(res.body.preview[0].assessor, '');
});
