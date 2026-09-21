import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { MODULES as RSA_MODULES, QUESTIONS as RSA_QUESTIONS } from '../src/content/rsa-question-bank.mjs';
import {
  MODULES as AIBI_MODULES, QUESTIONS as AIBI_QUESTIONS, QUESTION_BANK_VERSION as AIBI_VERSION,
} from '../src/content/ai-bi-genie-question-bank.mjs';
import { MODULE_BANKS, DEFAULT_MODULE_BANK_ROLE_KEY } from '../src/content/module-banks.mjs';
import { generateTest, testPlan } from '../src/core/test-generation.mjs';
import { effectiveBank, nextAuthoredId, toStoredRecord } from '../src/api/bank-service.mjs';

/**
 * The role-aware module Question Bank: the RSA bank stays the historical
 * default for every unscoped call, and the AI/BI & Genie bank is a first-class
 * citizen with its own tree, plan, generated paper, authoring and overrides.
 */

const AIBI_KEY = 'databricks-ai-bi-genie';

let store, app, adminToken;
const call = (method, p, { body, query } = {}) =>
  app({ method, path: p, body, query, headers: { authorization: `Bearer ${adminToken}` } });

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-ai-bi-bank-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin',
    password_hash: hashPassword('pw-admin'), active: true,
  });
  adminToken = (await app({
    method: 'POST', path: '/auth/login', body: { username: 'admin', password: 'pw-admin' },
  })).body.token;
}

test('the registry holds one published bank per published track', () => {
  assert.equal(DEFAULT_MODULE_BANK_ROLE_KEY, 'databricks-rsa');
  assert.deepEqual(Object.keys(MODULE_BANKS).sort(), ['databricks-ai-bi-genie', 'databricks-rsa']);
  const rsa = MODULE_BANKS['databricks-rsa'];
  assert.equal(rsa.modules.length, 20);
  assert.equal(rsa.questions.length, RSA_QUESTIONS.length);
  assert.ok(rsa.optional, 'the RSA bank keeps its retired-catalogue fallback pool');
  const aibi = MODULE_BANKS[AIBI_KEY];
  assert.equal(aibi.modules.length, 10);
  assert.equal(aibi.questions.length, AIBI_QUESTIONS.length);
  assert.equal(aibi.questions.length, 100);
  assert.equal(aibi.version, AIBI_VERSION);
  assert.equal(aibi.optional, null, 'the AI/BI bank has no retired catalogue');
  assert.equal(aibi.modules.filter((m) => m.technical === true).length, 7);
  assert.equal(aibi.modules.filter((m) => m.technical !== true).length, 3);
});

test('effective banks are scoped by role key; unscoped reads keep the RSA default', async () => {
  await setup();
  const rsa = await effectiveBank(store);
  assert.equal(rsa.length, 348, 'the default effective bank is still the RSA bank');

  const aibi = await effectiveBank(store, AIBI_KEY);
  assert.equal(aibi.length, 100);
  assert.ok(aibi.every((q) => AIBI_MODULES.some((m) => m.key === q.module)));

  // An authored question for the AI/BI bank lands in that bank only.
  const rec = toStoredRecord({
    module: 'G01', family_id: 'G01:genie-space-design-optimization', family: 'Genie Space Design & Optimization',
    type: 'open', prompt: 'An authored AI/BI question that must not leak into the RSA bank.',
    difficulty: 4, band: 'Intermediate', mode: 'Online assessment', minutes: 5, rubric: 'Evidence.',
  }, { id: 'AIBI-G01-A001', actorId: 'u1', roleKey: AIBI_KEY });
  await store.insert('bank_questions', rec);

  const aibiAfter = await effectiveBank(store, AIBI_KEY);
  assert.equal(aibiAfter.length, 101);
  assert.ok(aibiAfter.some((q) => q.id === 'AIBI-G01-A001' && q.authored));
  const rsaAfter = await effectiveBank(store);
  assert.equal(rsaAfter.length, 348, 'the RSA bank is untouched by an AI/BI-authored question');

  // Legacy authored rows (no role_key) belong to the default RSA bank.
  await store.insert('bank_questions', {
    id: 'RSA-T01-A999', module: 'T01', family_id: 'T01:advanced-technical-judgment',
    family: 'Advanced Technical Judgment', type: 'objective',
    prompt: 'A legacy authored RSA question.', options: [
      { id: 'a', label: 'One' }, { id: 'b', label: 'Two' },
    ], correct_option_ids: ['a'], active: true,
  });
  const rsaLegacy = await effectiveBank(store);
  assert.ok(rsaLegacy.some((q) => q.id === 'RSA-T01-A999'), 'legacy rows resolve to the RSA bank');
  const aibiLegacy = await effectiveBank(store, AIBI_KEY);
  assert.ok(!aibiLegacy.some((q) => q.id === 'RSA-T01-A999'), 'legacy rows never leak into another bank');
});

