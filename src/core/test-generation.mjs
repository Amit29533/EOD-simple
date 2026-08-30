/**
 * Module-based test generation - pure selection logic (no I/O, unit-tested).
 *
 * The finalized Question Bank is organised MODULE -> FAMILY -> QUESTION.
 * A generated test is assembled to a fixed structure rather than by weight
 * apportionment (which is what src/core/question-selection.mjs does for the
 * legacy competency-based catalogue):
 *
 *   10 technical  T01-T10    4 each       3 objective + 1 open  = 40
 *   10 non-technical
 *     C01-C04, P01-P04,
 *     F01-F02                1 open each                        = 10
 *                                                        total  = 50
 *
 * i.e. 30 technical objective + 10 technical open + 10 non-technical open.
 * There is no mandatory/common question: every question is drawn by its
 * module's quota and nothing is pinned.
 *
 * Questions are sampled at random inside each module while the per-module
 * structure above is held exactly, and the finished paper is then INTERLEAVED
 * so open questions are spread evenly through the objective ones instead of
 * arriving in blocks: never two open questions back to back, at most two
 * objective ones together. `rng` is injectable so tests are deterministic;
 * production passes Math.random.
 *
 * Questions flagged `optional: true` are never drawn by the normal quota.
 * They are a fallback pool: if a module cannot fill its quota from its
 * primary questions, optional ones are drawn (highest-priority first) to make
 * up the shortfall, and the shortfall is reported. This is what keeps a
 * generated test at a full 50 questions even when a module's bank is thin.
 */

import { MODULE_TEST_STRUCTURE } from './constants.mjs';
import { shuffle, interleave } from './paper-order.mjs';

// Per-module quotas, re-exported from the single source of truth in
// constants.mjs so the quotas the generator enforces are literally the same
// numbers the API publishes.
export const TECHNICAL_OBJECTIVE_PER_MODULE = MODULE_TEST_STRUCTURE.technical_objective;
export const TECHNICAL_OPEN_PER_MODULE = MODULE_TEST_STRUCTURE.technical_open;
export const NON_TECHNICAL_OPEN_PER_MODULE = MODULE_TEST_STRUCTURE.non_technical_open;

/**
 * Structure of a complete paper, for display and validation.
 *
 * Paper-wide TOTALS, derived from the per-module quotas — note the same key
 * means something different in each: `technical_objective` is 3 per module in
 * MODULE_TEST_STRUCTURE and 30 across the paper here. Deriving it means
 * changing a quota in one place updates the generator, the blueprint, the
 * admin preview and /meta/bootstrap together.
 */
export const TEST_BLUEPRINT = {
  technical_objective:
    MODULE_TEST_STRUCTURE.technical_modules * MODULE_TEST_STRUCTURE.technical_objective,
  technical_open:
    MODULE_TEST_STRUCTURE.technical_modules * MODULE_TEST_STRUCTURE.technical_open,
  non_technical_open:
    MODULE_TEST_STRUCTURE.non_technical_modules * MODULE_TEST_STRUCTURE.non_technical_open,
  total: MODULE_TEST_STRUCTURE.total,
};

const isObjective = (q) => q?.type === 'objective';
const isOpen = (q) => q?.type === 'open';
const isOptional = (q) => q?.optional === true;
/**
 * A question is servable unless it has been switched off. Exported because the
 * admin bank counts must use the *same* rule as selection — otherwise the UI
 * advertises questions that can never be drawn.
 */
export const isActive = (q) => q?.active !== false && q?.status !== 'Retired' && q?.status !== 'Inactive';

/**
 * Draw by shuffling, then taking `count`. A caller-supplied rng keeps selection
 * deterministic under test (see `shuffle` in core/paper-order.mjs).
 */
function sample(items, count, rng) {
  return shuffle(items, rng).slice(0, Math.max(0, count));
}

/**
 * Draw `count` questions matching `predicate` from `pool`.
 *
 * Primary (non-optional) questions are drawn first; optional questions are
 * only used to cover a shortfall, ordered by descending `optional_priority`
 * so a curated fallback is preferred over an arbitrary one. Returns the drawn
 * questions plus how many had to come from the optional pool and how many
 * seats could not be filled at all.
 */
function draw(pool, predicate, count, rng) {
  const eligible = pool.filter((q) => isActive(q) && predicate(q));
  const primary = eligible.filter((q) => !isOptional(q));
  const picked = sample(primary, count, rng);

  let fromOptional = 0;
  if (picked.length < count) {
    const optional = eligible.filter(isOptional);
    const byPriority = new Map();
    for (const q of optional) {
      const key = Number(q.optional_priority ?? 0);
      if (!byPriority.has(key)) byPriority.set(key, []);
      byPriority.get(key).push(q);
    }
    const tiers = [...byPriority.keys()].sort((a, b) => b - a);
    for (const tier of tiers) {
      if (picked.length >= count) break;
      const need = count - picked.length;
      const drawn = sample(byPriority.get(tier), need, rng);
      picked.push(...drawn);
      fromOptional += drawn.length;
    }
  }
  return { picked, fromOptional, short: Math.max(0, count - picked.length) };
}

