import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { validateBatch, splitEmbeddedOptions, correctFromCell } from '../src/core/question-intake.mjs';
import { MODULES } from '../src/content/rsa-question-bank.mjs';

/** Module question-bank bulk import from the published workbook's CSV shape. */

let app, store, adminToken, tmp;

const call = (method, p, { token, body, query } = {}) =>
  app({ method, path: p, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-qcsv-'));
  store = createJsonStore(path.join(tmp, 'db.json'));
  app = await createApp(store);
  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin', email: '', active: true,
    password_hash: hashPassword('admin-pass-123'),
  });
  adminToken = (await call('POST', '/auth/login', {
    body: { username: 'admin', password: 'admin-pass-123' },
  })).body.token;
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const families = MODULES.flatMap((m) => m.families.map((f) => ({ ...f, module: m.key })));

const embeddedPrompt = `A regulated bank must make a high-impact decision about Lakehouse while compute/storage separation creates a competing constraint. Which response is most defensible?\r\n• A) Allow teams to choose within shared guardrails, then standardize the architecture after early adoption reveals which trade-offs matter most.\r\n• B) Choose the fastest compliant option, document the main risks, and use the first delivery phase to validate remaining assumptions.\r\n• C) Select the most comprehensive option, add governance checkpoints, and resolve cost or operating concerns as implementation evidence becomes available.\r\n• D) Define the outcome and non-negotiable constraints, compare viable options, make the trade-off explicit, and test the highest-risk assumption before commitment.`;

const uniquePrompt = `A brand-new CSV bank must make a high-impact decision about Lakehouse while compute/storage separation creates a competing constraint. Which response is most defensible?\r\n• A) Allow teams to choose within shared guardrails, then standardize after adoption.\r\n• B) Choose the fastest compliant option and validate remaining assumptions.\r\n• C) Select the most comprehensive option and add governance checkpoints.\r\n• D) Define the outcome, compare options, and test the highest-risk assumption before commitment.`;

test('splitEmbeddedOptions recovers a stem and A-D from the workbook prompt cell', () => {
  const { prompt, options } = splitEmbeddedOptions(embeddedPrompt);
  assert.ok(prompt.endsWith('defensible?'), prompt);
  assert.equal(options.length, 4);
  assert.deepEqual(options.map((o) => o.id), ['a', 'b', 'c', 'd']);
  assert.ok(options[0].label.startsWith('Allow teams'));
  assert.ok(options[3].label.startsWith('Define the outcome'));
});

test('correctFromCell reads the workbook key from follow-up/evidence text', () => {
  assert.equal(correctFromCell('Correct answer: D; requires advanced judgment.'), 'd');
  assert.equal(correctFromCell('Correct answer is B.'), 'b');
  assert.equal(correctFromCell('No answer in here.'), null);
});

test('validateBatch accepts a workbook objective with inline options and aliased headers', () => {
  const report = validateBatch([{
    question_id: 'RSA-CSV-001', module_id: 'T01', type: 'Objective Question',
    difficulty_1_5: '4', original_ecod_question: embeddedPrompt,
    follow_up_probes: 'Correct answer: D; requires advanced judgment.',
    expected_evidence_ecod_designed: 'Define the outcome, non-negotiables, options and assumptions.',
    red_flags: 'Premature commitment', gap_tag: 'Lakehouse advanced decision — T01',
    enrichment_prescription: 'Run a stakeholder-informed trade-off exercise.',
    suggested_minutes: '2', status: 'Active', version: '1.4',
    question_family: 'Advanced Technical Judgment', difficulty_band: 'Intermediate',
    assessment_mode: 'Online assessment', randomization_eligible: 'Yes',
  }], { modules: MODULES, families });

  assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));
  const [q] = report.accepted.map((a) => a.question);
  assert.equal(q.module, 'T01');
  assert.equal(q.family_id, 'T01:advanced-technical-judgment');
  assert.equal(q.type, 'objective');
  assert.equal(q.options.length, 4);
  assert.deepEqual(q.correct_option_ids, ['d']);
  assert.equal(q.gap_tag, 'Lakehouse advanced decision — T01');
  assert.equal(q.enrichment, 'Run a stakeholder-informed trade-off exercise.');
  assert.equal(q.rationale, 'Correct answer: D; requires advanced judgment.');
  assert.equal(q.needs_option_review, false);
});