test('generated AI/BI papers hold the 7 technical + 3 consulting structure exactly', () => {
  const rng = (n) => () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let seed = 1; seed <= 8; seed += 1) {
    const result = generateTest({ modules: AIBI_MODULES, questions: AIBI_QUESTIONS }, { rng: rng(seed) });
    assert.equal(result.counts.total, 31, `seed ${seed}: paper length`);
    assert.equal(result.counts.technical_objective, 21);
    assert.equal(result.counts.technical_open, 7);
    assert.equal(result.counts.non_technical_open, 3);
    assert.deepEqual(result.warnings, [], `seed ${seed}: every module meets its quota`);

    // Per-module quotas, held exactly: technical 3 objective + 1 open, consulting 1 open.
    const perModule = new Map(result.sections.map((s) => [s.module, s]));
    for (const m of AIBI_MODULES) {
      const s = perModule.get(m.key);
      assert.ok(s, `seed ${seed}: section for ${m.key}`);
      if (m.technical) {
        assert.equal(s.objective, 3, `seed ${seed}: ${m.key} objective quota`);
        assert.equal(s.open, 1, `seed ${seed}: ${m.key} open quota`);
      } else {
        assert.equal(s.objective, 0, `seed ${seed}: ${m.key} has no objective seat`);
        assert.equal(s.open, 1, `seed ${seed}: ${m.key} open quota`);
      }
    }

    // Interleaved: no two open questions back to back.
    const types = result.questions.map((q) => q.type);
    for (let i = 0; i < types.length - 1; i += 1) {
      assert.ok(!(types[i] === 'open' && types[i + 1] === 'open'), `seed ${seed}: no adjacent opens at ${i}`);
    }
  }
});

