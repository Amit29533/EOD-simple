import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { QUESTION_BANK_VERSION } from '../src/content/rsa-question-bank.mjs';
import { maxRunLength, maxRunOf } from '../src/core/paper-order.mjs';

/** The module-structured Question Bank endpoints, over the real app. */

let app, store, adminToken, candidateToken;
const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-qb-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);

  const mk = (u) => store.insert('users', { ...u, password_hash: hashPassword(u.password), active: true });
  await mk({ username: 'admin', password: 'pw-admin', name: 'Admin', role: 'admin', email: '' });
  const candidate = await store.insert('candidates', { name: 'Cand', stage: 'intake' });
  await mk({
    username: 'cand', password: 'pw-cand', name: 'Cand', role: 'candidate',
    email: '', candidate_id: candidate.id,
  });

  adminToken = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'pw-admin' } })).body.token;
  candidateToken = (await call('POST', '/auth/login', { body: { username: 'cand', password: 'pw-cand' } })).body.token;
});

test('bootstrap publishes the families, modules and paper structure', async () => {
  const res = await call('GET', '/meta/bootstrap');
  assert.equal(res.status, 200);
  assert.equal(res.body.modules.length, 20);
  assert.equal(res.body.moduleGroups.length, 4);
  assert.equal(res.body.families.length, 62);
  assert.equal(res.body.moduleTestStructure.total, 50);
  assert.equal(res.body.moduleTestStructure.technical_objective, 3);
  assert.equal(res.body.moduleTestStructure.non_technical_open, 1);
});

test('module listing reports every module with its counts', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  assert.equal(res.status, 200);
  // Compared against the published bank's own version so re-extracting a new
  // source PDF never has to touch this file.
  assert.equal(res.body.version, QUESTION_BANK_VERSION);
  assert.equal(res.body.modules.length, 20);
  assert.equal(res.body.bank_total, 348);
  assert.equal(res.body.blueprint.total, 50);

  assert.deepEqual(res.body.modules.map((m) => m.key), [
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
    'C01', 'C02', 'C03', 'C04',
    'P01', 'P02', 'P03', 'P04',
    'F01', 'F02',
  ]);
  for (const m of res.body.modules) {
    assert.ok(m.objective >= 10, `${m.key} has ${m.objective} objective`);
  }
});

test('modules are grouped, and each carries its own families', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const groups = new Set(res.body.groups.map((g) => g.key));
  for (const m of res.body.modules) {
    assert.ok(groups.has(m.group), `${m.key} -> ${m.group}`);
    assert.ok(Array.isArray(m.families) && m.families.length >= 1, `${m.key} families`);
    for (const f of m.families) assert.ok(f.id.startsWith(`${m.key}:`), f.id);
  }
  assert.equal(res.body.modules.filter((m) => m.technical).length, 10);
  assert.equal(res.body.family_total, 62);
});

test('a family endpoint returns just that family\'s questions', async () => {
  const res = await call('GET', '/admin/question-bank/families/T05:cost-finops', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.family.module, 'T05');
  assert.equal(res.body.family.name, 'Cost & FinOps');
  assert.ok(res.body.questions.length >= 1);

  const missing = await call('GET', '/admin/question-bank/families/T05:nope', { token: adminToken });
  assert.equal(missing.status, 404);
});

test('the optional pool is reported separately from the primary bank', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  assert.equal(res.body.optional.total, 115);
  // Primary counts must not include optional questions.
  const total = res.body.modules.reduce((n, m) => n + m.objective + m.open, 0);
  assert.equal(total, 348);
});

test('the plan confirms every module can meet its quota', async () => {
  const res = await call('GET', '/admin/question-bank/plan', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  assert.equal(res.body.optional_total, 115);
  for (const row of res.body.modules) assert.ok(row.sufficient, row.module);
});

test('a previewed paper matches the required structure', async () => {
  const res = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.warnings, []);
  assert.equal(res.body.counts.total, 50);
  assert.equal(res.body.counts.technical_objective, 30);
  assert.equal(res.body.counts.technical_open, 10);
  assert.equal(res.body.counts.non_technical_open, 10);
  assert.equal(res.body.questions.length, 50);
  assert.equal(res.body.counts.from_optional, 0);
});