test('validateBatch accepts a workbook open question with aliased headers', () => {
  const report = validateBatch([{
    question_id: 'RSA-CSV-002', module_id: 'F01', type: 'Customer Simulation',
    difficulty_1_5: '4', original_ecod_question: "A customer says, 'Our existing platform works.'",
    follow_up_probes: 'What would you clarify first?;What evidence would build confidence?',
    expected_evidence_ecod_designed: 'Discovery, trade-offs, evidence and a next step.',
    red_flags: 'Feature-dumps', gap_tag: 'Customer Solutioning — F01',
    enrichment_prescription: 'Run a stakeholder-informed discovery simulation.',
    suggested_minutes: '5', status: 'Active', version: '1.4',
    question_family: 'Customer Solutioning', difficulty_band: 'Intermediate',
    assessment_mode: 'Live assessor', randomization_eligible: 'Yes',
  }], { modules: MODULES, families });

  assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));
  const [q] = report.accepted.map((a) => a.question);
  assert.equal(q.type, 'open');
  assert.equal(q.probes.length, 2);
  assert.equal(q.rubric, 'Discovery, trade-offs, evidence and a next step.');
});

test('the import endpoint dry-runs and commits a raw workbook CSV', async () => {
  const csv = [
    'question_id,module_id,type,difficulty_1_5,original_ecod_question,follow_up_probes,expected_evidence_ecod_designed,red_flags,gap_tag,enrichment_prescription,suggested_minutes,status,version,question_family,difficulty_band,assessment_mode,randomization_eligible',
    `RSA-CSV-NEW,"T01","Objective Question","4","${uniquePrompt.replace(/"/g, '""')}","Correct answer: D; requires advanced judgment.","Define the outcome.","Premature commitment","A new CSV decision — T01","Run the exercise","2","Active","1.4","Advanced Technical Judgment","Intermediate","Online assessment","Yes"`,
  ].join('\n');

  const dry = await call('POST', '/admin/question-bank/import', {
    token: adminToken,
    body: { csv, filename: 'bank-1.4.csv', dry_run: true },
  });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.accepted, 1, JSON.stringify(dry.body));
  assert.equal(dry.body.rejected, 0);
  assert.equal(dry.body.imported, 0);

  const commit = await call('POST', '/admin/question-bank/import', {
    token: adminToken,
    body: { csv, filename: 'bank-1.4.csv', dry_run: false },
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.imported, 1);

  const saved = (await store.list('bank_questions'))[0];
  assert.equal(saved.module, 'T01');
  assert.equal(saved.family, 'Advanced Technical Judgment');
  assert.equal(saved.type, 'objective');
  assert.equal(saved.options.length, 4);
  assert.deepEqual(saved.correct_option_ids, ['d']);
});

test('re-importing the same workbook prompt is reported as a duplicate', async () => {
  const csv = [
    'module_id,type,original_ecod_question,follow_up_probes,expected_evidence_ecod_designed,question_family,randomization_eligible,status,version',
    `T01,"Objective Question","${uniquePrompt.replace(/"/g, '""')}","Correct answer: D;","Define the outcome.","Advanced Technical Judgment","Yes","Active","1.4"`,
  ].join('\n');
  const res = await call('POST', '/admin/question-bank/import', {
    token: adminToken, body: { csv, dry_run: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicates, 1, JSON.stringify(res.body));
  assert.equal(res.body.accepted, 0);
});
