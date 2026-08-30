/**
 * The effective question bank = published content + admin-authored additions.
 *
 * src/content/rsa-question-bank.mjs is generated from the source PDF and is
 * never written to at runtime. Questions an admin adds (singly or by importing
 * a spreadsheet) are stored in the `bank_questions` table and merged over the
 * published set here, so:
 *
 *   - regenerating the published bank never destroys admin work;
 *   - one function answers "what is in the bank?" for the module tree, the
 *     family drill-down, the plan, the preview and generation alike — they
 *     cannot disagree about what exists;
 *   - a stored question is shaped exactly like a published one, so nothing
 *     downstream needs to know where a question came from.
 */

import { MODULES, QUESTIONS, FAMILIES } from '../content/rsa-question-bank.mjs';
import { slug } from '../core/question-intake.mjs';
import { isActive } from '../core/test-generation.mjs';

/** A stored row -> the shape the generator and the UI expect. */
export function hydrate(row) {
  const type = row.type === 'objective' ? 'objective' : 'open';
  return {
    id: row.id,
    module: row.module,
    family_id: row.family_id,
    family: row.family,
    type,
    source_type: 'Admin authored',
    difficulty: Number(row.difficulty ?? 4),
    band: row.band || 'Intermediate',
    mode: row.mode || 'Online assessment',
    minutes: Number(row.minutes ?? (type === 'open' ? 5 : 2)),
    status: row.active === false ? 'Inactive' : 'Active',
    active: row.active !== false,
    version: '1.2',
    randomizable: row.randomizable !== false,
    prompt: row.prompt,
    tags: Array.isArray(row.tags) ? row.tags : [],
    gap_tag: row.gap_tag || '',
    red_flags: row.red_flags || '',
    enrichment: row.enrichment || '',
    authored: true,
    created_at: row.created_at,
    ...(type === 'objective'
      ? {
          options: Array.isArray(row.options) ? row.options : [],
          correct_option_ids: Array.isArray(row.correct_option_ids) ? row.correct_option_ids : [],
          rationale: row.rationale || '',
          needs_option_review: row.needs_option_review === true,
        }
      : {
          probes: Array.isArray(row.probes) ? row.probes : [],
          rubric: row.rubric || '',
        }),
  };
}

/** Every authored question, hydrated. */
export async function authoredQuestions(store) {
  const rows = await store.list('bank_questions');
  return rows.map(hydrate);
}

/**
 * The full effective bank: published questions plus authored ones.
 * Ordered by module (configured order), then by family, then published before
 * authored — so an addition appears at the end of the family it joined rather
 * than scattered through the list.
 */
export async function effectiveBank(store) {
  const authored = await authoredQuestions(store);
  const order = new Map(MODULES.map((m, i) => [m.key, i]));
  const all = [...QUESTIONS, ...authored];
  all.sort((a, b) => (order.get(a.module) ?? 99) - (order.get(b.module) ?? 99)
    || String(a.family_id).localeCompare(String(b.family_id))
    || (a.authored === b.authored ? 0 : a.authored ? 1 : -1)
    || String(a.id).localeCompare(String(b.id)));
  return all;
}

/**
 * Modules with their families, counts folded in from the effective bank.
 *
 * Authored questions may introduce a family the published bank does not have;
 * those are appended to their module and flagged `authored: true` so the UI
 * can show where new content landed. Counts are always derived from the
 * questions themselves, never carried over from the published metadata, so a
 * family row can never disagree with its own drill-down.
 */
export function composeModules(questions) {
  const byFamily = new Map();
  for (const q of questions) {
    const row = byFamily.get(q.family_id)
      || { objective: 0, open: 0, authored: 0, inactive: 0 };
    // Count only what generation can actually draw. A deactivated question is
    // reported separately rather than inflating the family's usable total —
    // otherwise the tree claims a quota the plan knows cannot be filled.
    if (isActive(q)) {
      if (q.type === 'objective') row.objective += 1; else row.open += 1;
      if (q.authored) row.authored += 1;
    } else {
      row.inactive += 1;
    }
    byFamily.set(q.family_id, row);
  }

  return MODULES.map((m) => {
    const published = m.families.map((f) => ({
      ...f,
      ...(byFamily.get(f.id) || { objective: 0, open: 0, authored: 0, inactive: 0 }),
    }));
    const known = new Set(m.families.map((f) => f.id));
    const extra = [...byFamily.keys()]
      .filter((id) => !known.has(id) && id.startsWith(`${m.key}:`))
      .sort()
      .map((id) => {
        const counts = byFamily.get(id);
        const sample = questions.find((q) => q.family_id === id);
        return {
          id,
          key: id.slice(m.key.length + 1),
          name: sample?.family || id,
          role: counts.objective && counts.open ? 'mixed' : counts.objective ? 'objective' : 'open',
          authored_family: true,
          ...counts,
        };
      });

    const families = [...published, ...extra];
    return {
      ...m,
      families,
      objective: families.reduce((n, f) => n + f.objective, 0),
      open: families.reduce((n, f) => n + f.open, 0),
      authored: families.reduce((n, f) => n + (f.authored || 0), 0),
      inactive: families.reduce((n, f) => n + (f.inactive || 0), 0),
    };
  });
}

/** Every family in the effective bank, flattened (published + authored). */
export function composeFamilies(questions) {
  return composeModules(questions).flatMap((m) =>
    m.families.map((f) => ({ ...f, module: m.key, group: m.group })));
}

/**
 * Resolve a family id against the effective bank. Accepts a published family,
 * an authored one, or a `<MODULE>:<slug>` that does not exist yet (so the
 * "add a question here" form can target a family before it has members).
 */
export function resolveFamily(familyId, questions) {
  const id = String(familyId || '');
  const found = composeFamilies(questions).find((f) => f.id === id);
  if (found) return found;
  const published = FAMILIES.find((f) => f.id === id);
  if (published) return { ...published, objective: 0, open: 0, authored: 0, inactive: 0 };
  return null;
}

/** Next id for an authored question in a module: RSA-T01-A001, -A002, ... */
export function nextAuthoredId(moduleKey, existing = []) {
  const prefix = `RSA-${moduleKey}-A`;
  let max = 0;
  for (const q of existing) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(q.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/** Build the stored record for a validated question. */
export function toStoredRecord(question, { id, actorId }) {
  return {
    id,
    module: question.module,
    family_id: question.family_id,
    family: question.family,
    type: question.type,
    prompt: question.prompt,
    difficulty: question.difficulty,
    band: question.band,
    mode: question.mode,
    minutes: question.minutes,
    tags: question.tags || [],
    gap_tag: question.gap_tag || '',
    red_flags: question.red_flags || '',
    enrichment: question.enrichment || '',
    active: true,
    randomizable: true,
    created_by: actorId || null,
    ...(question.type === 'objective'
      ? {
          options: question.options,
          correct_option_ids: question.correct_option_ids,
          rationale: question.rationale || '',
          needs_option_review: question.needs_option_review === true,
        }
      : {
          probes: question.probes || [],
          rubric: question.rubric || '',
        }),
  };
}

export { slug };