test('two previews differ in content but never in structure', async () => {
  const a = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  const b = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  assert.deepEqual(a.body.counts, b.body.counts);
  const idsA = a.body.questions.map((q) => q.id).join(',');
  const idsB = b.body.questions.map((q) => q.id).join(',');
  assert.notEqual(idsA, idsB);
});

test('sections follow the module order T01-T10, C01-C04, P01-P04, F01-F02 while the paper is shuffled', async () => {
  const res = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  assert.deepEqual(res.body.sections.map((s) => s.module), [
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
    'C01', 'C02', 'C03', 'C04',
    'P01', 'P02', 'P03', 'P04',
    'F01', 'F02',
  ]);
  // The paper itself is NOT emitted in module order any more: it is shuffled so
  // objective and open questions interleave instead of arriving in blocks.
  const types = res.body.questions.map((q) => q.type);
  assert.equal(types.filter((t) => t === 'open').length, 20);
  assert.ok(types.indexOf('open') < types.lastIndexOf('objective'),
    'every open question still sat behind every objective one');
  const runs = types.filter((t, i) => t === 'open' && (i === 0 || types[i - 1] !== 'open')).length;
  assert.ok(runs > 1, `open questions arrived as one block (${types.join(',')})`);
  // The guarantee the shuffle exists for: never two open questions in a row,
  // and at most two objective ones together (30 objective over 21 gaps).
  assert.equal(maxRunOf(types, 'open'), 1, `two open questions in a row (${types.join('')})`);
  assert.equal(maxRunLength(types), 2, `a block of MCQs survived (${types.join('')})`);
  // Shuffling reorders the paper; it never changes what was drawn.
  assert.deepEqual(
    res.body.questions.map((q) => q.id).sort(),
    res.body.sections.flatMap((s) => s.question_ids).sort(),
  );
});

test('question-bank endpoints are admin-only', async () => {
  for (const [method, p] of [
    ['GET', '/admin/question-bank/modules'],
    ['GET', '/admin/question-bank/plan'],
    ['POST', '/admin/question-bank/preview'],
    ['GET', '/admin/question-bank/families/T05:cost-finops'],
  ]) {
    assert.equal((await call(method, p)).status, 401, `${p} anonymous`);
    assert.equal((await call(method, p, { token: candidateToken })).status, 403, `${p} candidate`);
  }
});

// ---------------------------------------------------------------------------
// Regression tests: the API's own numbers must agree with each other.
//
// The module tree and the family drill-down are separate code paths over the
// same bank, and they used to disagree — M00 advertised a family holding one
// open question while the drill-down for that family returned nothing.
// ---------------------------------------------------------------------------

test('every family row agrees with its own drill-down', async () => {
  const list = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  for (const m of list.body.modules) {
    for (const f of m.families) {
      const res = await call('GET', `/admin/question-bank/families/${f.id}`, { token: adminToken });
      assert.equal(res.status, 200, f.id);
      const rows = res.body.questions;
      assert.equal(rows.length, f.objective + f.open, `${f.id} count`);
      assert.equal(rows.filter((q) => q.type === 'objective').length, f.objective, `${f.id} objective`);
      assert.equal(rows.filter((q) => q.type === 'open').length, f.open, `${f.id} open`);
    }
  }
});

test('a module total equals the sum of its families', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  for (const m of res.body.modules) {
    const objective = m.families.reduce((n, f) => n + f.objective, 0);
    const open = m.families.reduce((n, f) => n + f.open, 0);
    assert.equal(objective, m.objective, `${m.key} objective`);
    assert.equal(open, m.open, `${m.key} open`);
  }
});

test('no module or question is marked mandatory any more', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  assert.equal(res.body.modules.filter((m) => m.mandatory).length, 0);
  assert.equal(res.body.blueprint.mandatory, undefined);
  const preview = await call('POST', '/admin/question-bank/preview', { token: adminToken, body: {} });
  assert.equal(preview.body.questions.filter((q) => q.mandatory).length, 0);
});

