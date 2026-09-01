import { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS, RSA_ORAL_QUESTIONS, RSA_ORAL_SET } from '../content/rsa-catalogue.mjs';
import { promptKey, stripPromptLabel } from '../core/question-selection.mjs';
import { healSpokenContract, isOpenQuestion, requiresSpokenAnswer } from '../core/spoken-answer.mjs';
import { bulkInsert } from './helpers.mjs';

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
 *  - only questions the bank does not already hold are added — matched by
 *    prompt, typography-insensitively, so a restyled copy of a published
 *    question is recognized instead of duplicated next to it;
 *  - an existing row that *is* the published question (same prompt modulo
 *    typography) is repaired in place: the spoken-question contract flags
 *    (`question_set`, `pin_first`, `audio_required`) are restored and an empty
 *    `help_text`/`rubric` is filled from the catalogue. This heals banks whose
 *    rows predate the flags or lost them to an older admin edit — the cause of
 *    spoken questions appearing without the microphone control;
 *  - an open question always carries the microphone requirement, because
 *    `audio_required` is a rule of the question *type* (see
 *    core/spoken-answer.mjs) and not a per-question preference;
 *  - deactivated rows stay deactivated (an admin who unpublished a question is
 *    never overridden) and no other admin customization is touched;
 *  - competencies the published questions rely on are created if missing;
 *  - users and assessment snapshots are never touched.
 */

const questionRecord = (q, roleId, compIds) => ({
  role_id: roleId, competency_id: compIds[q.competency],
  type: q.type, prompt: q.prompt, help_text: q.help_text || '',
  options: q.options || [], correct_option_ids: q.correct_option_ids || [],
  points: q.points, difficulty: q.difficulty, rubric: q.rubric || '',
  order: q.order, active: true,
  question_set: q.question_set || '',
  pin_first: q.pin_first === true,
  // Stored, not just served: an open question is a recorded-answer question.
  audio_required: requiresSpokenAnswer(q),
});

/** The workspace track that matches the published catalogue, or null. */
async function catalogueRole(store) {
  const roles = await store.list('roles');
  return roles.find((r) => r.key === RSA_ROLE.key && r.active !== false) || null;
}

/**
 * How many published questions the matching track is missing.
 * `bank` is the role's question list (all questions, active or not) — the
 * caller usually has it already, e.g. from roleBank. Prompts are compared
 * typography-insensitively: a bank row that only differs by quote style,
 * dashes or spacing is the same published question, not a missing one.
 */
export function catalogueMissing(bankQuestions = []) {
  const prompts = new Set(bankQuestions.map((q) => promptKey(q.prompt)));
  return RSA_QUESTIONS.filter((q) => !prompts.has(promptKey(q.prompt))).length;
}

/** Published spoken-question contract keyed by normalized prompt. */
const ORAL_CONTRACT = new Map(RSA_ORAL_QUESTIONS.map((q) => [promptKey(q.prompt), q]));

/**
 * Serve-time guarantee for the spoken-answer contract:
 *
 *  - any question whose prompt is one of the published oral prompts demands a
 *    recorded audio answer, is pinned when the catalogue pins it, belongs to
 *    the oral set, and is shown in the published wording (a retired leading
 *    label such as "COMMON QUESTION —" is dropped) — even when the stored or
 *    frozen row lost those flags or still carries the old label (a legacy store
 *    seeded before the flags existed, an older admin edit, or an assessment
 *    snapshot frozen while the bank was in that state);
 *  - *every* open question demands the recorded answer, oral set or not, so a
 *    bank that predates the microphone requirement still shows the control and
 *    the candidate can never be served a silent open question (see
 *    core/spoken-answer.mjs).
 *
 * Copy-on-write: input rows are never mutated; only additive — flags are
 * only ever restored, never removed, and the prompt is only rewritten when it
 * is exactly the published prompt plus a leading label (an unpublished/
 * admin-authored question, or an admin-reworded variant, is left as typed).
 */
export function applySpokenContract(questions = []) {
  const oralHealed = questions.map((q) => {
    if (!q) return q;
    const published = ORAL_CONTRACT.get(promptKey(q.prompt));
    if (!published) return q;
    const publishedPrompt = String(published.prompt || '').trim();
    const healPrompt = Boolean(publishedPrompt)
      && q.prompt !== publishedPrompt
      && stripPromptLabel(q.prompt) === publishedPrompt;
    const needs = (q.question_set !== RSA_ORAL_SET)
      || q.pin_first !== (published.pin_first === true)
      || q.audio_required !== true
      || healPrompt;
    if (!needs) return q;
    const out = {
      ...q,
      question_set: RSA_ORAL_SET,
      pin_first: published.pin_first === true || q.pin_first === true,
      audio_required: true,
    };
    if (healPrompt) out.prompt = publishedPrompt;
    return out;
  });
  // Then the type rule: any open row still missing the flag gets it back.
  return healSpokenContract(oralHealed);
}

