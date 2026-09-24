import { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS, RSA_ORAL_QUESTIONS, RSA_ORAL_SET } from '../content/rsa-catalogue.mjs';
import { AIBI_ROLE, AIBI_COMPETENCIES, AIBI_QUESTIONS } from '../content/ai-bi-genie-catalogue.mjs';
import { SC_ROLE, SC_COMPETENCIES, SC_QUESTIONS } from '../content/senior-consultant-catalogue.mjs';
import { SAMA_ROLE, SAMA_COMPETENCIES, SAMA_QUESTIONS } from '../content/sama-catalogue.mjs';
import { promptKey, stripPromptLabel } from '../core/question-selection.mjs';
import { healSpokenContract, isOpenQuestion, requiresSpokenAnswer } from '../core/spoken-answer.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../core/constants.mjs';
import { bulkInsert, bulkUpdate, bulkRemove } from './helpers.mjs';

/**
 * Published-catalogue service.
 *
 * Every published track (role + competencies + question bank) is registered in
 * PUBLISHED_CATALOGUES, keyed by the role's stable `key`. The RSA catalogue is
 * the historical default: a call without an explicit role key resolves to it,
 * so single-track workspaces and existing clients behave exactly as before.
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
 *
 * A track that is published but not yet *in* the workspace is a different
 * case: a workspace seeded before the track existed has no role for it, so
 * there is nothing to sync and — until installCatalogue() below — no way to
 * get it short of wiping the store. Installing creates the role, its default
 * scoring framework, its competencies and its published questions (which may
 * be none: a track can ship as competencies only, to be authored in-app).
 */

/** Every published catalogue, keyed by role key. */
export const PUBLISHED_CATALOGUES = {
  [RSA_ROLE.key]: { role: RSA_ROLE, competencies: RSA_COMPETENCIES, questions: RSA_QUESTIONS },
  [AIBI_ROLE.key]: { role: AIBI_ROLE, competencies: AIBI_COMPETENCIES, questions: AIBI_QUESTIONS },
  [SC_ROLE.key]: { role: SC_ROLE, competencies: SC_COMPETENCIES, questions: SC_QUESTIONS },
  [SAMA_ROLE.key]: { role: SAMA_ROLE, competencies: SAMA_COMPETENCIES, questions: SAMA_QUESTIONS },
};

/**
 * Is this competency the copy of a published catalogue competency? The sync
 * (synchronizeBank) finds a track's competencies by `key` and creates any it
 * cannot find, so such a competency's key is its link to the catalogue:
 * blanked or renamed, the next sync added a second, empty copy beside it.
 */
export function isCatalogueCompetency(role, competency) {
  const key = role?.key;
  const catalogue = typeof key === 'string' && Object.hasOwn(PUBLISHED_CATALOGUES, key) ? PUBLISHED_CATALOGUES[key] : null;
  return Boolean(catalogue && competency?.key && catalogue.competencies.some((c) => c.key === competency.key));
}


export const DEFAULT_CATALOGUE_ROLE_KEY = RSA_ROLE.key;

/** The published catalogue for a role key, or null (unknown key). */
export function catalogueForRoleKey(roleKey) {
  const key = roleKey === undefined || roleKey === null || roleKey === ''
    ? DEFAULT_CATALOGUE_ROLE_KEY
    : roleKey;
  // Own keys only: a request naming an Object.prototype member as its role
  // key ("constructor", "toString") used to come back as a truthy "catalogue"
  // with no `role`/`questions`, and every consumer then crashed with a 500.
  return typeof key === 'string' && Object.hasOwn(PUBLISHED_CATALOGUES, key) ? PUBLISHED_CATALOGUES[key] : null;
}

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

/** The workspace track that matches a published catalogue, or null. */
async function catalogueRole(store, roleKey) {
  const catalogue = catalogueForRoleKey(roleKey);
  const roles = await store.list('roles');
  return roles.find((r) => r.key === catalogue.role.key && r.active !== false) || null;
}

/**
 * How many published questions the matching track is missing.
 * `bank` is the role's question list (all questions, active or not) — the
 * caller usually has it already, e.g. from roleBank. Prompts are compared
 * typography-insensitively: a bank row that only differs by quote style,
 * dashes or spacing is the same published question, not a missing one.
 */