test('?include_optional accepts the flag spellings a URL actually carries', async () => {
  const base = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const withOptional = base.body.modules.reduce((n, m) => n + (m.optional || 0), 0);
  assert.equal(withOptional, 0, 'optional questions leaked into the default view');

  for (const flag of ['1', 'true', 'yes', 'on']) {
    const res = await call('GET', '/admin/question-bank/modules', {
      token: adminToken, query: { include_optional: flag },
    });
    const total = res.body.modules.reduce((n, m) => n + (m.optional || 0), 0);
    assert.equal(total, 115, `include_optional=${flag}`);
  }
  for (const flag of ['0', 'false', '']) {
    const res = await call('GET', '/admin/question-bank/modules', {
      token: adminToken, query: { include_optional: flag },
    });
    const total = res.body.modules.reduce((n, m) => n + (m.optional || 0), 0);
    assert.equal(total, 0, `include_optional=${flag}`);
  }
});

test('the paper-wide blueprint matches the published per-module quotas', async () => {
  const res = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const { blueprint, technical_modules, non_technical_modules } = res.body;
  assert.equal(technical_modules, 10);
  assert.equal(non_technical_modules, 10);
  assert.equal(blueprint.total, 50);
  assert.equal(blueprint.technical_objective % technical_modules, 0);
  assert.equal(blueprint.technical_objective / technical_modules, 3);
  assert.equal(blueprint.technical_open / technical_modules, 1);
  assert.equal(blueprint.non_technical_open / non_technical_modules, 1);
});

/* ------------------- editing an authored question -------------------- */
// Regression cover for a PATCH merge that used to spread the stored record
// over the body: fields *derived* from what the patch was changing survived
// and then beat the new input, making legitimate edits impossible.

const addQuestion = (body) => call('POST', '/admin/question-bank/questions', { token: adminToken, body });

