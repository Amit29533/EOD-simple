import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import {
  MODULES as SAMA_MODULES, QUESTIONS as SAMA_QUESTIONS, FAMILIES as SAMA_FAMILIES,
  QUESTION_BANK_VERSION as SAMA_VERSION, findFamily,
} from '../src/content/sama-question-bank.mjs';
import { MODULE_BANKS, moduleBankFor, publishedModuleBanks, authoredIdPrefix } from '../src/content/module-banks.mjs';
import { generateTest, testPlan } from '../src/core/test-generation.mjs';
import { effectiveBank, nextAuthoredId, toStoredRecord } from '../src/api/bank-service.mjs';

/**
 * The Technology Risk Consultant - SAMA module Question Bank: registered
 * beside the RSA and AI/BI banks with its own tree, plan, generated paper,
 * authoring and overrides — and never bleeding into the other banks.
 */

const SAMA_KEY = 'technology-risk-sama';

let store, app, adminToken;
const call = (method, p, { body, query } = {}) =>
  app({ method, path: p, body, query, headers: { authorization: `Bearer ${adminToken}` } });

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-sama-bank-'));
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

test('the SAMA module bank is published: 10 modules, 100 questions, one family per module', () => {
  const bank = moduleBankFor(SAMA_KEY);
  assert.ok(bank, 'registered in MODULE_BANKS');
  assert.equal(bank.role_name, 'Technology Risk Consultant - SAMA');
  assert.equal(bank.version, SAMA_VERSION);
  assert.equal(bank.version, '1.1');
  assert.equal(bank.authoredPrefix, 'TRC');
  assert.equal(authoredIdPrefix(SAMA_KEY), 'TRC');
  assert.equal(bank.optional, null, 'no retired catalogue');
  assert.equal(bank.modules.length, 10);
  assert.equal(bank.questions.length, 100);
  assert.deepEqual(SAMA_MODULES.map((m) => m.key), ['R01', 'R02', 'A01', 'I01', 'O01', 'D01', 'B01', 'T01', 'F01', 'C01']);
  assert.equal(SAMA_MODULES.filter((m) => m.technical === true).length, 8);
  assert.equal(SAMA_MODULES.filter((m) => m.technical !== true).length, 2);
  assert.deepEqual(SAMA_MODULES.filter((m) => !m.technical).map((m) => m.key), ['F01', 'C01']);
  // Each module holds exactly one workbook family with 6 objective + 4 open.
  assert.equal(SAMA_FAMILIES.length, 10);
  for (const m of SAMA_MODULES) {
    assert.equal(m.families.length, 1, `${m.key} has one family`);
    assert.equal(m.families[0].objective, 6);
    assert.equal(m.families[0].open, 4);
    assert.equal(m.families[0].role, 'mixed');
    assert.equal(m.families[0].id, `${m.key}:${m.families[0].key}`);
    assert.ok(findFamily(m.families[0].id));
    const members = SAMA_QUESTIONS.filter((q) => q.module === m.key);
    assert.equal(members.length, 10);
    assert.ok(members.every((q) => q.family_id === m.families[0].id));
  }
  // The registry lists it for the Question Bank track selector.
  const published = publishedModuleBanks();
  assert.deepEqual(published.map((b) => b.role_key), ['databricks-rsa', 'databricks-ai-bi-genie', SAMA_KEY]);
  assert.equal(Object.keys(MODULE_BANKS).length, 3);
});

test('effective banks are scoped by role key; SAMA never leaks into RSA or AI/BI', async () => {
  await setup();
  const rsa = await effectiveBank(store);
  assert.equal(rsa.length, 348, 'the default effective bank is still the RSA bank');
  const sama = await effectiveBank(store, SAMA_KEY);
  assert.equal(sama.length, 100);
  assert.ok(sama.every((q) => SAMA_MODULES.some((m) => m.key === q.module)));

  const rec = toStoredRecord({
    module: 'I01', family_id: 'I01:iam-pam-segregation-of-duties', family: 'IAM, PAM & Segregation of Duties',
    type: 'open', prompt: 'An authored SAMA question that must not leak into the other banks.',
    difficulty: 4, band: 'Intermediate', mode: 'Online assessment', minutes: 5, rubric: 'Evidence.',
  }, { id: 'TRC-I01-A001', actorId: 'u1', roleKey: SAMA_KEY });
  await store.insert('bank_questions', rec);

  assert.equal((await effectiveBank(store, SAMA_KEY)).length, 101);
  assert.equal((await effectiveBank(store)).length, 348);
  assert.equal((await effectiveBank(store, 'databricks-ai-bi-genie')).length, 100);
});

test('generated SAMA papers hold the 8 risk & control + 2 reporting structure exactly', () => {
  const rng = (n) => () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let seed = 1; seed <= 8; seed += 1) {
    const result = generateTest({ modules: SAMA_MODULES, questions: SAMA_QUESTIONS }, { rng: rng(seed) });
    assert.equal(result.counts.total, 34, `seed ${seed}: paper length`);
    assert.equal(result.counts.technical_objective, 24);
    assert.equal(result.counts.technical_open, 8);
    assert.equal(result.counts.non_technical_open, 2);
    assert.deepEqual(result.warnings, [], `seed ${seed}: every module meets its quota`);

    const perModule = new Map(result.sections.map((s) => [s.module, s]));
    for (const m of SAMA_MODULES) {
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
    // Every id on the paper is a real published id, none repeated.
    assert.equal(new Set(result.questions.map((q) => q.id)).size, 34);
  }
});

