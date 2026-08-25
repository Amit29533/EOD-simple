/**
 * Question allocation — pure selection logic (no I/O, fully unit-tested).
 *
 * When an admin allocates an assessment they may cap it at X questions instead
 * of serving the whole bank. The cap must never distort the report: the overall
 * score is a competency-weighted blend, so the X questions are spread across
 * competencies *in proportion to their weight* using the largest-remainder
 * (Hamilton) method, with iterative capping when a competency has fewer
 * questions than its quota.
 *
 * Properties this guarantees:
 *  - exactly min(X, pool.length) questions are returned;
 *  - every competency that has questions keeps at least one whenever X allows
 *    (so no competency silently scores 0%);
 *  - the allocator can sample a different set on each capped allocation while
 *    keeping the weighted split stable;
 *  - questions come back in their configured display order after sampling, so
 *    the candidate experience remains tidy;
 *  - once sampled, the snapshot makes the chosen set auditable and immutable.
 */

/** Stable per-competency grouping, ordered by the competency configuration. */
function groupByCompetency(questions, competencies) {
  const groups = new Map();
  for (const c of competencies) {
    groups.set(c.id, { id: c.id, weight: Math.max(0, Number(c.weight ?? 0)), items: [] });
  }
  for (const q of questions) {
    let g = groups.get(q.competency_id);
    if (!g) {
      // Orphan question (its competency was removed/deactivated). Keep it
      // eligible so the bank total always matches what admins can see.
      g = { id: q.competency_id ?? '', weight: 0, items: [] };
      groups.set(g.id, g);
    }
    g.items.push(q);
  }
  return [...groups.values()].filter((g) => g.items.length > 0);
}

/**
 * Apportion `total` seats across `groups` proportionally to weight, never
 * exceeding each group's capacity. Largest-remainder with iterative capping.
 */
function apportion(groups, total) {
  const quota = new Map(groups.map((g) => [g.id, 0]));
  let remaining = Math.min(total, groups.reduce((s, g) => s + g.items.length, 0));

  // Guarantee representation first: one seat per competency while seats allow.
  // Competencies with more weight are served first when seats run short.
  const byWeight = [...groups].sort((a, b) => b.weight - a.weight || b.items.length - a.items.length);
  for (const g of byWeight) {
    if (remaining <= 0) break;
    quota.set(g.id, 1);
    remaining -= 1;
  }

  // Proportional apportionment of what is left, re-run whenever a group fills up.
  let open = groups.filter((g) => quota.get(g.id) < g.items.length);
  while (remaining > 0 && open.length) {
    // Equal split when no weights are configured at all.
    const totalWeight = open.reduce((s, g) => s + g.weight, 0);
    const share = (g) => (totalWeight > 0 ? g.weight / totalWeight : 1 / open.length);

    const ideal = open.map((g) => ({ g, exact: remaining * share(g) }));
    let handed = 0;
    for (const row of ideal) {
      const capacity = row.g.items.length - quota.get(row.g.id);
      row.floor = Math.min(Math.floor(row.exact), capacity);
      row.rest = row.exact - Math.floor(row.exact);
      quota.set(row.g.id, quota.get(row.g.id) + row.floor);
      handed += row.floor;
    }
    let leftover = remaining - handed;
    // Largest remainder wins the rounding seats; ties go to the heavier
    // competency, then to the larger bank, then to configuration order.
    const contenders = ideal
      .filter((r) => quota.get(r.g.id) < r.g.items.length)
      .sort((a, b) => b.rest - a.rest || b.g.weight - a.g.weight || b.g.items.length - a.g.items.length);
    for (const row of contenders) {
      if (leftover <= 0) break;
      quota.set(row.g.id, quota.get(row.g.id) + 1);
      leftover -= 1;
    }
    remaining = leftover;
    const stillOpen = groups.filter((g) => quota.get(g.id) < g.items.length);
    // No progress possible (everything full) — stop.
    if (stillOpen.length === open.length && handed === 0 && leftover === remaining && remaining > 0 && !contenders.length) break;
    open = stillOpen;
  }
  return quota;
}

/**
 * Return a random sample of `count` items without changing the source array.
 * A caller-supplied RNG keeps the pure selection logic straightforward to test.
 */
function sample(items, count, rng) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const raw = Number(rng());
    const value = Number.isFinite(raw)
      ? Math.max(0, Math.min(1 - Number.EPSILON, raw))
      : 0;
    const j = Math.floor(value * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/**
 * Pick `limit` questions from `questions`, balanced across `competencies` by weight.
 * `limit` of null/undefined/0-or-less-than-1 or >= bank size returns the whole bank.
 *
 * Pass `{ randomize: true }` for an allocation-time sample. The quota remains
 * deterministic and weighted, while the questions within each competency are
 * shuffled so repeated allocations do not always serve the same first items.
 * `rng` is injectable for tests; production allocations use Math.random.
 * Returns a new array in the original (display) order.
 */
export function selectQuestions(questions = [], competencies = [], limit = null, { randomize = false, rng = Math.random } = {}) {
  const pool = [...questions];
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0 || n >= pool.length) return pool;

  const groups = groupByCompetency(pool, competencies);
  const quota = apportion(groups, Math.floor(n));

  const keep = new Set();
  for (const g of groups) {
    const count = quota.get(g.id) ?? 0;
    const selected = randomize ? sample(g.items, count, rng) : g.items.slice(0, count);
    for (const q of selected) keep.add(q.id);
  }
  return pool.filter((q) => keep.has(q.id));
}

/**
 * Human-readable preview of how a cap would be distributed — used by the admin
 * UI so the choice is transparent before the assessment is created.
 */
export function allocationPreview(questions = [], competencies = [], limit = null) {
  const selected = selectQuestions(questions, competencies, limit);
  const byComp = new Map();
  for (const q of selected) byComp.set(q.competency_id, (byComp.get(q.competency_id) || 0) + 1);
  const points = selected.reduce((s, q) => s + Number(q.points ?? 1), 0);
  return {
    total: selected.length,
    bank_total: questions.length,
    points,
    per_competency: competencies
      .map((c) => ({ competency_id: c.id, name: c.name, weight: Number(c.weight ?? 0), count: byComp.get(c.id) || 0 }))
      .filter((row) => row.count > 0 || questions.some((q) => q.competency_id === row.competency_id)),
  };
}