test('an authored question can be moved to another module', async () => {
  const created = await addQuestion({
    module: 'T01', family: 'Advanced Technical Judgment', type: 'open',
    prompt: 'A question that will be moved to a different module entirely?',
    rubric: 'Some expected evidence.',
  });
  assert.equal(created.status, 201);
  const id = created.body.question.id;
  assert.equal(created.body.question.family_id, 'T01:advanced-technical-judgment');

  // The stale family_id must not veto the new module.
  const moved = await call('PATCH', `/admin/question-bank/questions/${id}`, {
    token: adminToken, body: { module: 'C02', family: 'Advanced Consulting Judgment' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.question.module, 'C02');
  assert.equal(moved.body.question.family_id, 'C02:advanced-consulting-judgment');

  await call('DELETE', `/admin/question-bank/questions/${id}`, { token: adminToken });
});

test('an authored question can be switched between objective and open', async () => {
  const created = await addQuestion({
    module: 'T02', family: 'Advanced Technical Judgment', type: 'objective',
    prompt: 'Which ingestion mode suits a bursty append-only source of events?',
    options: [{ id: 'a', label: 'Batch nightly' }, { id: 'b', label: 'Auto Loader' }],
    correct_option_ids: ['b'],
  });
  assert.equal(created.status, 201);
  const id = created.body.question.id;

  // objective -> open: the leftover options must not block it.
  const toOpen = await call('PATCH', `/admin/question-bank/questions/${id}`, {
    token: adminToken, body: { type: 'open', rubric: 'Explains the latency/cost tradeoff.' },
  });
  assert.equal(toOpen.status, 200, JSON.stringify(toOpen.body));
  assert.equal(toOpen.body.question.type, 'open');
  assert.ok(!('options' in toOpen.body.question), 'the retired options are dropped');
  assert.match(toOpen.body.question.rubric, /tradeoff/);

  // ...and back again: the leftover rubric must not block it either.
  const toObjective = await call('PATCH', `/admin/question-bank/questions/${id}`, {
    token: adminToken,
    body: {
      type: 'objective',
      options: [{ id: 'a', label: 'Batch nightly' }, { id: 'b', label: 'Auto Loader' }],
      correct_option_ids: ['b'],
    },
  });
  assert.equal(toObjective.status, 200, JSON.stringify(toObjective.body));
  assert.equal(toObjective.body.question.type, 'objective');
  assert.equal(toObjective.body.question.options.length, 2);
  assert.ok(!('rubric' in toObjective.body.question), 'the retired rubric is dropped');

  await call('DELETE', `/admin/question-bank/questions/${id}`, { token: adminToken });
});

test('editing only the prompt leaves the module and family alone', async () => {
  const created = await addQuestion({
    module: 'P02', family: 'Advanced Communication Judgment', type: 'open',
    prompt: 'An original prompt that is about to be reworded by an admin?',
    rubric: 'Evidence.',
  });
  const id = created.body.question.id;
  const patched = await call('PATCH', `/admin/question-bank/questions/${id}`, {
    token: adminToken, body: { prompt: 'A reworded prompt that still belongs where it was?' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.question.module, 'P02');
  assert.equal(patched.body.question.family_id, 'P02:advanced-communication-judgment');
  await call('DELETE', `/admin/question-bank/questions/${id}`, { token: adminToken });
});

/* -------------- deactivated questions are not advertised -------------- */
// The bank tree used to count every stored question while generation skipped
// inactive ones, so the UI promised a quota the plan knew could not be filled.

test('a deactivated question is excluded from the counts it can no longer fill', async () => {
  const before = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const beforeT03 = before.body.modules.find((m) => m.key === 'T03');
  const beforeTotal = before.body.bank_total;

  const created = await addQuestion({
    module: 'T03', family: 'Advanced Technical Judgment', type: 'open',
    prompt: 'A question that is about to be switched off by an administrator?',
    rubric: 'Evidence.',
  });
  const id = created.body.question.id;

  const active = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  assert.equal(active.body.modules.find((m) => m.key === 'T03').open, beforeT03.open + 1);
  assert.equal(active.body.bank_total, beforeTotal + 1);

  await call('PATCH', `/admin/question-bank/questions/${id}`, { token: adminToken, body: { active: false } });

  const after = await call('GET', '/admin/question-bank/modules', { token: adminToken });
  const afterT03 = after.body.modules.find((m) => m.key === 'T03');
  assert.equal(afterT03.open, beforeT03.open, 'an inactive question stops counting toward the quota');
  assert.equal(afterT03.inactive, 1, 'it is reported as inactive instead');
  assert.equal(after.body.bank_total, beforeTotal, 'the headline total excludes it');
  assert.equal(after.body.inactive_total, 1);

  await call('DELETE', `/admin/question-bank/questions/${id}`, { token: adminToken });
});

test('the module tree never advertises more than the plan can serve', async () => {
  const created = await addQuestion({
    module: 'T04', family: 'Advanced Technical Judgment', type: 'objective',
    prompt: 'An objective question destined to be deactivated for this check?',
    options: [{ id: 'a', label: 'First choice' }, { id: 'b', label: 'Second choice' }],
    correct_option_ids: ['a'],
  });
  const id = created.body.question.id;
  await call('PATCH', `/admin/question-bank/questions/${id}`, { token: adminToken, body: { active: false } });

  const [tree, plan] = await Promise.all([
    call('GET', '/admin/question-bank/modules', { token: adminToken }),
    call('GET', '/admin/question-bank/plan', { token: adminToken }),
  ]);
  const planFor = new Map(plan.body.modules.map((m) => [m.module, m]));
  for (const mod of tree.body.modules) {
    const row = planFor.get(mod.key);
    assert.equal(mod.objective, row.available_objective, `${mod.key} objective count agrees with the plan`);
    assert.equal(mod.open, row.available_open, `${mod.key} open count agrees with the plan`);
  }

  await call('DELETE', `/admin/question-bank/questions/${id}`, { token: adminToken });
});