/** Kept as an alias: the contract used to cover only the published oral set. */
export const applyOralContract = applySpokenContract;

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
 * Restore the published spoken-question contract on a bank row that *is* this
 * published question (matched by normalized prompt). Only the behavioral flags
 * are set, `help_text`/`rubric` are only filled when empty, and a prompt whose
 * only difference from the published wording is a leading label (e.g. the
 * retired "COMMON QUESTION —" tag) is de-labeled — an admin's own rewording,
 * points, order and (in)activity are never overridden. Returns the patch to
 * apply, or null when the row already matches the contract.
 */
function repairPatch(row, published) {
  const patch = {};
  const wantSet = published.question_set || '';
  const wantPin = published.pin_first === true;
  // An open row must demand the recording even if the published copy predates it.
  const wantAudio = published.audio_required === true || isOpenQuestion(row) || isOpenQuestion(published);
  if (row.question_set !== wantSet) patch.question_set = wantSet;
  if (row.pin_first !== wantPin) patch.pin_first = wantPin;
  if (row.audio_required !== wantAudio) patch.audio_required = wantAudio;
  if (published.help_text && !row.help_text) patch.help_text = published.help_text;
  if (published.rubric && !row.rubric) patch.rubric = published.rubric;
  const publishedPrompt = String(published.prompt || '').trim();
  if (publishedPrompt && row.prompt !== publishedPrompt && stripPromptLabel(row.prompt) === publishedPrompt) {
    patch.prompt = publishedPrompt;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Synchronize a track's bank with the published catalogue: create missing
 * competencies, add genuinely missing questions and repair the oral/spoken
 * contract flags on existing copies. Shared by the in-app admin action and
 * `scripts/seed.mjs` so both paths heal legacy banks identically.
 * Returns { added, repaired, competencies_added, bank_total, role_id }.
 */
export async function synchronizeBank(store, role) {
  const existingCompetencies = await store.list('competencies', { role_id: role.id });
  const compIds = Object.fromEntries(existingCompetencies.map((c) => [c.key, c.id]));

  // Competencies the published questions rely on must exist before inserting.
  // Batch: only the ones actually missing.
  const missingComps = RSA_COMPETENCIES.filter((c) => !compIds[c.key]);
  if (missingComps.length) {
    const recs = await bulkInsert(store, 'competencies',
      missingComps.map((c) => ({ ...c, role_id: role.id, active: true })));
    recs.forEach((rec) => { compIds[rec.key] = rec.id; });
  }
  const competenciesAdded = missingComps.length;

  const existingQuestions = await store.list('questions', { role_id: role.id });
  const byPrompt = new Map();
  for (const q of existingQuestions) {
    const key = promptKey(q.prompt);
    if (key && !byPrompt.has(key)) byPrompt.set(key, q);
  }
  let repaired = 0;
  const toAdd = [];
  for (const q of RSA_QUESTIONS) {
    const twin = byPrompt.get(promptKey(q.prompt));
    if (twin) {
      // Same published question is already in the bank: repair its spoken-
      // question metadata instead of inserting a second copy (which would
      // leave the exam serving the same prompt twice, once without its
      // microphone control).
      const patch = repairPatch(twin, q);
      if (patch) {
        await store.update('questions', twin.id, patch);
        repaired += 1;
      }
      continue;
    }
    if (!compIds[q.competency]) continue;
    toAdd.push(questionRecord(q, role.id, compIds));
  }
  if (toAdd.length) await bulkInsert(store, 'questions', toAdd);
  const added = toAdd.length;

  const bankTotal = (await store.list('questions', { role_id: role.id }))
    .filter((q) => q.active !== false).length;
  return { added, repaired, competencies_added: competenciesAdded, bank_total: bankTotal, role_id: role.id };
}

/**
 * Add the published questions the matching track is missing (plus any
 * competencies they need, repairing existing copies' spoken-question flags).
 * Returns { added, repaired, competencies_added, bank_total }.
 * No-op when the workspace already has the full catalogue.
 */
export async function syncCatalogue(store) {
  const role = await catalogueRole(store);
  if (!role) return { error: `No active track matches the published catalogue (${RSA_ROLE.name}).` };
  return synchronizeBank(store, role);
}
