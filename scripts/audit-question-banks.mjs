import { RSA_QUESTIONS } from '../src/content/rsa-catalogue.mjs';
import { AIBI_QUESTIONS } from '../src/content/ai-bi-genie-catalogue.mjs';
import { SAMA_QUESTIONS } from '../src/content/sama-catalogue.mjs';
import { QUESTIONS as RSA_MODULE_QUESTIONS } from '../src/content/rsa-question-bank.mjs';
import { QUESTIONS as AIBI_MODULE_QUESTIONS } from '../src/content/ai-bi-genie-question-bank.mjs';
import { QUESTIONS as SAMA_MODULE_QUESTIONS } from '../src/content/sama-question-bank.mjs';
import { auditCatalogue, auditModuleBank, duplicatePromptsAcross } from '../src/core/question-bank-quality.mjs';

const catalogues = [
  ['RSA catalogue', RSA_QUESTIONS],
  ['AI/BI catalogue', AIBI_QUESTIONS],
  ['SAMA catalogue', SAMA_QUESTIONS],
];
const results = [
  ...catalogues.map(([name, questions]) => auditCatalogue(name, questions)),
  auditModuleBank('RSA module bank', RSA_MODULE_QUESTIONS),
  auditModuleBank('AI/BI module bank', AIBI_MODULE_QUESTIONS),
  auditModuleBank('SAMA module bank', SAMA_MODULE_QUESTIONS),
];
const crossDuplicates = duplicatePromptsAcross(catalogues);
for (const result of results) {
  console.log(`${result.errors.length ? 'FAIL' : 'PASS'} ${result.name}: ${result.total} questions`);
  for (const error of result.errors) console.error(`  - ${error}`);
}
if (crossDuplicates.length) {
  console.error(`FAIL cross-catalogue duplicate prompts: ${crossDuplicates.length}`);
  for (const duplicate of crossDuplicates) console.error(`  - ${duplicate.banks.join(' / ')}: ${duplicate.prompt}`);
}
const failures = results.reduce((sum, result) => sum + result.errors.length, 0) + crossDuplicates.length;
if (failures) {
  console.error(`Question-bank audit failed with ${failures} issue${failures === 1 ? '' : 's'}.`);
  process.exitCode = 1;
} else {
  console.log(`PASS all published question banks: ${results.reduce((sum, result) => sum + result.total, 0)} records checked; no duplicate prompts or structural errors.`);
}

