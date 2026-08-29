import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectQuestions, allocationPreview } from '../src/core/question-selection.mjs';

const comps = [
  { id: 'c1', name: 'Architecture', weight: 50 },
  { id: 'c2', name: 'Engineering', weight: 30 },
  { id: 'c3', name: 'Advisory', weight: 20 },
];
/** 10 questions per competency, display order preserved. */
const bank = comps.flatMap((c, ci) =>
  Array.from({ length: 10 }, (_, i) => ({ id: `${c.id}-q${i + 1}`, competency_id: c.id, points: 4, order: ci * 10 + i })));

const countBy = (rows) => rows.reduce((m, q) => ({ ...m, [q.competency_id]: (m[q.competency_id] || 0) + 1 }), {});

test('no limit (null / 0 / negative) serves the whole bank', () => {
  for (const limit of [null, undefined, 0, -5, '']) {
    assert.equal(selectQuestions(bank, comps, limit).length, bank.length, `limit=${limit}`);
  }
});

test('a limit at or above the bank size serves the whole bank', () => {
  assert.equal(selectQuestions(bank, comps, 30).length, 30);
  assert.equal(selectQuestions(bank, comps, 500).length, 30);
});

test('returns exactly X questions and splits them by competency weight', () => {
  const picked = selectQuestions(bank, comps, 10);
  assert.equal(picked.length, 10);
  // weights 50/30/20 over 10 seats
  assert.deepEqual(countBy(picked), { c1: 5, c2: 3, c3: 2 });
});

test('exact count holds across every possible X', () => {
  for (let x = 1; x <= bank.length; x += 1) {
    assert.equal(selectQuestions(bank, comps, x).length, x, `X=${x}`);
  }
});

test('every competency keeps at least one question once X allows it', () => {
  const picked = selectQuestions(bank, comps, 3);
  assert.deepEqual(countBy(picked), { c1: 1, c2: 1, c3: 1 });
});

test('when X is smaller than the competency count the heaviest are served first', () => {
  assert.deepEqual(countBy(selectQuestions(bank, comps, 1)), { c1: 1 });
  assert.deepEqual(countBy(selectQuestions(bank, comps, 2)), { c1: 1, c2: 1 });
});

test('a competency with a small bank cannot be over-drawn; the surplus is redistributed', () => {
  const thin = [
    { id: 'a1', competency_id: 'c1', points: 4 },
    { id: 'a2', competency_id: 'c1', points: 4 },
    { id: 'a3', competency_id: 'c1', points: 4 },
    { id: 'b1', competency_id: 'c2', points: 4 }, // only one available
    ...Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, competency_id: 'c3', points: 4 })),
  ];
  const picked = selectQuestions(thin, comps, 8);
  assert.equal(picked.length, 8);
  const by = countBy(picked);
  assert.ok(by.c2 <= 1, 'never serves more questions than a competency actually has');
  assert.ok(by.c1 <= 3);
});

test('questions come back in configured display order', () => {
  const picked = selectQuestions(bank, comps, 12);
  const orders = picked.map((q) => q.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test('selection is deterministic', () => {
  const a = selectQuestions(bank, comps, 13).map((q) => q.id);
  const b = selectQuestions(bank, comps, 13).map((q) => q.id);
  assert.deepEqual(a, b);
});

test('randomized selection changes the question sample but keeps weighted quotas', () => {
  const normal = selectQuestions(bank, comps, 10).map((q) => q.id);
  const sampled = selectQuestions(bank, comps, 10, { randomize: true, rng: () => 0 }).map((q) => q.id);
  assert.equal(sampled.length, 10);
  assert.deepEqual(countBy(selectQuestions(bank, comps, 10, { randomize: true, rng: () => 0 })), { c1: 5, c2: 3, c3: 2 });
  assert.notDeepEqual(sampled, normal, 'a capped allocation should not always use the first questions');
});

test('unweighted competencies split evenly', () => {
  const flat = comps.map((c) => ({ ...c, weight: 0 }));
  assert.deepEqual(countBy(selectQuestions(bank, flat, 9)), { c1: 3, c2: 3, c3: 3 });
});

test('orphan questions (competency removed) stay eligible', () => {
  const withOrphan = [...bank, { id: 'orphan', competency_id: 'gone', points: 4 }];
  assert.equal(selectQuestions(withOrphan, comps, 31).length, 31);
});

test('capped papers pin the common oral question first and include five from the oral set', () => {
  const oral = Array.from({ length: 10 }, (_, i) => ({
    id: `oral-${i}`, competency_id: 'c3', points: 6, order: i,
    question_set: 'rsa-oral', pin_first: i === 0, prompt: `Oral ${i}`,
  }));
  const extra = Array.from({ length: 80 }, (_, i) => ({
    id: `x${i}`, competency_id: comps[i % 3].id, points: 4, order: 100 + i,
  }));
  const mixed = [...bank, ...oral, ...extra];
  const picked = selectQuestions(mixed, comps, 50, { randomize: true, rng: () => 0.3 });
  assert.equal(picked.length, 50);
  assert.equal(picked[0].id, 'oral-0', 'COMMON oral question is always first');
  assert.equal(picked.filter((q) => q.question_set === 'rsa-oral').length, 5);
  assert.ok(picked.slice(0, 5).every((q) => q.question_set === 'rsa-oral'));
});

test('allocationPreview reports the served split and its points total', () => {
  const preview = allocationPreview(bank, comps, 10);
  assert.equal(preview.total, 10);
  assert.equal(preview.bank_total, 30);
  assert.equal(preview.points, 40);
  assert.deepEqual(preview.per_competency.map((r) => r.count), [5, 3, 2]);
});
