import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RSA_QUESTIONS } from '../src/content/rsa-catalogue.mjs';
import { AIBI_QUESTIONS } from '../src/content/ai-bi-genie-catalogue.mjs';
import { SAMA_QUESTIONS } from '../src/content/sama-catalogue.mjs';
import { QUESTIONS as RSA_MODULE_QUESTIONS } from '../src/content/rsa-question-bank.mjs';
import { QUESTIONS as AIBI_MODULE_QUESTIONS } from '../src/content/ai-bi-genie-question-bank.mjs';
import { QUESTIONS as SAMA_MODULE_QUESTIONS } from '../src/content/sama-question-bank.mjs';
import { auditCatalogue, auditModuleBank, duplicatePromptsAcross } from '../src/core/question-bank-quality.mjs';

test('all published catalogues pass the duplicate and structure audit', () => {
  const catalogues = [
    ['RSA catalogue', RSA_QUESTIONS],
    ['AI/BI catalogue', AIBI_QUESTIONS],
    ['SAMA catalogue', SAMA_QUESTIONS],
  ];
  for (const [name, questions] of catalogues) {
    assert.deepEqual(auditCatalogue(name, questions).errors, [], name);
  }
  assert.deepEqual(duplicatePromptsAcross(catalogues), []);
});

test('all published module banks have unique ids, prompts and valid answers', () => {
  const banks = [
    ['RSA module bank', RSA_MODULE_QUESTIONS],
    ['AI/BI module bank', AIBI_MODULE_QUESTIONS],
    ['SAMA module bank', SAMA_MODULE_QUESTIONS],
  ];
  for (const [name, questions] of banks) {
    assert.deepEqual(auditModuleBank(name, questions).errors, [], name);
  }
});

test('the quality audit catches the defects that make an assessment unsafe', () => {
  const bad = [
    { competency: 'x', type: 'mcq_single', difficulty: 'basic', points: 4, prompt: 'Same?', options: [{ id: 'a', label: 'Duplicate' }, { id: 'b', label: 'Duplicate' }], correct_option_ids: ['z'] },
    { competency: 'x', type: 'text', difficulty: 'advanced', points: 6, prompt: 'Same?', rubric: '' },
  ];
  const errors = auditCatalogue('bad', bad).errors.join('\n');
  assert.match(errors, /duplicate option label/);
  assert.match(errors, /does not exist/);
  assert.match(errors, /duplicate prompt/);
  assert.match(errors, /needs an assessor rubric/);
});

