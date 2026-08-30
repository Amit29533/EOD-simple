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
 *  - questions come back arranged as a paper: the pinned question first, then
 *    the rest interleaved so objective and open items alternate, each stamped
 *    with the position it is served at;
 *  - once sampled, the snapshot makes the chosen set auditable and immutable.
 */

import { RSA_ORAL_IN_CAP, RSA_ORAL_SET } from './constants.mjs';
import { interleave } from './paper-order.mjs';
import { isOpenQuestion } from './spoken-answer.mjs';

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
 * Returns a new array of copies: the pinned question first, then every other
 * served question ordered so objective and open items interleave, each row
 * stamped with the `position` it will be served at. Pass `{ shuffle: false }`
 * to keep the legacy grouping (pinned, spoken set, then display order) when the
 * caller only counts the selection.
 */
function isPinFirst(q) { return q?.pin_first === true; }
function isOralSet(q) { return q?.question_set === RSA_ORAL_SET; }

/**
 * Strip a leading enumerator/label ("COMMON QUESTION —", "Q3:") from a prompt.
 * Labels are ALL-CAPS (or numeric) tags; the mixed-case lead-in of an ordinary
 * sentence ("A client gives you a vague requirement: …") is not a label, so it
 * is preserved. The body after the label is left exactly as typed, so healers
 * can compare it for equality against the published prompt. Shared by the
 * comparison key and the healers that de-label legacy rows copied before the
 * label was dropped from the published catalogue.
 */