test('testPlan reports the AI/BI blueprint from the module list, not the RSA one', () => {
  const plan = testPlan({ modules: AIBI_MODULES, questions: AIBI_QUESTIONS });
  assert.deepEqual(plan.blueprint, {
    technical_objective: 21, technical_open: 7, non_technical_open: 3, total: 31,
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.bank_total, 100);
  assert.equal(plan.optional_total, 0);
  assert.ok(plan.modules.every((m) => m.sufficient));
});

test('the modules/plan/preview endpoints are scoped by role_key', async () => {
  await setup();

  const modules = await call('GET', '/admin/question-bank/modules', { query: { role_key: AIBI_KEY } });
  assert.equal(modules.status, 200);
  assert.equal(modules.body.role_key, AIBI_KEY);
  assert.equal(modules.body.role_name, 'Senior Databricks AI/BI & Genie Consultant');
  assert.equal(modules.body.version, AIBI_VERSION);
  assert.equal(modules.body.bank_total, 100);
  assert.deepEqual(modules.body.blueprint, {
    technical_objective: 21, technical_open: 7, non_technical_open: 3, total: 31,
  });
  assert.equal(modules.body.technical_modules, 7);
  assert.equal(modules.body.non_technical_modules, 3);
  assert.deepEqual(modules.body.modules.map((m) => m.key), [
    'G01', 'G02', 'A01', 'S01', 'S02', 'Q01', 'R01', 'F01', 'C01', 'D01',
  ]);
  assert.equal(modules.body.optional.total, 0);

  const plan = await call('GET', '/admin/question-bank/plan', { query: { role_key: AIBI_KEY } });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.blueprint.total, 31);
  assert.equal(plan.body.ready, true);

  const preview = await call('POST', '/admin/question-bank/preview', { body: { role_key: AIBI_KEY } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.counts.total, 31);
  assert.equal(preview.body.questions.length, 31);

  // Unscoped calls still serve the RSA bank.
  const rsaModules = await call('GET', '/admin/question-bank/modules');
  assert.equal(rsaModules.status, 200);
  assert.equal(rsaModules.body.role_key, 'databricks-rsa');
  assert.equal(rsaModules.body.blueprint.total, 50);
  assert.equal(rsaModules.body.bank_total, 348);

  // A role key without a published bank is a 400, not an empty bank.
  const unknown = await call('GET', '/admin/question-bank/modules', { query: { role_key: 'senior-consultant' } });
  assert.equal(unknown.status, 400);
});

test('authoring in the AI/BI bank mints AIBI ids and stores the role key', async () => {
  await setup();

  const added = await call('POST', '/admin/question-bank/questions', {
    body: {
      role_key: AIBI_KEY,
      module: 'S02', family: 'OBO Authentication & Role Security', type: 'objective',
      prompt: 'Which design keeps Genie responses scoped to the requesting user?',
      options: [
        { id: 'a', label: 'A shared service principal' },
        { id: 'b', label: 'On-behalf-of identity with Unity Catalog least privilege' },
        { id: 'c', label: 'A token pasted into the instructions' },
        { id: 'd', label: 'Row-level filters disabled' },
      ],
      correct_option_ids: ['b'], rationale: 'OBO keeps authorization per user.',
      difficulty: 4, band: 'Intermediate', minutes: 2, tags: '',
    },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.question.id, 'AIBI-S02-A001');
  assert.equal(added.body.question.role_key, AIBI_KEY);

  // The RSA bank did not grow, and its authored-id sequence is independent.
  const rsaBank = await effectiveBank(store);
  assert.equal(rsaBank.length, 348);
  assert.equal(nextAuthoredId('S02', await store.list('bank_questions'), 'databricks-rsa'), 'RSA-S02-A001');
  assert.equal(nextAuthoredId('S02', await store.list('bank_questions'), AIBI_KEY), 'AIBI-S02-A002');

  // A duplicate prompt is refused within the same bank…
  const dup = await call('POST', '/admin/question-bank/questions', {
    body: {
      role_key: AIBI_KEY,
      module: 'S02', family: 'OBO Authentication & Role Security', type: 'objective',
      prompt: 'Which design keeps Genie responses scoped to the requesting user?',
      options: [
        { id: 'a', label: 'One' }, { id: 'b', label: 'Two' },
      ],
      correct_option_ids: ['a'], difficulty: 4, band: 'Intermediate', minutes: 2, tags: '',
    },
  });
  assert.equal(dup.status, 409);
});

test('published-question overrides are scoped per bank', async () => {
  await setup();

  // Hide one published AI/BI question…
  const victim = AIBI_QUESTIONS[0];
  const removed = await call('DELETE', `/admin/question-bank/questions/${victim.id}`, { query: { role_key: AIBI_KEY } });
  assert.equal(removed.status, 200);
  const aibi = await effectiveBank(store, AIBI_KEY);
  const row = aibi.find((q) => q.id === victim.id);
  assert.equal(row.active, false);
  assert.equal(row.removed, true);
  // …and the same id is untouched in the RSA bank.
  const rsa = await effectiveBank(store);
  assert.ok(!rsa.some((q) => q.id === victim.id && q.removed), 'an AI/BI hide never touches the RSA bank');

  // Restore through the scoped PATCH.
  const restored = await call('PATCH', `/admin/question-bank/questions/${victim.id}`, {
    body: { active: true }, query: { role_key: AIBI_KEY },
  });
  assert.equal(restored.status, 200);
  const aibiAfter = await effectiveBank(store, AIBI_KEY);
  const restoredRow = aibiAfter.find((q) => q.id === victim.id);
  // Published rows carry `status`, not `active`: a restore means "not
  // removed and not deactivated" (isActive's rule).
  assert.equal(restoredRow.removed, undefined);
  assert.notEqual(restoredRow.active, false);
  assert.equal(restoredRow.status, 'Active');
});
