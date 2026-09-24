import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSheet } from '../src/core/sheet-parser.mjs';
import { QUESTIONS, MODULES, QUESTION_BANK_VERSION } from '../src/content/sama-question-bank.mjs';
import { SAMA_QUESTIONS } from '../src/content/sama-catalogue.mjs';
import { EXAM_OPEN_ANSWER_SECONDS } from '../src/core/constants.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workbook = path.join(root, 'SAMA Question bank 1.2.xlsx');
// The workbook is the maintainer's source document and is not tracked in the
// repository, so a fresh checkout does not have it. These two tests verify the
// published bank against it; without it they have nothing to compare, so they
// report a skip naming the missing file instead of failing `npm test` with an
// ENOENT. The published bank itself is covered without the workbook by the
// catalogue, track and SAMA UI suites.
const SKIP_NO_WORKBOOK = fs.existsSync(workbook)
  ? false
  : `source workbook "${path.basename(workbook)}" is not in the checkout`;

test('SAMA v1.2 workbook is complete and its revised questions reach both catalogues', { skip: SKIP_NO_WORKBOOK }, () => {
  const { rows } = parseSheet(fs.readFileSync(workbook), { format: 'xlsx' });
  assert.equal(QUESTION_BANK_VERSION, '1.2');
  assert.equal(rows.length, 100);
  assert.equal(new Set(rows.map(r => r.question_id)).size, 100);
  assert.equal(new Set(rows.map(r => r.technology_risk_assessment_question.trim())).size, 100);
  assert.equal(rows.filter(r => r.type === 'Objective Question').length, 60);
  for (const m of MODULES) {
    const members = rows.filter(r => r.module_id === m.key);
    assert.equal(members.length, 10);
    assert.equal(members.filter(r => r.type === 'Objective Question').length, 6);
  }
  for (const row of rows) {
    const q = QUESTIONS.find(q => q.id === row.question_id);
    assert.ok(q, row.question_id);
    assert.equal(q.module, row.module_id);
    assert.equal(q.minutes, Number(row.suggested_minutes));
    assert.equal(q.status, 'Active');
    const served = SAMA_QUESTIONS.find(s => s.prompt === q.prompt);
    assert.ok(served, `${q.id} reaches the assessment catalogue`);
    if (q.type === 'objective') {
      assert.equal(q.options.length, 4);
      assert.ok(q.options.every(o => o.label.trim()));
      assert.equal(new Set(q.options.map(o => o.label)).size, 4);
      const answer = row.follow_up_probes.match(/Correct answer: ([A-D])/);
      assert.ok(answer, `${q.id} has an explicit answer key`);
      assert.deepEqual(q.correct_option_ids, [answer[1].toLowerCase()]);
      assert.deepEqual(served.correct_option_ids, q.correct_option_ids);
      assert.deepEqual(served.options, q.options);
    } else {
      assert.equal(q.prompt, row.technology_risk_assessment_question.trim());
      assert.equal(q.rubric, row.expected_evidence_jd_aligned.trim());
      assert.ok(q.rubric.length > 0);
      assert.equal(q.minutes, 2);
      assert.equal(q.minutes * 60, EXAM_OPEN_ANSWER_SECONDS);
      assert.equal(q.probes.join('; '), row.follow_up_probes.trim());
      assert.ok(served.rubric.includes(q.rubric));
      assert.ok(served.rubric.includes(q.probes.join('; ')));
    }
  }
});

test('SAMA extraction and generation reproduce the published bank byte for byte', { skip: SKIP_NO_WORKBOOK }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sama-workbook-'));
  try {
    const json = path.join(tmp, 'bank.json');
    const output = path.join(tmp, 'bank.mjs');
    execFileSync(process.execPath, ['scripts/extract-sama-bank-from-xlsx.mjs', workbook, json], { cwd: root });
    execFileSync('python3', ['scripts/build-question-bank.py', json, output, '1.2', 'scripts/sama-bank-config.json'], { cwd: root });
    assert.equal(fs.readFileSync(output, 'utf8'), fs.readFileSync(path.join(root, 'src/content/sama-question-bank.mjs'), 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
