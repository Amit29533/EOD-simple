#!/usr/bin/env node
/**
 * Extract the published Technology Risk Consultant - SAMA question
 * bank from the source spreadsheet ("SAMA Question bank 1.2.xlsx").
 *
 * Sibling of scripts/extract-ai-bi-bank-from-xlsx.mjs (AI/BI bank): the same
 * one-row-per-question export shape, adapted to this workbook's column names:
 *   - the question text (objective stems embed "• A) … • B) …" options)
 *     lives in `technology_risk_assessment_question`;
 *   - the correct option is recorded in `follow_up_probes` as
 *     "Correct answer: A; …";
 *   - open questions carry their evidence in
 *     `expected_evidence_jd_aligned` and their follow-up probes in
 *     `follow_up_probes`.
 *
 * Usage:
 *   node scripts/extract-sama-bank-from-xlsx.mjs [source.xlsx|source.csv] [bank.json]
 *
 * The JSON it writes feeds scripts/build-question-bank.py with the SAMA
 * config:
 *   node scripts/extract-sama-bank-from-xlsx.mjs "SAMA Question bank 1.2.xlsx" data/sama-bank.json
 *   python3 scripts/build-question-bank.py data/sama-bank.json src/content/sama-question-bank.mjs 1.2 scripts/sama-bank-config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSheet } from '../src/core/sheet-parser.mjs';
import { correctFromCell } from '../src/core/question-intake.mjs';

const source = process.argv[2] || 'SAMA Question bank 1.2.xlsx';
const outPath = process.argv[3] || 'data/sama-bank.json';
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

const isXlsx = /\.xlsx$/i.test(source) || Buffer.from(fs.readFileSync(source)).subarray(0, 2).toString() === 'PK';
const parsed = parseSheet(
  isXlsx ? fs.readFileSync(source) : fs.readFileSync(source, 'utf8'),
  { format: isXlsx ? 'xlsx' : 'csv' },
);

/** Read a "Correct answer: A" type declaration from a probes/evidence cell. */
const correctAnswer = (text) => {
  const id = correctFromCell(text);
  return id ? id.toUpperCase() : null;
};

/**
 * Split an embedded objective question such as
 *   "Which ...?\n• A) first\n• B) second\n• C) third\n• D) fourth"
 * into { prompt, options } where options is keyed by option letter.
 */
function splitEmbeddedObjective(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const markers = [...src.matchAll(/\n\s*(?:[•▪●*·-]\s*)?([A-H])[.)]\s*/g)];
  if (markers.length < 2) return { prompt: src.trim(), options: {} };

  const prompt = src.slice(0, markers[0].index).replace(/\s+$/, '').trim();
  const options = {};
  markers.forEach((m, i) => {
    const letter = m[1];
    const start = m.index + m[0].length;
    const end = markers[i + 1]?.index ?? src.length;
    options[letter] = src.slice(start, end).trim();
  });
  return { prompt, options };
}

/** Split a semicolon-separated probe/red-flag list. */
const splitList = (value) => String(value ?? '')
  .split(/[;\n|]+|,(?![^(]*\))/)
  .map((s) => s.trim())
  .filter(Boolean);

const records = parsed.rows.map((row) => {
  const objective = String(row.type || '').trim() === 'Objective Question';
  const { prompt, options } = splitEmbeddedObjective(row.technology_risk_assessment_question);

  if (objective) {
    return {
      id: row.question_id,
      module: row.module_id,
      type: row.type,
      objective: true,
      difficulty: Number(row.difficulty_1_5) || 4,
      question_family: row.question_family,
      band: row.difficulty_band || 'Intermediate',
      mode: row.assessment_mode || 'Online assessment',
      minutes: Number(row.suggested_minutes) || 2,
      status: row.status || 'Active',
      version: String(row.version || '1'),
      randomizable: /^yes$/i.test(String(row.randomization_eligible || '').trim()),
      gap_tag: String(row.gap_tag || '').trim(),
      enrichment: String(row.enrichment_prescription || '').trim(),
      prompt,
      options,
      correct: correctAnswer(row.follow_up_probes) || Object.keys(options)[0],
      rationale: String(row.follow_up_probes || '').trim(),
      probes: splitList(row.follow_up_probes),
      expected_evidence: String(row.expected_evidence_jd_aligned || '').trim(),
      red_flags: String(row.red_flags || '').trim(),
      needs_option_review: false,
    };
  }

  return {
    id: row.question_id,
    module: row.module_id,
    type: row.type,
    objective: false,
    difficulty: Number(row.difficulty_1_5) || 4,
    question_family: row.question_family,
    band: row.difficulty_band || 'Intermediate',
    mode: row.assessment_mode || 'Online assessment',
    minutes: Number(row.suggested_minutes) || 5,
    status: row.status || 'Active',
    version: String(row.version || '1'),
    randomizable: /^yes$/i.test(String(row.randomization_eligible || '').trim()),
    gap_tag: String(row.gap_tag || '').trim(),
    enrichment: String(row.enrichment_prescription || '').trim(),
    prompt,
    probes: splitList(row.follow_up_probes),
    expected_evidence: String(row.expected_evidence_jd_aligned || '').trim(),
    red_flags: String(row.red_flags || '').trim(),
    needs_option_review: false,
  };
});

fs.writeFileSync(outPath, JSON.stringify(records, null, 1));
const objective = records.filter((r) => r.objective);
const clean = objective.filter((r) => !r.needs_option_review);
console.log(`extracted ${records.length} questions from ${source} -> ${outPath}`);
console.log(`  ${objective.length} objective (${clean.length} with complete options), ${records.length - objective.length} open`);
