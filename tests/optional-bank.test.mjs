import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPTIONAL_QUESTIONS, OPTIONAL_FAMILIES, optionalSummary, LEGACY_COMPETENCY_TO_MODULE,
} from '../src/content/rsa-optional-bank.mjs';
import { RSA_QUESTIONS } from '../src/content/rsa-catalogue.mjs';
import { MODULES, QUESTIONS, FAMILIES } from '../src/content/rsa-question-bank.mjs';
import { generateTest, testPlan } from '../src/core/test-generation.mjs';

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('every legacy question is carried over into the optional pool', () => {
  assert.equal(OPTIONAL_QUESTIONS.length, RSA_QUESTIONS.length);
  assert.equal(OPTIONAL_QUESTIONS.length, 115);
});

test('every optional question is flagged optional and never mandatory', () => {
  for (const q of OPTIONAL_QUESTIONS) {
    assert.equal(q.optional, true, q.id);
    assert.equal(q.mandatory, false, q.id);
    assert.ok(Number.isFinite(q.optional_priority), q.id);
  }
});

test('optional questions map onto real v1.2 modules', () => {
  const keys = new Set(MODULES.map((m) => m.key));
  for (const q of OPTIONAL_QUESTIONS) assert.ok(keys.has(q.module), `${q.id} -> ${q.module}`);
  for (const target of Object.values(LEGACY_COMPETENCY_TO_MODULE)) assert.ok(keys.has(target), target);
});

test('optional ids are unique and do not collide with the v1.2 bank', () => {
  const primary = new Set(QUESTIONS.map((q) => q.id));
  const seen = new Set();
  for (const q of OPTIONAL_QUESTIONS) {
    assert.ok(!seen.has(q.id), `duplicate ${q.id}`);
    assert.ok(!primary.has(q.id), `collides with primary ${q.id}`);
    seen.add(q.id);
  }
});

test('optional questions are shaped like v1.2 questions', () => {
  for (const q of OPTIONAL_QUESTIONS) {
    assert.ok(['objective', 'open'].includes(q.type), q.id);
    assert.ok(q.prompt && q.prompt.length > 10, q.id);
    if (q.type === 'objective') {
      assert.ok(Array.isArray(q.options), q.id);
      assert.ok(Array.isArray(q.correct_option_ids), q.id);
    } else {
      assert.equal(typeof q.rubric, 'string', q.id);
    }
  }
});

test('adding the optional pool does not change a generated test', () => {
  const withoutOptional = generateTest(
    { modules: MODULES, questions: QUESTIONS }, { rng: seeded(21) }
  );
  const withOptional = generateTest(
    { modules: MODULES, questions: [...QUESTIONS, ...OPTIONAL_QUESTIONS] }, { rng: seeded(21) }
  );
  assert.deepEqual(
    withOptional.questions.map((q) => q.id),
    withoutOptional.questions.map((q) => q.id)
  );
  assert.equal(withOptional.counts.from_optional, 0);
  assert.equal(withOptional.counts.total, 51);
});

test('no optional question is ever served while the primary bank suffices', () => {
  for (const seed of [1, 42, 777, 31337]) {
    const { questions } = generateTest(
      { modules: MODULES, questions: [...QUESTIONS, ...OPTIONAL_QUESTIONS] }, { rng: seeded(seed) }
    );
    assert.equal(questions.filter((q) => q.optional).length, 0, `seed ${seed}`);
  }
});

test('the optional pool covers a shortfall in the primary bank', () => {
  // Strip T06's open questions entirely: the module can no longer field its
  // one open question from the v1.2 bank and must fall back.
  const thinned = QUESTIONS.filter((q) => !(q.module === 'T06' && q.type === 'open'));

  const withoutFallback = generateTest({ modules: MODULES, questions: thinned }, { rng: seeded(8) });
  assert.ok(withoutFallback.warnings.some((w) => w.includes('T06')));
  assert.equal(withoutFallback.counts.technical_open, 9);

  const withFallback = generateTest(
    { modules: MODULES, questions: [...thinned, ...OPTIONAL_QUESTIONS] }, { rng: seeded(8) }
  );
  assert.deepEqual(withFallback.warnings, []);
  assert.equal(withFallback.counts.technical_open, 10);
  assert.equal(withFallback.counts.total, 51);
  assert.equal(withFallback.counts.from_optional, 1);

  const served = withFallback.questions.find((q) => q.module === 'T06' && q.type === 'open');
  assert.equal(served.optional, true);
});

test('higher-priority optional questions are preferred', () => {
  const thinned = QUESTIONS.filter((q) => !(q.module === 'T01' && q.type === 'open'));
  const pool = OPTIONAL_QUESTIONS.filter((q) => q.module === 'T01' && q.type === 'open');
  const best = Math.max(...pool.map((q) => q.optional_priority));

  for (const seed of [2, 20, 200]) {
    const { questions } = generateTest(
      { modules: MODULES, questions: [...thinned, ...OPTIONAL_QUESTIONS] }, { rng: seeded(seed) }
    );
    const served = questions.find((q) => q.module === 'T01' && q.type === 'open');
    assert.equal(served.optional_priority, best, `seed ${seed}`);
  }
});

test('the plan reports the optional pool without counting it as primary', () => {
  const plan = testPlan({ modules: MODULES, questions: [...QUESTIONS, ...OPTIONAL_QUESTIONS] });
  assert.equal(plan.optional_total, 115);
  assert.equal(plan.ready, true);
  const t01 = plan.modules.find((m) => m.module === 'T01');
  assert.ok(t01.available_optional > 0);
  // availability figures must exclude the optional pool
  const primaryObjective = QUESTIONS.filter((q) => q.module === 'T01' && q.type === 'objective').length;
  assert.equal(t01.available_objective, primaryObjective);
});

test('the summary accounts for every optional question', () => {
  const summary = optionalSummary();
  assert.equal(summary.total, OPTIONAL_QUESTIONS.length);
  const counted = summary.modules.reduce((n, m) => n + m.objective + m.open, 0);
  assert.equal(counted, OPTIONAL_QUESTIONS.length);
});

test('every optional question belongs to a module-scoped legacy family', () => {
  for (const q of OPTIONAL_QUESTIONS) {
    assert.ok(q.family_id, `${q.id} has no family_id`);
    assert.ok(q.family_id.startsWith(`${q.module}:`), `${q.id} -> ${q.family_id}`);
    assert.match(q.family, /^Legacy - /, q.id);
  }
});

test('legacy families never collide with the curated v1.2 families', () => {
  const curated = new Set(FAMILIES.map((f) => f.id));
  for (const f of OPTIONAL_FAMILIES) {
    assert.ok(!curated.has(f.id), `legacy family ${f.id} shadows a curated one`);
  }
});

test('every legacy family accounts for its questions', () => {
  assert.equal(OPTIONAL_FAMILIES.length, 7);
  const counted = OPTIONAL_FAMILIES.reduce((n, f) => n + f.objective + f.open, 0);
  assert.equal(counted, OPTIONAL_QUESTIONS.length);
  for (const f of OPTIONAL_FAMILIES) {
    const rows = OPTIONAL_QUESTIONS.filter((q) => q.family_id === f.id);
    assert.equal(rows.length, f.objective + f.open, f.id);
    assert.ok(MODULES.some((m) => m.key === f.module), `${f.id} unknown module`);
  }
});

test('the summary reports the legacy family count', () => {
  assert.equal(optionalSummary().families, OPTIONAL_FAMILIES.length);
});