test('testPlan reports the SAMA blueprint from the module list', () => {
  const plan = testPlan({ modules: SAMA_MODULES, questions: SAMA_QUESTIONS });
  assert.deepEqual(plan.blueprint, {
    technical_objective: 24, technical_open: 8, non_technical_open: 2, total: 34,
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.bank_total, 100);
  assert.equal(plan.optional_total, 0);
  assert.ok(plan.modules.every((m) => m.sufficient));
});

test('the Question Bank modules/plan/preview/family endpoints serve the SAMA bank by role_key', async () => {
  await setup();

  const modules = await call('GET', '/admin/question-bank/modules', { query: { role_key: SAMA_KEY } });
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  assert.equal(modules.body.role_key, SAMA_KEY);
  assert.equal(modules.body.role_name, 'Technology Risk Consultant - SAMA');
  assert.equal(modules.body.version, SAMA_VERSION);
  assert.equal(modules.body.bank_total, 100);
  assert.deepEqual(modules.body.blueprint, {
    technical_objective: 24, technical_open: 8, non_technical_open: 2, total: 34,
  });
  assert.equal(modules.body.technical_modules, 8);
  assert.equal(modules.body.non_technical_modules, 2);
  assert.deepEqual(modules.body.modules.map((m) => m.key), [
    'R01', 'R02', 'A01', 'I01', 'O01', 'D01', 'B01', 'T01', 'F01', 'C01',
  ]);
  assert.equal(modules.body.optional.total, 0);
  // The Question Bank track selector (fed by /meta) lists the SAMA bank.
  const meta = await call('GET', '/meta/bootstrap');
  assert.equal(meta.status, 200);
  assert.ok(meta.body.moduleBanks.some((b) => b.role_key === SAMA_KEY && b.role_name === 'Technology Risk Consultant - SAMA'));

  const plan = await call('GET', '/admin/question-bank/plan', { query: { role_key: SAMA_KEY } });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.blueprint.total, 34);
  assert.equal(plan.body.ready, true);

  const preview = await call('POST', '/admin/question-bank/preview', { body: { role_key: SAMA_KEY } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.counts.total, 34);
  assert.equal(preview.body.questions.length, 34);

  const family = await call('GET', '/admin/question-bank/families/R01:sama-csf-saudi-regulatory-assessment', { query: { role_key: SAMA_KEY } });
  assert.equal(family.status, 200, JSON.stringify(family.body));
  assert.equal(family.body.questions.length, 10);

  // Unscoped calls still serve the RSA bank.
  const rsaModules = await call('GET', '/admin/question-bank/modules');
  assert.equal(rsaModules.body.role_key, 'databricks-rsa');
  assert.equal(rsaModules.body.bank_total, 348);
});

test('authoring in the SAMA bank mints TRC ids and stores the role key', async () => {
  await setup();

  const added = await call('POST', '/admin/question-bank/questions', {
    body: {
      role_key: SAMA_KEY,
      module: 'I01', family: 'IAM, PAM & Segregation of Duties', type: 'objective',
      prompt: 'Which evidence best demonstrates that a quarterly privileged-access recertification operated effectively?',
      options: [
        { id: 'a', label: 'A policy stating recertification is required' },
        { id: 'b', label: 'Signed reviewer attestations with the full population, exceptions and revocation tickets' },
        { id: 'c', label: 'A screenshot of the PAM console home page' },
        { id: 'd', label: 'A verbal confirmation from the control owner' },
      ],
      correct_option_ids: ['b'], rationale: 'Operating effectiveness needs population, review evidence and remediation.',
      difficulty: 4, band: 'Intermediate', minutes: 2, tags: '',
    },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.question.id, 'TRC-I01-A001');
  assert.equal(added.body.question.role_key, SAMA_KEY);

  // Other banks did not grow; authored sequences are independent per bank.
  assert.equal((await effectiveBank(store)).length, 348);
  assert.equal((await effectiveBank(store, 'databricks-ai-bi-genie')).length, 100);
  const rows = await store.list('bank_questions');
  assert.equal(nextAuthoredId('I01', rows, SAMA_KEY), 'TRC-I01-A002');
  assert.equal(nextAuthoredId('I01', rows, 'databricks-rsa'), 'RSA-I01-A001');

  // A duplicate of a *published* SAMA prompt is refused within the bank.
  const dup = await call('POST', '/admin/question-bank/questions', {
    body: {
      role_key: SAMA_KEY,
      module: 'R01', family: 'SAMA CSF & Saudi Regulatory Assessment', type: 'objective',
      prompt: SAMA_QUESTIONS[0].prompt,
      options: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }],
      correct_option_ids: ['a'], difficulty: 4, band: 'Intermediate', minutes: 2, tags: '',
    },
  });
  assert.equal(dup.status, 409);

  // Hide one published SAMA question and restore it — scoped to this bank.
  const victim = SAMA_QUESTIONS[0];
  const removed = await call('DELETE', `/admin/question-bank/questions/${victim.id}`, { query: { role_key: SAMA_KEY } });
  assert.equal(removed.status, 200);
  const hidden = (await effectiveBank(store, SAMA_KEY)).find((q) => q.id === victim.id);
  assert.equal(hidden.removed, true);
  const restored = await call('PATCH', `/admin/question-bank/questions/${victim.id}`, {
    body: { active: true }, query: { role_key: SAMA_KEY },
  });
  assert.equal(restored.status, 200);
  const back = (await effectiveBank(store, SAMA_KEY)).find((q) => q.id === victim.id);
  assert.equal(back.removed, undefined);
  assert.equal(back.status, 'Active');
});
