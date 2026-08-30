/**
 * Module-based test generation - pure selection logic (no I/O, unit-tested).
 *
 * The finalized Question Bank v1.2 is organised FAMILY -> MODULE -> QUESTION.
 * A generated test is assembled to a fixed structure rather than by weight
 * apportionment (which is what src/core/question-selection.mjs does for the
 * legacy competency-based catalogue):
 *
 *   Mandatory module (M00)   1 question   always served, always first
 *   10 technical  T01-T10    4 each       3 objective + 1 open  = 40
 *   10 non-technical
 *     C01-C04, P01-P04,
 *     F01-F02                1 open each                        = 10
 *                                                        total  = 51
 *
 * i.e. 30 technical objective + 10 technical open + 10 non-technical open,
 * plus the mandatory question on top.
 *
 * Questions are sampled at random inside each module while the per-module
 * structure above is held exactly. `rng` is injectable so tests are
 * deterministic; production passes Math.random.
 *
 * Questions flagged `optional: true` are never drawn by the normal quota.
 * They are a fallback pool: if a module cannot fill its quota from its
 * primary questions, optional ones are drawn (highest-priority first) to make
 * up the shortfall, and the shortfall is reported. This is what keeps a
 * generated test at a full 51 questions even when a module's bank is thin.
 */

export const TECHNICAL_OBJECTIVE_PER_MODULE = 3;
export const TECHNICAL_OPEN_PER_MODULE = 1;
export const NON_TECHNICAL_OPEN_PER_MODULE = 1;

/** Structure of a complete paper, for display and validation. */
export const TEST_BLUEPRINT = {
  mandatory: 1,
  technical_objective: 30,
  technical_open: 10,
  non_technical_open: 10,
  total: 51,
};

const isObjective = (q) => q?.type === 'objective';
const isOpen = (q) => q?.type === 'open';
const isOptional = (q) => q?.optional === true;
const isActive = (q) => q?.active !== false && q?.status !== 'Retired' && q?.status !== 'Inactive';

/**
 * Fisher-Yates over a copy, then take `count`. A caller-supplied rng keeps
 * selection deterministic under test. Guards against an rng returning values
 * outside [0, 1) so a bad injection cannot produce an out-of-range index.
 */
function sample(items, count, rng) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const raw = Number(rng());
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(1 - Number.EPSILON, raw)) : 0;
    const j = Math.floor(value * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.max(0, count));
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
 *   questions  - the paper, mandatory first, then module by module in order
 *   sections   - per-module record of what was drawn (for the preview UI)
 *   warnings   - human-readable notes when a module could not be filled
 *   counts     - realised structure, comparable against TEST_BLUEPRINT
 */
export function generateTest({ modules = [], questions = [] } = {}, { rng = Math.random } = {}) {
  const byModule = new Map();
  for (const q of questions) {
    if (!byModule.has(q.module)) byModule.set(q.module, []);
    byModule.get(q.module).push(q);
  }

  const paper = [];
  const sections = [];
  const warnings = [];
  let usedOptional = 0;

  // ---- mandatory question, always first ------------------------------
  const mandatoryPool = questions.filter((q) => q.mandatory === true && isActive(q));
  const mandatory = mandatoryPool.length ? sample(mandatoryPool, 1, rng) : [];
  if (!mandatory.length) {
    warnings.push('No mandatory question is configured; the paper starts with the first module.');
  } else {
    paper.push(...mandatory);
    sections.push({
      module: 'M00', name: 'Mandatory Common Question', family: 'mandatory',
      technical: false, mandatory: true,
      objective: 0, open: mandatory.length, from_optional: 0, short: 0,
      question_ids: mandatory.map((q) => q.id),
    });
  }

  // ---- every other module, in configured order -----------------------
  for (const mod of orderedModules(modules)) {
    if (mod.mandatory === true) continue;
    const pool = (byModule.get(mod.key) || []).filter((q) => q.mandatory !== true);
    const technical = mod.technical === true;

    const wantObjective = technical ? TECHNICAL_OBJECTIVE_PER_MODULE : 0;
    const wantOpen = technical ? TECHNICAL_OPEN_PER_MODULE : NON_TECHNICAL_OPEN_PER_MODULE;

    const objective = draw(pool, isObjective, wantObjective, rng);
    const open = draw(pool, isOpen, wantOpen, rng);

    const drawn = [...objective.picked, ...open.picked];
    paper.push(...drawn);
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
      technical, mandatory: false,
      objective: objective.picked.length, open: open.picked.length,
      from_optional: objective.fromOptional + open.fromOptional,
      short: objective.short + open.short,
      question_ids: drawn.map((q) => q.id),
    });
  }

  const technicalSections = sections.filter((s) => s.technical);
  const nonTechnicalSections = sections.filter((s) => !s.technical && !s.mandatory);
  const counts = {
    mandatory: sections.filter((s) => s.mandatory).reduce((n, s) => n + s.open + s.objective, 0),
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

  // The mandatory question is flagged on the question itself and keeps the
  // module id it was authored under (e.g. F01), so the mandatory *module*
  // draws from that flag rather than from a module bucket of its own.
  const mandatoryPool = questions.filter((q) => q.mandatory === true && isActive(q));

  const rows = [];
  for (const mod of orderedModules(modules)) {
    const technical = mod.technical === true;
    const mandatory = mod.mandatory === true;
    const pool = mandatory
      ? mandatoryPool
      : (byModule.get(mod.key) || []).filter((q) => isActive(q) && q.mandatory !== true);

    const wantObjective = mandatory ? 0 : technical ? TECHNICAL_OBJECTIVE_PER_MODULE : 0;
    const wantOpen = mandatory ? 1 : technical ? TECHNICAL_OPEN_PER_MODULE : NON_TECHNICAL_OPEN_PER_MODULE;

    const objectivePool = pool.filter((q) => isObjective(q) && !isOptional(q));
    const openPool = pool.filter((q) => isOpen(q) && !isOptional(q));
    const optionalPool = pool.filter(isOptional);

    rows.push({
      module: mod.key, name: mod.name, group: mod.group,
      technical, mandatory,
      required_objective: wantObjective,
      required_open: wantOpen,
      available_objective: mandatory ? pool.length : objectivePool.length,
      available_open: mandatory ? pool.length : openPool.length,
      available_optional: optionalPool.length,
      sufficient: mandatory
        ? pool.length >= 1
        : objectivePool.length >= wantObjective && openPool.length >= wantOpen,
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