/** Modules in their configured display order. */
function orderedModules(modules) {
  return [...modules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Build one complete test.
 *
 *   generateTest({ modules, questions }, { rng })
 *
 * Returns:
 *   questions  - the paper, ordered so objective and open items interleave
 *   sections   - per-module record of what was drawn, in configured order
 *   warnings   - human-readable notes when a module could not be filled
 *   counts     - realised structure, comparable against TEST_BLUEPRINT
 *
 * Questions are drawn module by module (that is what holds the structure
 * exact), then the whole paper is ordered: a candidate meets MCQs and open
 * questions mixed rather than 40 objective items followed by 10 recorded
 * answers. `sections` keeps the module order, so the admin preview can still
 * show which module each draw came from.
 */
export function generateTest({ modules = [], questions = [] } = {}, { rng = Math.random } = {}) {
  const byModule = new Map();
  for (const q of questions) {
    if (!byModule.has(q.module)) byModule.set(q.module, []);
    byModule.get(q.module).push(q);
  }

  const assembled = [];
  const sections = [];
  const warnings = [];
  let usedOptional = 0;

  // ---- every module, in configured order -----------------------------
  for (const mod of orderedModules(modules)) {
    const pool = byModule.get(mod.key) || [];
    const technical = mod.technical === true;

    const wantObjective = technical ? TECHNICAL_OBJECTIVE_PER_MODULE : 0;
    const wantOpen = technical ? TECHNICAL_OPEN_PER_MODULE : NON_TECHNICAL_OPEN_PER_MODULE;

    const objective = draw(pool, isObjective, wantObjective, rng);
    const open = draw(pool, isOpen, wantOpen, rng);

    const drawn = [...objective.picked, ...open.picked];
    assembled.push(...drawn);
    usedOptional += objective.fromOptional + open.fromOptional;

    if (objective.short) {
      warnings.push(
        `${mod.key} (${mod.name}): only ${objective.picked.length} of ${wantObjective} objective questions available.`
      );
    }
    if (open.short) {
      warnings.push(
        `${mod.key} (${mod.name}): only ${open.picked.length} of ${wantOpen} open question(s) available.`
      );
    }

    sections.push({
      module: mod.key, name: mod.name, group: mod.group,
      technical,
      objective: objective.picked.length, open: open.picked.length,
      from_optional: objective.fromOptional + open.fromOptional,
      short: objective.short + open.short,
      question_ids: drawn.map((q) => q.id),
    });
  }

  // Order the paper once the quotas are met, so the structure above is never
  // disturbed by what the candidate sees. Open questions are spread evenly
  // through the objective ones: never two recorded answers back to back, and at
  // most two MCQs together (see core/paper-order.mjs). A plain shuffle would
  // still hand out runs of five or six of a kind.
  const paper = interleave(assembled, isOpen, rng);

  const technicalSections = sections.filter((s) => s.technical);
  const nonTechnicalSections = sections.filter((s) => !s.technical);
  const counts = {
    technical_objective: technicalSections.reduce((n, s) => n + s.objective, 0),
    technical_open: technicalSections.reduce((n, s) => n + s.open, 0),
    non_technical_open: nonTechnicalSections.reduce((n, s) => n + s.open, 0),
    total: paper.length,
    from_optional: usedOptional,
  };

  return { questions: paper, sections, warnings, counts, blueprint: TEST_BLUEPRINT };
}

/**
 * Non-destructive preview of what a generated test would look like: the
 * per-module availability an admin needs to see *before* allocating, without
 * drawing a paper. Reports, per module, how many primary and optional
 * questions exist and whether the module can meet its quota.
 */
export function testPlan({ modules = [], questions = [] } = {}) {
  const byModule = new Map();
  for (const q of questions) {
    if (!byModule.has(q.module)) byModule.set(q.module, []);
    byModule.get(q.module).push(q);
  }

  const rows = [];
  for (const mod of orderedModules(modules)) {
    const technical = mod.technical === true;
    const pool = (byModule.get(mod.key) || []).filter(isActive);

    const wantObjective = technical ? TECHNICAL_OBJECTIVE_PER_MODULE : 0;
    const wantOpen = technical ? TECHNICAL_OPEN_PER_MODULE : NON_TECHNICAL_OPEN_PER_MODULE;

    const objectivePool = pool.filter((q) => isObjective(q) && !isOptional(q));
    const openPool = pool.filter((q) => isOpen(q) && !isOptional(q));
    const optionalPool = pool.filter(isOptional);

    rows.push({
      module: mod.key, name: mod.name, group: mod.group,
      technical,
      required_objective: wantObjective,
      required_open: wantOpen,
      available_objective: objectivePool.length,
      available_open: openPool.length,
      available_optional: optionalPool.length,
      sufficient: objectivePool.length >= wantObjective && openPool.length >= wantOpen,
    });
  }

  const all = questions.filter(isActive);
  return {
    blueprint: TEST_BLUEPRINT,
    modules: rows,
    bank_total: all.length,
    optional_total: all.filter(isOptional).length,
    ready: rows.every((r) => r.sufficient),
  };
}
