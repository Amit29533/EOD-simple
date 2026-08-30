import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateTest, testPlan, TEST_BLUEPRINT,
  TECHNICAL_OBJECTIVE_PER_MODULE, TECHNICAL_OPEN_PER_MODULE,
} from '../src/core/test-generation.mjs';
import {
  MODULES, QUESTIONS, MODULE_GROUPS, FAMILIES, findFamily,
} from '../src/content/rsa-question-bank.mjs';
import { maxRunLength, maxRunOf } from '../src/core/paper-order.mjs';

/** Deterministic rng so a failing case is reproducible. */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const bank = { modules: MODULES, questions: QUESTIONS };

test('published bank has exactly the 20 modules', () => {
  assert.equal(MODULES.length, 20);
  assert.equal(MODULES.filter((m) => m.mandatory).length, 0, 'no mandatory module exists any more');
  assert.equal(MODULES.filter((m) => m.technical).length, 10);
  assert.equal(MODULES.filter((m) => !m.technical).length, 10);
});

test('module keys are exactly T01-T10, C01-C04, P01-P04, F01-F02', () => {
  const keys = MODULES.map((m) => m.key).sort();
  const expected = [
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
    'C01', 'C02', 'C03', 'C04',
    'P01', 'P02', 'P03', 'P04',
    'F01', 'F02',
  ].sort();
  assert.deepEqual(keys, expected);
});

test('every module belongs to a declared group', () => {
  const groups = new Set(MODULE_GROUPS.map((g) => g.key));
  for (const m of MODULES) assert.ok(groups.has(m.group), `${m.key} -> ${m.group}`);
});

test('every module owns at least one family, scoped to itself', () => {
  for (const m of MODULES) {
    assert.ok(m.families.length >= 1, `${m.key} has no families`);
    for (const f of m.families) {
      assert.equal(f.id, `${m.key}:${f.key}`, 'family id is module-scoped');
      assert.ok(['objective', 'open', 'mixed'].includes(f.role), `${f.id} role`);
    }
  }
});

test('every question resolves to a family that exists in its own module', () => {
  for (const q of QUESTIONS) {
    const family = findFamily(q.family_id);
    assert.ok(family, `${q.id} -> unknown family ${q.family_id}`);
    assert.equal(family.module, q.module, `${q.id} family belongs to another module`);
  }
});

test('a family name repeated across modules stays independently addressable', () => {
  const shared = FAMILIES.filter((f) => f.key === 'advanced-technical-judgment');
  assert.equal(shared.length, 10, 'one per technical module');
  assert.equal(new Set(shared.map((f) => f.id)).size, 10, 'ids are unique');
});

test('modules are ordered T01-T10, then C01-C04, P01-P04, F01-F02', () => {
  const ordered = [...MODULES].sort((a, b) => a.order - b.order).map((m) => m.key);
  assert.deepEqual(ordered, [
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
    'C01', 'C02', 'C03', 'C04',
    'P01', 'P02', 'P03', 'P04',
    'F01', 'F02',
  ]);
});

test('a generated paper follows that same module order', () => {
  const { sections } = generateTest(bank, { rng: seeded(17) });
  const expected = [...MODULES].sort((a, b) => a.order - b.order).map((m) => m.key);
  assert.deepEqual(sections.map((s) => s.module), expected);
});

test('every module has enough questions for its quota', () => {
  const plan = testPlan(bank);
  for (const row of plan.modules) {
    assert.ok(row.sufficient, `${row.module} cannot fill its quota: ${JSON.stringify(row)}`);
  }
  assert.equal(plan.ready, true);
});

test('a generated test matches the blueprint exactly', () => {
  const { counts, warnings } = generateTest(bank, { rng: seeded(7) });
  assert.deepEqual(warnings, []);
  assert.equal(counts.technical_objective, TEST_BLUEPRINT.technical_objective);
  assert.equal(counts.technical_open, TEST_BLUEPRINT.technical_open);
  assert.equal(counts.non_technical_open, TEST_BLUEPRINT.non_technical_open);
  assert.equal(counts.total, TEST_BLUEPRINT.total);
});