export function stripPromptLabel(prompt) {
  return String(prompt ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^[A-Z0-9][A-Z0-9 '/]{1,40}\s*[-\u2013\u2014\u2015\u2212:]\s+/, '')
    .trim();
}

/**
 * Normalized comparison key for a question prompt.
 *
 * Legacy stores can hold two copies of the *same* published question whose
 * prompts differ only by typography — curly vs straight quotes, en/em dashes,
 * spacing, letter case, or a leading label that a later catalogue revision
 * added (or an admin retyped without it). Exact-match dedupe lets both
 * through, so the candidate was served the same question twice — once with
 * the microphone control, once without (the older copy predated
 * `audio_required`). Comparing normalized keys closes that gap; verified
 * collision-free across the published catalogue.
 */
export function promptKey(prompt) {
  return stripPromptLabel(String(prompt ?? ''))
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * When two stored rows turn out to be the same question, the surviving row
 * keeps its own id (responses and scores are keyed by it) but must not lose
 * the metadata its duplicate carried: a legacy flag-less copy merged with the
 * current published copy must still demand audio, stay pinned and belong to
 * the oral set. Only additive merges — never blank out a non-empty field.
 */
export function mergeDuplicateMetadata(kept, twin) {
  if (!twin) return kept;
  const merged = { ...kept };
  merged.pin_first = merged.pin_first === true || twin.pin_first === true;
  merged.audio_required = merged.audio_required === true || twin.audio_required === true;
  if (!merged.question_set && twin.question_set) merged.question_set = twin.question_set;
  if (!merged.help_text && twin.help_text) merged.help_text = twin.help_text;
  if (!merged.rubric && twin.rubric) merged.rubric = twin.rubric;
  return merged;
}

/**
 * A question must only ever be served once. If storage ever contains the same
 * id twice, or two prompts that are the same question modulo typography, the
 * first occurrence is served and the duplicates' oral metadata is merged into
 * it (see mergeDuplicateMetadata).
 */
function uniqueBy(questions) {
  const ids = new Map();
  const prompts = new Map();
  const out = [];
  for (const q of questions) {
    if (!q) continue;
    const idKey = q.id ? `id:${q.id}` : '';
    const promptId = q.prompt ? promptKey(q.prompt) : '';
    const keptAt = (idKey && ids.get(idKey)) ?? (promptId && prompts.get(promptId));
    if (Number.isInteger(keptAt)) {
      out[keptAt] = mergeDuplicateMetadata(out[keptAt], q);
      continue;
    }
    if (idKey) ids.set(idKey, out.length);
    if (promptId) prompts.set(promptId, out.length);
    out.push(q);
  }
  return out;
}

/**
 * Order the paper that will actually be served.
 *
 * A `pin_first` question still opens it — the common warm-up an assessor
 * expects to see first. Everything after the pin is INTERLEAVED: open questions
 * are spread evenly through the objective ones, so no two recorded answers are
 * ever back to back and the objective runs stay as short as the mix allows (see
 * core/paper-order.mjs). The previous rule served the whole spoken set next and
 * the rest in display order, which handed a candidate a block of recorded
 * answers followed by a block of MCQs.
 *
 * `shuffle: false` keeps the old grouping for callers that only count the
 * selection (the allocation preview) rather than arrange it.
 *
 * Every returned row carries `position` — its place in this paper — because
 * the order has to survive a round trip through storage: the candidate's
 * cursor, the assessor's review list and the scorer all re-read the snapshot
 * and must land on the same question (see sortedQuestions in quiz-session.mjs).
 * Rows are copied so a caller's bank is never mutated.
 */
function arrange(selected, { shuffle = true, rng = Math.random } = {}) {
  const uniq = uniqueBy(selected);
  const pins = uniq.filter(isPinFirst);
  const others = uniq.filter((q) => !isPinFirst(q));

  let body;
  if (shuffle) {
    body = interleave(others, isOpenQuestion, rng);
  } else {
    const oral = others.filter(isOralSet).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const rest = others.filter((q) => !isOralSet(q)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    body = [...oral, ...rest];
  }
  return [...pins, ...body].map((q, i) => ({ ...q, position: i + 1 }));
}

function pickWeighted(pool, competencies, count, randomize, rng) {
  if (count <= 0) return [];
  if (count >= pool.length) return pool;
  const groups = groupByCompetency(pool, competencies);
  const quota = apportion(groups, Math.floor(count));
  const keep = new Set();
  for (const g of groups) {
    const n = quota.get(g.id) ?? 0;
    const selected = randomize ? sample(g.items, n, rng) : g.items.slice(0, n);
    for (const q of selected) keep.add(q.id);
  }
  return pool.filter((q) => keep.has(q.id));
}

export function dedupeQuestions(questions = []) {
  return uniqueBy(questions);
}

export function selectQuestions(questions = [], competencies = [], limit = null, { randomize = false, rng = Math.random, shuffle = true } = {}) {
  const pool = uniqueBy(questions);
  const requested = Number(limit);
  const fullBank = !Number.isFinite(requested) || requested <= 0 || requested >= pool.length;
  const n = fullBank ? pool.length : Math.floor(requested);

  const reserved = [];
  const reservedIds = new Set();
  const take = (q) => {
    if (!q || reservedIds.has(q.id)) return;
    reserved.push(q);
    reservedIds.add(q.id);
  };

  // The spoken customer-advisory set is always capped at RSA_ORAL_IN_CAP. This
  // applies to *every* paper, including the "full bank" case, so a candidate
  // is never asked more than five of the ten spoken prompts. The pinned common
  // opening question is always included and served first.
  for (const q of pool.filter(isPinFirst)) take(q);
  const oralBank = pool.filter(isOralSet);
  const maxOral = Math.min(RSA_ORAL_IN_CAP, n, oralBank.length);
  const oralRest = oralBank.filter((q) => !reservedIds.has(q.id));
  const extra = Math.max(0, maxOral - reserved.filter(isOralSet).length);
  const extraOral = randomize ? sample(oralRest, extra, rng) : oralRest.slice(0, extra);
  for (const q of extraOral) take(q);
  while (reserved.length > n) {
    const idx = [...reserved.keys()].reverse().find((i) => !isPinFirst(reserved[i]));
    if (idx === undefined) break;
    reservedIds.delete(reserved[idx].id);
    reserved.splice(idx, 1);
  }

  // When the bank is bigger a full "bank-wide" paper still serves the remaining
  // non-oral questions; only in a capped-sampling paper do we weight-split the
  // remaining seats across competencies.
  const restSource = pool.filter((q) => !reservedIds.has(q.id) && !isOralSet(q));
  const rest = fullBank
    ? restSource
    : pickWeighted(restSource, competencies, n - reserved.length, randomize, rng);
  return arrange([...reserved, ...rest], { shuffle, rng });
}

/**
 * Human-readable preview of how a cap would be distributed — used by the admin
 * UI so the choice is transparent before the assessment is created.
 */
export function allocationPreview(questions = [], competencies = [], limit = null) {
  const safe = uniqueBy(questions);
  // Counts only — no need to spend randomness arranging a paper that is never served.
  const selected = selectQuestions(safe, competencies, limit, { shuffle: false });
  const byComp = new Map();
  for (const q of selected) byComp.set(q.competency_id, (byComp.get(q.competency_id) || 0) + 1);
  const points = selected.reduce((s, q) => s + Number(q.points ?? 1), 0);
  const spokenTotal = safe.filter((q) => q.question_set === RSA_ORAL_SET).length;
  const spokenServed = selected.filter((q) => q.question_set === RSA_ORAL_SET).length;
  return {
    total: selected.length,
    bank_total: safe.length,
    standard_total: safe.length - spokenTotal,
    spoken_total: spokenTotal,
    spoken_served: spokenServed,
    points,
    per_competency: competencies
      .map((c) => ({ competency_id: c.id, name: c.name, weight: Number(c.weight ?? 0), count: byComp.get(c.id) || 0 }))
      .filter((row) => row.count > 0 || questions.some((q) => q.competency_id === row.competency_id)),
  };
}
