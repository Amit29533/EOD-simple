import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoScore, pctToLevel, readinessBand, computeReport, validateFrameworkConfig } from '../src/core/scoring.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';

const q = (type, extra = {}) => ({ id: 'q1', type, points: 4, ...extra });

test('autoScore: mcq_single', () => {
  const question = q('mcq_single', { correct_option_ids: ['b'], options: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(autoScore(question, 'b'), 4);
  assert.equal(autoScore(question, 'a'), 0);
  assert.equal(autoScore(question, null), 0);
});

test('autoScore: mcq_multi strict exact-set', () => {
  const question = q('mcq_multi', { correct_option_ids: ['a', 'c'], options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  assert.equal(autoScore(question, ['a', 'c']), 4);
  assert.equal(autoScore(question, ['c', 'a']), 4, 'order independent');
  assert.equal(autoScore(question, ['a']), 0, 'partial set scores zero');
  assert.equal(autoScore(question, ['a', 'b', 'c']), 0, 'extra option scores zero');
});

test('autoScore: scale maps 1..5 to 0..points', () => {
  const question = q('scale', { points: 3 });
  assert.equal(autoScore(question, 5), 3);
  assert.equal(autoScore(question, 1), 0.6);
  assert.equal(autoScore(question, 0), 0);
  assert.equal(autoScore(question, 7), 0);
});

test('autoScore: text returns null (manual)', () => {
  assert.equal(autoScore(q('text'), 'anything'), null);
});

test('pctToLevel maps thresholds to 1..5', () => {
  const t = [0, 20, 40, 60, 80];
  assert.equal(pctToLevel(0, t), 1);
  assert.equal(pctToLevel(19.9, t), 1);
  assert.equal(pctToLevel(20, t), 2);
  assert.equal(pctToLevel(60, t), 4);
  assert.equal(pctToLevel(100, t), 5);
});

test('readinessBand picks highest matching band', () => {
  const cfg = DEFAULT_FRAMEWORK_CONFIG;
  assert.equal(readinessBand(85, cfg).key, 'enterprise_ready');
  assert.equal(readinessBand(55, cfg).key, 'development_needed');
  assert.equal(readinessBand(12, cfg).key, 'not_ready');
});

test('computeReport: weighted blend, levels, gaps, ordering', () => {
  const snapshot = {
    role: { id: 'r1', name: 'RSA', key: 'rsa' },
    framework: { name: 'FW', config: DEFAULT_FRAMEWORK_CONFIG },
    competencies: [
      { id: 'c1', name: 'Architecture', weight: 60, target_level: 4, enrichment_hint: 'study blueprints', active: true },
      { id: 'c2', name: 'DevOps', weight: 40, target_level: 4, active: true },
    ],
    questions: [
      { id: 'q1', competency_id: 'c1', points: 4, type: 'mcq_single', active: true },
      { id: 'q2', competency_id: 'c1', points: 6, type: 'text', active: true },
      { id: 'q3', competency_id: 'c2', points: 5, type: 'mcq_single', active: true },
      { id: 'q4', competency_id: 'c2', points: 5, type: 'text', active: true },
    ],
  };
  const responses = {
    q1: { final_score: 4 },   // c1: 4+5=9/10 = 90pct -> L5, gap -1 strength
    q2: { final_score: 5 },
    q3: { final_score: 0 },   // c2: 1/10 = 10pct -> L1, gap 3 critical
    q4: { final_score: 1, assessor_comment: 'weak' },
  };
  const report = computeReport(snapshot, responses);
  // overall = 90*0.6 + 10*0.4 = 58
  assert.equal(report.overall_pct, 58);
  assert.equal(report.band.key, 'development_needed');
  const c1 = report.competencies.find((c) => c.name === 'Architecture');
  const c2 = report.competencies.find((c) => c.name === 'DevOps');
  assert.equal(c1.observed_level, 5);
  assert.equal(c1.status, 'strength');
  assert.equal(c2.observed_level, 1);
  assert.equal(c2.status, 'critical_gap');
  assert.equal(report.areas_to_improve.length, 1);
  assert.equal(report.areas_to_improve[0].competency, 'DevOps');
  assert.equal(report.areas_to_improve[0].severity, 'critical_gap');
  assert.equal(report.strengths.length, 1);
  assert.equal(c2.breakdown.length, 2);
  assert.equal(c2.breakdown[1].assessor_comment, 'weak');
});

test('computeReport: heavier gap sorts first even with lower weight', () => {
  const snapshot = {
    role: null,
    framework: { config: DEFAULT_FRAMEWORK_CONFIG },
    competencies: [
      { id: 'a', name: 'A', weight: 10, target_level: 5, active: true },
      { id: 'b', name: 'B', weight: 90, target_level: 3, active: true },
    ],
    questions: [
      { id: 'qa', competency_id: 'a', points: 1, type: 'mcq_single', active: true },
      { id: 'qb', competency_id: 'b', points: 1, type: 'mcq_single', active: true },
    ],
  };
  const report = computeReport(snapshot, { qa: { final_score: 0.5 }, qb: { final_score: 0.7 } });
  // A: 50pct -> L3, gap 2; B: 70pct -> L4, gap -1 -> strength (target 3)
  assert.equal(report.areas_to_improve.length, 1);
  assert.equal(report.areas_to_improve[0].competency, 'A');
});

test('validateFrameworkConfig catches bad input', () => {
  assert.equal(validateFrameworkConfig(DEFAULT_FRAMEWORK_CONFIG).length, 0);
  assert.ok(validateFrameworkConfig({ readiness_bands: [{ key: 'x', label: 'X', min: 50 }], level_thresholds: [0, 20, 40, 60, 80], gap_severity: { moderate: 1, critical: 2 } }).length > 0);
  assert.ok(validateFrameworkConfig({ readiness_bands: [{ key: 'a', label: 'A', min: 80 }, { key: 'b', label: 'B', min: 0 }], level_thresholds: [5, 20, 40, 60, 80], gap_severity: { moderate: 1, critical: 2 } }).length > 0, 'thresholds must start at 0');
  assert.ok(validateFrameworkConfig({ readiness_bands: [{ key: 'a', label: 'A', min: 80 }, { key: 'b', label: 'B', min: 0 }], level_thresholds: [0, 20, 40, 60, 80], gap_severity: { moderate: 2, critical: 1 } }).length > 0);
});