test('30 technical objective + 10 technical open + 10 non-technical open', () => {
  const { questions } = generateTest(bank, { rng: seeded(11) });
  const technical = new Set(MODULES.filter((m) => m.technical).map((m) => m.key));

  const served = questions;
  const techObjective = served.filter((q) => technical.has(q.module) && q.type === 'objective');
  const techOpen = served.filter((q) => technical.has(q.module) && q.type === 'open');
  const nonTechOpen = served.filter((q) => !technical.has(q.module) && q.type === 'open');

  assert.equal(techObjective.length, 30);
  assert.equal(techOpen.length, 10);
  assert.equal(nonTechOpen.length, 10);
  assert.equal(served.filter((q) => !technical.has(q.module) && q.type === 'objective').length, 0);
});

test('each technical module contributes exactly 3 objective + 1 open', () => {
  const { questions } = generateTest(bank, { rng: seeded(23) });
  for (const mod of MODULES.filter((m) => m.technical)) {
    const mine = questions.filter((q) => q.module === mod.key);
    assert.equal(mine.filter((q) => q.type === 'objective').length, TECHNICAL_OBJECTIVE_PER_MODULE, mod.key);
    assert.equal(mine.filter((q) => q.type === 'open').length, TECHNICAL_OPEN_PER_MODULE, mod.key);
  }
});

test('each non-technical module contributes exactly 1 open question', () => {
  const { questions } = generateTest(bank, { rng: seeded(31) });
  for (const mod of MODULES.filter((m) => !m.technical)) {
    const mine = questions.filter((q) => q.module === mod.key);
    assert.equal(mine.length, 1, mod.key);
    assert.equal(mine[0].type, 'open', mod.key);
  }
});

test('no question is pinned or always-served: the whole paper varies by seed', () => {
  // With the common question dropped, nothing is guaranteed to appear. Two
  // different seeds must be free to differ in their very first item.
  const firsts = new Set();
  for (const seed of [1, 2, 3, 99, 1234, 55, 777]) {
    const { questions } = generateTest(bank, { rng: seeded(seed) });
    assert.equal(questions.length, TEST_BLUEPRINT.total, `seed ${seed}`);
    firsts.add(questions[0].id);
  }
  assert.ok(firsts.size > 1, 'the first question was identical across every seed');
});

test('nothing in the bank claims to be mandatory', () => {
  assert.equal(QUESTIONS.filter((q) => q.mandatory === true).length, 0);
  assert.equal(MODULES.filter((m) => m.mandatory === true).length, 0);
  const { sections } = generateTest(bank, { rng: seeded(8) });
  assert.equal(sections.filter((s) => s.mandatory).length, 0);
});

test('open questions never sit back to back, and MCQs at most two in a row', () => {
  // The requirement behind the shuffle: a candidate must not meet a block of
  // recorded answers or a block of MCQs. 30 objective / 20 open spreads to
  // ceil(30 / 21) = 2 objective at most, and never two opens together.
  for (const seed of [1, 5, 42, 99, 4242, 777]) {
    const { questions } = generateTest(bank, { rng: seeded(seed) });
    const types = questions.map((q) => q.type);
    assert.equal(types.length, TEST_BLUEPRINT.total, `seed ${seed}`);
    assert.equal(maxRunOf(types, 'open'), 1, `two open questions in a row (seed ${seed})`);
    assert.equal(maxRunLength(types), 2, `a block of MCQs survived the mix (seed ${seed})`);
  }
});

test('the mix is random, only its spacing is fixed', () => {
  const order = (seed) => generateTest(bank, { rng: seeded(seed) }).questions.map((q) => q.id).join(',');
  assert.notEqual(order(1), order(2), 'different seeds produce different papers');
});

