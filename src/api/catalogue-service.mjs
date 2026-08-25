import { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS } from '../content/rsa-catalogue.mjs';

/**
 * Published-catalogue service.
 *
 * An assessment may be capped at up to MAX_ASSESSMENT_QUESTIONS questions, but
 * the effective ceiling is always the size of the track's active question bank.
 * A workspace that was seeded before the catalogue was expanded (or created on
 * a deployment with no CLI access) can therefore be stuck below the cap — an
 * RSA bank of 21 questions can never serve a 50-question assessment.
 *
 * These helpers let admins close that gap from inside the app: they report how
 * many published questions a matching track is missing and add exactly those,
 * mirroring the sync semantics of scripts/seed.mjs:
 *  - the track is matched by its stable `key` (never by name);
 *  - only questions whose prompt is not already in the bank are added —
 *    including inactive ones, so an admin who deactivated a published question
 *    is never overridden;
 *  - competencies the published questions rely on are created if missing;
 *  - existing records, users and assessment snapshots are never touched.
 */

const questionRecord = (q, roleId, compIds) => ({
  role_id: roleId, competency_id: compIds[q.competency],
  type: q.type, prompt: q.prompt, help_text: q.help_text || '',
  options: q.options || [], correct_option_ids: q.correct_option_ids || [],
  points: q.points, difficulty: q.difficulty, rubric: q.rubric || '',
  order: q.order, active: true,
});

/** The workspace track that matches the published catalogue, or null. */
async function catalogueRole(store) {
  const roles = await store.list('roles');
  return roles.find((r) => r.key === RSA_ROLE.key && r.active !== false) || null;
}

/**
 * How many published questions the matching track is missing.
 * `bank` is the role's question list (all questions, active or not) — the
 * caller usually has it already, e.g. from roleBank.
 */
export function catalogueMissing(bankQuestions = []) {
  const prompts = new Set(bankQuestions.map((q) => q.prompt));
  return RSA_QUESTIONS.filter((q) => !prompts.has(q.prompt)).length;
}

/** Status payload for the admin UI: what a sync would (and would not) do. */
export async function catalogueStatus(store) {
  const role = await catalogueRole(store);
  if (!role) return { available: false, catalogue_total: RSA_QUESTIONS.length };
  const questions = await store.list('questions', { role_id: role.id });
  return {
    available: true,
    role: { id: role.id, key: role.key, name: role.name },
    catalogue_total: RSA_QUESTIONS.length,
    bank_total: questions.filter((q) => q.active !== false).length,
    missing: catalogueMissing(questions),
  };
}

/**
 * Add the published questions the matching track is missing (plus any
 * competencies they need). Returns { added, competencies_added, bank_total }.
 * No-op when the workspace already has the full catalogue.
 */
export async function syncCatalogue(store) {
  const role = await catalogueRole(store);
  if (!role) return { error: `No active track matches the published catalogue (${RSA_ROLE.name}).` };

  const existingCompetencies = await store.list('competencies', { role_id: role.id });
  const compIds = Object.fromEntries(existingCompetencies.map((c) => [c.key, c.id]));

  // Competencies the published questions rely on must exist before inserting.
  let competenciesAdded = 0;
  for (const c of RSA_COMPETENCIES) {
    if (compIds[c.key]) continue;
    const rec = await store.insert('competencies', { ...c, role_id: role.id, active: true });
    compIds[c.key] = rec.id;
    competenciesAdded += 1;
  }

  const existingQuestions = await store.list('questions', { role_id: role.id });
  const prompts = new Set(existingQuestions.map((q) => q.prompt));
  let added = 0;
  for (const q of RSA_QUESTIONS) {
    if (prompts.has(q.prompt) || !compIds[q.competency]) continue;
    await store.insert('questions', questionRecord(q, role.id, compIds));
    prompts.add(q.prompt);
    added += 1;
  }

  const bankTotal = (await store.list('questions', { role_id: role.id }))
    .filter((q) => q.active !== false).length;
  return { added, competencies_added: competenciesAdded, bank_total: bankTotal, role_id: role.id };
}
