/**
 * The effective question bank = published content + admin-authored additions.
 *
 * Published module banks live in src/content (generated from the source
 * workbooks, keyed by role key in src/content/module-banks.mjs) and are never
 * written to at runtime. Questions an admin adds (singly or by importing a
 * spreadsheet) are stored in the `bank_questions` table, scoped by the
 * `role_key` of the bank they belong to, and merged over the published set
 * here, so:
 *
 *   - regenerating a published bank never destroys admin work;
 *   - one function answers "what is in the bank?" for the module tree, the
 *     family drill-down, the plan, the preview and generation alike — they
 *     cannot disagree about what exists;
 *   - a stored question is shaped exactly like a published one, so nothing
 *     downstream needs to know where a question came from;
 *   - rows without a `role_key` (authored before banks were role-scoped)
 *     belong to the historical default bank, RSA.
 *
 * Every function takes an optional `roleKey`; omitting it means the default
 * (RSA), which keeps single-track workspaces behaving exactly as before.
 */

import {
  moduleBankFor, publishedModuleBanks, authoredIdPrefix, DEFAULT_MODULE_BANK_ROLE_KEY,
} from '../content/module-banks.mjs';
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
    // Authored rows carry the version of the published bank they were added
    // against, so the tree never shows a mixture of version labels.
    version: moduleBankFor(row.role_key || DEFAULT_MODULE_BANK_ROLE_KEY)?.version || '',
    randomizable: row.randomizable !== false,
    prompt: row.prompt,
    tags: Array.isArray(row.tags) ? row.tags : [],
    gap_tag: row.gap_tag || '',
    red_flags: row.red_flags || '',
    enrichment: row.enrichment || '',
    authored: true,
    role_key: row.role_key || DEFAULT_MODULE_BANK_ROLE_KEY,
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

/** Every authored question for one bank, hydrated. */
export async function authoredQuestions(store, roleKey) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  const rows = await store.list('bank_questions');
  // Legacy rows (pre role-scoping) belong to the default bank only.
  const scoped = rows.filter((r) => (r.role_key || DEFAULT_MODULE_BANK_ROLE_KEY) === key);
  return scoped.map(hydrate);
}

/**
 * Visibility overrides for published questions, as a set of removed ids.
 * Stored as rows ({ question_id, active: false }) rather than keyed by record
 * id so every adapter — including Airtable, which mints its own record ids —
 * can hold them. Scoped by role_key the same way authored rows are.
 */
export async function removedPublishedIds(store, roleKey) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  const rows = await store.list('bank_question_overrides');
  return new Set(
    rows.filter((r) => r.active === false && r.question_id
      && (r.role_key || DEFAULT_MODULE_BANK_ROLE_KEY) === key).map((r) => r.question_id),
  );
}

/**
 * The full effective bank for one role: published questions (minus
 * admin-removed ones) plus authored ones.
 * Ordered by module (configured order), then by family, then published before
 * authored — so an addition appears at the end of the family it joined rather
 * than scattered through the list.
 *
 * A removed published question stays in the list as inactive (`removed: true`)
 * rather than vanishing, so the tree reports it under `inactive`, the family
 * drill-down can offer a Restore, and generation (which only draws active
 * questions) skips it.
 */
export async function effectiveBank(store, roleKey) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  const bank = moduleBankFor(key);
  if (!bank) throw new Error(`No published module bank for role key "${key}".`);
  const [authored, removed] = await Promise.all([authoredQuestions(store, key), removedPublishedIds(store, key)]);
  const published = removed.size
    ? bank.questions.map((q) => (removed.has(q.id) ? { ...q, active: false, status: 'Inactive', removed: true } : q))
    : bank.questions;
  const order = new Map(bank.modules.map((m, i) => [m.key, i]));
  const all = [...published, ...authored];
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
export function composeModules(questions, roleKey) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  const bank = moduleBankFor(key);
  if (!bank) throw new Error(`No published module bank for role key "${key}".`);
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

  return bank.modules.map((m) => {
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
export function composeFamilies(questions, roleKey) {
  return composeModules(questions, roleKey).flatMap((m) =>
    m.families.map((f) => ({ ...f, module: m.key, group: m.group })));
}

/**
 * Resolve a family id against the effective bank. Accepts a published family,
 * an authored one, or a `<MODULE>:<slug>` that does not exist yet (so the
 * "add a question here" form can target a family before it has members).
 */
export function resolveFamily(familyId, questions, roleKey) {
  const id = String(familyId || '');
  const found = composeFamilies(questions, roleKey).find((f) => f.id === id);
  if (found) return found;
  const bank = moduleBankFor(roleKey || DEFAULT_MODULE_BANK_ROLE_KEY);
  const published = bank?.families.find((f) => f.id === id);
  if (published) return { ...published, objective: 0, open: 0, authored: 0, inactive: 0 };
  return null;
}

/** Next id for an authored question in a module: e.g. RSA-T01-A001 / AIBI-G01-A001. */
export function nextAuthoredId(moduleKey, existing = [], roleKey) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  const prefix = `${authoredIdPrefix(key)}-${moduleKey}-A`;
  let max = 0;
  for (const q of existing) {
    const id = String(q.id || '');
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    if (/^\d+$/.test(tail)) max = Math.max(max, Number(tail));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/** Build the stored record for a validated question. */
export function toStoredRecord(question, { id, actorId, roleKey }) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  return {
    id,
    role_key: key,
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

export { slug, publishedModuleBanks, moduleBankFor, DEFAULT_MODULE_BANK_ROLE_KEY };