test('a paper never repeats a question', () => {
  for (const seed of [5, 50, 500]) {
    const { questions } = generateTest(bank, { rng: seeded(seed) });
    const ids = questions.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}`);
  }
});

test('selection is random across runs but always structurally identical', () => {
  const a = generateTest(bank, { rng: seeded(2) });
  const b = generateTest(bank, { rng: seeded(9999) });
  const idsA = a.questions.map((q) => q.id).join(',');
  const idsB = b.questions.map((q) => q.id).join(',');
  assert.notEqual(idsA, idsB, 'two different seeds produced identical papers');
  assert.deepEqual(a.counts, b.counts);
});

test('the same seed reproduces the same paper', () => {
  const a = generateTest(bank, { rng: seeded(4242) });
  const b = generateTest(bank, { rng: seeded(4242) });
  assert.deepEqual(a.questions.map((q) => q.id), b.questions.map((q) => q.id));
});

test('optional questions are never drawn while primary ones suffice', () => {
  const questions = QUESTIONS.map((q) => (
    q.module === 'T01' && q.type === 'objective'
      ? { ...q, optional: true, optional_priority: 5 }
      : q
  ));
  // T01 now has ONLY optional objectives, so they must be used as fallback.
  const { sections, counts } = generateTest({ modules: MODULES, questions }, { rng: seeded(3) });
  const t01 = sections.find((s) => s.module === 'T01');
  assert.equal(t01.objective, 3);
  assert.equal(t01.from_optional, 3);
  assert.equal(counts.technical_objective, 30);

  // Everywhere else the optional pool stays untouched.
  const untouched = sections.filter((s) => s.module !== 'T01');
  assert.equal(untouched.reduce((n, s) => n + s.from_optional, 0), 0);
});

test('a thin module reports a shortfall instead of silently under-filling', () => {
  const questions = QUESTIONS.filter(
    (q) => !(q.module === 'T05' && q.type === 'objective') || q.id === 'RSA-T05-011'
  );
  const { counts, warnings, sections } = generateTest({ modules: MODULES, questions }, { rng: seeded(6) });
  const t05 = sections.find((s) => s.module === 'T05');
  assert.ok(t05.short > 0);
  assert.ok(warnings.some((w) => w.includes('T05')));
  assert.ok(counts.technical_objective < 30);
});

test('objective questions carry options and a correct answer', () => {
  const { questions } = generateTest(bank, { rng: seeded(77) });
  for (const q of questions.filter((x) => x.type === 'objective')) {
    assert.ok(Array.isArray(q.options) && q.options.length >= 1, q.id);
    assert.ok(Array.isArray(q.correct_option_ids) && q.correct_option_ids.length === 1, q.id);
    const ids = q.options.map((o) => o.id);
    assert.ok(ids.includes(q.correct_option_ids[0]), `${q.id} correct option not among options`);
  }
});

test('open questions carry an assessor rubric', () => {
  const { questions } = generateTest(bank, { rng: seeded(88) });
  for (const q of questions.filter((x) => x.type === 'open')) {
    assert.ok(typeof q.rubric === 'string' && q.rubric.length > 10, `${q.id} has no rubric`);
  }
});

test('every published question is well formed', () => {
  const seen = new Set();
  for (const q of QUESTIONS) {
    assert.ok(q.id && !seen.has(q.id), `duplicate id ${q.id}`);
    seen.add(q.id);
    assert.ok(q.prompt && q.prompt.length > 20, `${q.id} prompt too short`);
    assert.ok(['objective', 'open'].includes(q.type), `${q.id} bad type`);
    assert.ok(MODULES.some((m) => m.key === q.module), `${q.id} unknown module ${q.module}`);
  }
  assert.equal(QUESTIONS.length, 348);
});

test('every module has at least the 10 objective questions the bank promises', () => {
  for (const mod of MODULES) {
    const objective = QUESTIONS.filter((q) => q.module === mod.key && q.type === 'objective');
    assert.ok(objective.length >= 10, `${mod.key} has only ${objective.length}`);
  }
});

// ---------------------------------------------------------------------------
// Regression tests: bank-integrity invariants
//
// The family counts shown in the Admin UI come from the module tree, while the
// drill-down lists questions by `family_id`. Those are two different code
// paths over the same data, so nothing stops them disagreeing — and they did:
// the mandatory question was declared under M00 but stored under F01, so M00
// rendered "0 objective, 0 open" with an empty drill-down while F01 reported
// one fewer open question than it holds.
// ---------------------------------------------------------------------------

test('every family declares the counts it actually holds', () => {
  for (const family of FAMILIES) {
    const rows = QUESTIONS.filter((q) => q.family_id === family.id);
    const objective = rows.filter((q) => q.type === 'objective').length;
    const open = rows.filter((q) => q.type === 'open').length;
    assert.equal(objective, family.objective, `${family.id} objective`);
    assert.equal(open, family.open, `${family.id} open`);
  }
});

test('no family is empty', () => {
  for (const family of FAMILIES) {
    const rows = QUESTIONS.filter((q) => q.family_id === family.id);
    assert.ok(rows.length > 0, `${family.id} has no questions`);
  }
});

test('every module holds at least one question', () => {
  for (const mod of MODULES) {
    const rows = QUESTIONS.filter((q) => q.module === mod.key);
    assert.ok(rows.length > 0, `${mod.key} has no questions`);
  }
});

test('a family declares the role its questions actually have', () => {
  for (const family of FAMILIES) {
    const rows = QUESTIONS.filter((q) => q.family_id === family.id);
    const hasObjective = rows.some((q) => q.type === 'objective');
    const hasOpen = rows.some((q) => q.type === 'open');
    const expected = hasObjective && hasOpen ? 'mixed' : hasObjective ? 'objective' : 'open';
    assert.equal(family.role, expected, family.id);
  }
});

test('the retired common question is retained as an ordinary F01 open question', () => {
  // Dropping the mandatory concept must not lose content: the item the PDF
  // labelled "Common Question" is still in the bank, now drawn by F01's quota
  // like any other open question.
  const question = QUESTIONS.find((q) => q.id === 'RSA-F01-002');
  assert.ok(question, 'the former common question is missing from the bank');
  assert.equal(question.module, 'F01');
  assert.equal(question.type, 'open');
  assert.equal(question.mandatory, undefined);
});

test('the modules partition the bank: every question counted exactly once', () => {
  const keys = new Set(MODULES.map((m) => m.key));
  let counted = 0;
  for (const mod of MODULES) counted += QUESTIONS.filter((q) => q.module === mod.key).length;
  assert.equal(counted, QUESTIONS.length);
  for (const q of QUESTIONS) assert.ok(keys.has(q.module), `${q.id} -> ${q.module}`);
});

test('the blueprint is derived from the per-module quotas, not restated', () => {
  const technical = MODULES.filter((m) => m.technical).length;
  const nonTechnical = MODULES.filter((m) => !m.technical).length;
  assert.equal(TEST_BLUEPRINT.technical_objective, technical * TECHNICAL_OBJECTIVE_PER_MODULE);
  assert.equal(TEST_BLUEPRINT.technical_open, technical * TECHNICAL_OPEN_PER_MODULE);
  assert.equal(TEST_BLUEPRINT.non_technical_open, nonTechnical);
  assert.equal(
    TEST_BLUEPRINT.total,
    TEST_BLUEPRINT.technical_objective
      + TEST_BLUEPRINT.technical_open + TEST_BLUEPRINT.non_technical_open,
  );
});

test('every section describes itself with the same shape', () => {
  const { sections } = generateTest(bank, { rng: seeded(11) });
  const groups = new Set(MODULE_GROUPS.map((g) => g.key));
  for (const s of sections) {
    // `group`, never the old `family` key — the mandatory section used to be
    // hand-built with a different shape from every other section.
    assert.ok(s.group, `${s.module} has no group`);
    assert.ok(groups.has(s.group), `${s.module} -> ${s.group}`);
    assert.equal(s.family, undefined, `${s.module} still carries a stale 'family' key`);
    const mod = MODULES.find((m) => m.key === s.module);
    assert.ok(mod, `${s.module} is not a real module`);
    assert.equal(s.name, mod.name);
    assert.equal(s.question_ids.length, s.objective + s.open);
  }
});
