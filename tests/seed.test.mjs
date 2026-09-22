import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';

/**
 * The seed's worked example (Neha, scored by Arjun) is the first report every
 * evaluator opens, and it is the only scored paper in a fresh workspace. It is
 * written by a script, not through the exam, so nothing else checks that its
 * stored answers have the shape the exam would have produced — and they did
 * not: the script answered "the first three questions of each competency"
 * positionally as [objective, objective, open], but the served paper is
 * interleaved, so a prose answer landed on a multi-select (auto-scored 0) and
 * an empty option list on an open question. The example report then showed
 * a wrong mark in a competency the candidate was meant to have aced, while
 * the two competencies meant to be weak (one wrong pick among ~15 questions)
 * did not register as gaps at all.
 */

function runSeed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-seed-test-'));
  const file = path.join(dir, 'ecod.json');
  // `import.meta.dirname` only exists from Node 20.11; package.json allows >=20.
  const out = spawnSync(process.execPath, ['scripts/seed.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATA_FILE: file, SEED_FRESH: '1', STORAGE: 'json' },
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  return { file, log: out.stdout };
}

const shapeOk = (q, answer) => {
  switch (q.type) {
    case 'mcq_single': return typeof answer === 'string' && (q.options || []).some((o) => o.id === answer);
    case 'mcq_multi': return Array.isArray(answer) && answer.every((id) => (q.options || []).some((o) => o.id === id));
    case 'scale': return Number.isInteger(answer) && answer >= 1 && answer <= 5;
    case 'text': return typeof answer === 'string' ? answer.trim().length > 0 : Boolean(answer && typeof answer === 'object' && !Array.isArray(answer));
    default: return false;
  }
};

test('the seeded worked example stores an answer of the right shape for every question', async () => {
  const { file } = runSeed();
  const store = createJsonStore(file);
  const scored = (await store.list('assessments', { status: 'scored' }));
  assert.equal(scored.length, 1, 'exactly one worked example');
  const paper = sortedQuestions(scored[0].snapshot_json);
  const rows = await store.list('responses', { assessment_id: scored[0].id });
  assert.equal(rows.length, paper.length, 'one row per served question');
  const byQid = new Map(rows.map((r) => [r.question_id, r]));
  const wrongShape = paper.filter((q) => !shapeOk(q, byQid.get(q.id)?.answer));
  assert.deepEqual(
    wrongShape.map((q) => `${q.type}: ${JSON.stringify(byQid.get(q.id)?.answer).slice(0, 40)}`),
    [],
    'every stored answer matches its question type',
  );
  for (const q of paper.filter((x) => x.type === 'text')) {
    const r = byQid.get(q.id);
    assert.ok(Number.isFinite(r.assessor_score) && r.assessor_score >= 0 && r.assessor_score <= q.points, `open question scored within 0-${q.points}`);
  }
});

test('the seeded worked example reports the two intended weak competencies as gaps and nothing else', async () => {
  const { file, log } = runSeed();
  const store = createJsonStore(file);
  const [a] = await store.list('assessments', { status: 'scored' });
  const report = a.report_json;
  const gaps = report.areas_to_improve.map((g) => g.competency).sort();
  assert.deepEqual(gaps, ['DevOps, CI/CD & Production Readiness', 'Performance & Cost Optimization'].sort(),
    'the deliberately weak areas — and only those — surface as improvement areas');
  for (const c of report.competencies) {
    if (gaps.includes(c.name)) assert.ok(c.score_pct < 50, `${c.name} reads as weak (${c.score_pct}%)`);
    else assert.ok(c.score_pct >= 85, `${c.name} reads as strong (${c.score_pct}%)`);
  }
  assert.ok(report.overall_pct > 70 && report.overall_pct < 90, `a credible overall (${report.overall_pct}%)`);
  // Two gaps under an "Enterprise Ready" badge would read as a contradiction
  // on the first report every evaluator opens.
  assert.equal(report.band?.key, 'development_needed', `the label matches the gaps (${report.band?.label})`);
  assert.match(log, /example report for Neha Kulkarni/);
});

test('the seeded worked example reads the same on every run', async () => {
  // The paper is shuffled at every allocation; the example's right/wrong
  // pattern follows the catalogue order, not the paper's, so two fresh seeds
  // must produce the same report (the seed used to flip between "Enterprise
  // Ready, 1 gap" and "Development Needed, 2 gaps" from one run to the next).
  const digest = async () => {
    const store = createJsonStore(runSeed().file);
    const [a] = await store.list('assessments', { status: 'scored' });
    return {
      overall: a.report_json.overall_pct,
      label: a.report_json.band?.label,
      competencies: a.report_json.competencies.map((c) => [c.name, c.score_pct, c.status]),
    };
  };
  assert.deepEqual(await digest(), await digest());
});