export function catalogueMissing(bankQuestions = [], roleKey) {
  const catalogue = catalogueForRoleKey(roleKey);
  const prompts = new Set(bankQuestions.map((q) => promptKey(q.prompt)));
  return catalogue.questions.filter((q) => !prompts.has(promptKey(q.prompt))).length;
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
export async function catalogueStatus(store, roleKey) {
  const catalogue = catalogueForRoleKey(roleKey);
  if (!catalogue) return { available: false };
  const role = await catalogueRole(store, roleKey);
  if (!role) {
    // Not installed (or deactivated): say which published track this is and
    // whether it can be added, so the UI can offer the install instead of a
    // bare "unavailable".
    const inactive = (await store.list('roles', { key: catalogue.role.key }))
      .find((r) => r.active === false) || null;
    return {
      available: false,
      catalogue_total: catalogue.questions.length,
      role_key: catalogue.role.key,
      role_name: catalogue.role.name,
      competency_total: catalogue.competencies.length,
      installable: !inactive,
      inactive_role: inactive ? { id: inactive.id, key: inactive.key, name: inactive.name } : null,
    };
  }
  const questions = await store.list('questions', { role_id: role.id });
  return {
    available: true,
    role: { id: role.id, key: role.key, name: role.name },
    catalogue_total: catalogue.questions.length,
    bank_total: questions.filter((q) => q.active !== false).length,
    missing: catalogueMissing(questions, roleKey),
  };
}

const publicRole = (r) => ({ id: r.id, key: r.key, name: r.name, active: r.active !== false });

/**
 * Every published track and where this workspace stands with it — the Roles &
 * frameworks screen lists these so a track that shipped after the workspace
 * was seeded can be added from the UI. One row per catalogue:
 *   installed  — an active role with the catalogue's key exists
 *   inactive   — the role exists but was deactivated (never re-created)
 *   missing    — published questions the installed bank does not hold yet
 *                (the whole catalogue when the track is not installed)
 */
export async function listCatalogues(store) {
  const [roles, questions] = await Promise.all([store.list('roles'), store.list('questions')]);
  return Object.values(PUBLISHED_CATALOGUES).map((catalogue) => {
    const twins = roles.filter((r) => r.key === catalogue.role.key);
    const role = twins.find((r) => r.active !== false) || twins[0] || null;
    const bank = role ? questions.filter((q) => q.role_id === role.id) : [];
    return {
      role_key: catalogue.role.key,
      role_name: catalogue.role.name,
      technology: catalogue.role.technology || '',
      description: catalogue.role.description || '',
      competency_total: catalogue.competencies.length,
      catalogue_total: catalogue.questions.length,
      // A track published as competencies only: its bank is authored in-app.
      authoring_only: catalogue.questions.length === 0,
      installed: Boolean(role),
      active: role ? role.active !== false : false,
      role: role ? publicRole(role) : null,
      bank_total: bank.filter((q) => q.active !== false).length,
      missing: role ? catalogueMissing(bank, catalogue.role.key) : catalogue.questions.length,
    };
  });
}

/**
 * Install a published track into the workspace, or bring an installed one up
 * to date. Idempotent:
 *  - no role with the catalogue's key → the role is created (from the
 *    catalogue's role record), with the default scoring framework, every
 *    competency and every published question — the same shape a fresh seed
 *    produces, so `npm run seed` and the admin UI provision tracks identically;
 *  - an active role already exists → plain synchronizeBank (top-up + repair);
 *  - the role exists but is deactivated → refused with { code: 'inactive' }:
 *    an admin who switched a track off must reactivate it deliberately, and a
 *    second role with the same key would break every key-based lookup.
 * Returns synchronizeBank's counters plus { created, role }.
 */
export async function installCatalogue(store, roleKey) {
  const catalogue = catalogueForRoleKey(roleKey);
  if (!catalogue) return { error: `No published catalogue for role key "${roleKey}".` };
  const twins = await store.list('roles', { key: catalogue.role.key });
  const active = twins.find((r) => r.active !== false);
  if (active) {
    const result = await synchronizeBank(store, active);
    if (result.error) return result;
    await ensureFramework(store, active.id);
    return { ...result, created: false, role: publicRole(active) };
  }
  if (twins.length) {
    return {
      error: `The ${catalogue.role.name} track is already in this workspace but deactivated. Reactivate it under Roles & frameworks instead of adding a second copy.`,
      code: 'inactive',
      role: publicRole(twins[0]),
    };
  }
  const role = await store.insert('roles', { ...catalogue.role, active: true });
  let result;
  try {
    result = await synchronizeBank(store, role);
    if (result.error) return result;
    await ensureFramework(store, role.id);
  } catch (err) {
    // The role row went in first so the bank rows could reference it. If the
    // bank or framework write then dies (a blob-store timeout mid-install),
    // an orphan role — no framework, an incomplete bank — would sit under
    // Roles & frameworks looking installed, and every allocation against it
    // would fail. Undo the whole install so the admin's retry starts clean;
    // the rows synchronizeBank already wrote are keyed by role_id and go too.
    await uninstallRole(store, role.id).catch(() => {});
    throw err;
  }
  return { ...result, created: true, role: publicRole(role) };
}

/**
 * Every track scores against a framework; a role without one cannot be
 * allocated (buildSnapshot refuses). Same default POST /admin/roles uses.
 * Idempotent, so a legacy orphan (a role whose install died before its
 * framework was written) heals on the next sync rather than staying stuck.
 */
async function ensureFramework(store, roleId) {
  if ((await store.list('frameworks', { role_id: roleId })).length) return;
  await store.insert('frameworks', {
    role_id: roleId, name: 'ECOD Readiness Framework v1', config: DEFAULT_FRAMEWORK_CONFIG, active: true,
  });
}

/** Compensating delete for a failed install: the role and everything keyed to it. */
async function uninstallRole(store, roleId) {
  for (const table of ['questions', 'competencies', 'frameworks']) {
    await bulkRemove(store, table, (await store.list(table, { role_id: roleId })).map((row) => row.id));
  }
  await store.remove('roles', roleId);
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
 * Synchronize a track's bank with its published catalogue: create missing
 * competencies, add genuinely missing questions and repair the oral/spoken
 * contract flags on existing copies. Shared by the in-app admin action and
 * `scripts/seed.mjs` so both paths heal legacy banks identically. The
 * catalogue is chosen by the role's stable `key`.
 * Returns { added, repaired, competencies_added, bank_total, role_id }.
 */
export async function synchronizeBank(store, role) {
  // Strict own-key lookup — unlike catalogueForRoleKey, a role row with a
  // blank key must NOT fall back to the default track and receive its bank.
  const key = role?.key;
  const catalogue = typeof key === 'string' && Object.hasOwn(PUBLISHED_CATALOGUES, key) ? PUBLISHED_CATALOGUES[key] : null;
  if (!catalogue) {
    return { error: `No published catalogue matches role key "${key ?? ''}".` };
  }
  const existingCompetencies = await store.list('competencies', { role_id: role.id });
  const compIds = Object.fromEntries(existingCompetencies.map((c) => [c.key, c.id]));

  // Heal a catalogue competency whose key was blanked. The API used to accept
  // a blank key, and a sync then added a second, empty copy (weights summing
  // past 100, an extra "not assessed" row on every report). A competency with
  // no key and the catalogue competency's name gets its key back instead.
  const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const adopted = [];
  for (const c of catalogue.competencies) {
    if (compIds[c.key]) continue;
    const orphan = existingCompetencies.find((x) => !String(x.key ?? '').trim() && sameName(x.name, c.name)
      && !adopted.some((a) => a.id === x.id));
    if (!orphan) continue;
    adopted.push({ id: orphan.id, patch: { key: c.key } });
    compIds[c.key] = orphan.id;
  }
  if (adopted.length) await bulkUpdate(store, 'competencies', adopted);

  // Competencies the published questions rely on must exist before inserting.
  // Batch: only the ones actually missing.
  const missingComps = catalogue.competencies.filter((c) => !compIds[c.key]);
  if (missingComps.length) {
    const recs = await bulkInsert(store, 'competencies',
      missingComps.map((c) => ({ ...c, role_id: role.id, active: true })));
    recs.forEach((rec) => { compIds[rec.key] = rec.id; });
  }
  const competenciesAdded = missingComps.length;
  const competenciesRepaired = adopted.length;

  const existingQuestions = await store.list('questions', { role_id: role.id });
  const byPrompt = new Map();
  for (const q of existingQuestions) {
    const key = promptKey(q.prompt);
    if (key && !byPrompt.has(key)) byPrompt.set(key, q);
  }
  const toAdd = [];
  const toRepair = [];
  let repaired = 0;
  for (const q of catalogue.questions) {
    const twin = byPrompt.get(promptKey(q.prompt));
    if (twin) {
      // Same published question is already in the bank: repair its spoken-
      // question metadata instead of inserting a second copy (which would
      // leave the exam serving the same prompt twice, once without its
      // microphone control).
      const patch = repairPatch(twin, q);
      if (patch) toRepair.push({ id: twin.id, patch });
      continue;
    }
    if (!compIds[q.competency]) continue;
    toAdd.push(questionRecord(q, role.id, compIds));
  }
  // Collected then flushed: a bank-wide repair is one write, not one per row.
  if (toRepair.length) repaired = (await bulkUpdate(store, 'questions', toRepair)).filter(Boolean).length;
  if (toAdd.length) await bulkInsert(store, 'questions', toAdd);
  const added = toAdd.length;

  const bankTotal = (await store.list('questions', { role_id: role.id }))
    .filter((q) => q.active !== false).length;
  return {
    added, repaired, competencies_added: competenciesAdded, competencies_repaired: competenciesRepaired,
    bank_total: bankTotal, role_id: role.id,
  };
}

/**
 * Add the published questions the matching track is missing (plus any
 * competencies they need, repairing existing copies' spoken-question flags).
 * Returns { added, repaired, competencies_added, bank_total }.
 * No-op when the workspace already has the full catalogue.
 */
export async function syncCatalogue(store, roleKey) {
  const catalogue = catalogueForRoleKey(roleKey);
  if (!catalogue) return { error: `No published catalogue for role key "${roleKey}".` };
  const role = await catalogueRole(store, roleKey);
  if (!role) return { error: `No active track matches the published catalogue (${catalogue.role.name}).` };
  return synchronizeBank(store, role);
}
