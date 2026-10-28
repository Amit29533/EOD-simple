/**
 * Shared by the admin route modules in this folder: the imports they use and
 * the validation/normalisation helpers that more than one area needs.
 */
import { purgePreview, purgePerson, deleteUnfinalizedCandidate } from '../../person-purge.mjs';
import { listBookings } from '../bookings.mjs';
import { newToken } from '../../../core/ids.mjs';
import { expireExam } from '../../exam-expiry.mjs';
import { creationRequest, sameCreation, creationId } from '../../creation-request.mjs';
import { issueRecoveryLink } from '../../recovery-service.mjs';
import { hashPasswordAsync, hashPasswordsAsync, verifyPasswordAsync } from '../../../core/passwords.mjs';
import {
  ok, created, bad, notFound, conflict, forbidden, unprocessable, audit,
  str, num, bool, missing, bulkInsert, bulkUpdate, bulkRemove, isTextish, textField,
} from '../../helpers.mjs';
import { publicUser } from '../../projections.mjs';
import { withLock } from '../../mutex.mjs';
import {
  USER_ROLES, STAGE_KEYS, QUESTION_TYPE_KEYS, DIFFICULTIES, DEFAULT_FRAMEWORK_CONFIG,
  PIPELINE_STAGES, MAX_ASSESSMENT_QUESTIONS, MAX_SPREADSHEET_BYTES,
} from '../../../core/constants.mjs';
import { validateFrameworkConfig } from '../../../core/scoring.mjs';
import { requiresSpokenAnswer } from '../../../core/spoken-answer.mjs';
import { defaultQuestionCountForRole } from '../../../core/allocation-policy.mjs';
import {
  buildSnapshot, roleBank, automaticSnapshotFromBank, advanceStage, autoAllocateAssessment, planBulkAutoAllocation, paperSummary, paperFacts,
  allocationLockKey, resolveAssessorId,
} from '../../assessment-service.mjs';
import { allocationPreview } from '../../../core/question-selection.mjs';
import { hasStrictModuleAllocation } from '../../../core/module-allocation-policy.mjs';
import {
  catalogueStatus, catalogueMissing, syncCatalogue, catalogueForRoleKey,
  listCatalogues, installCatalogue, isCatalogueCompetency,
} from '../../catalogue-service.mjs';
import {
  moduleBankFor, DEFAULT_MODULE_BANK_ROLE_KEY,
} from '../../../content/module-banks.mjs';
import {
  readRetentionSettings, saveRetentionSettings, runRetentionSweep, retentionStatus,
  sweepInBackground, paperRetention,
} from '../../retention-service.mjs';
import { DEFAULT_RETENTION } from '../../../core/retention.mjs';
import {
  generateTest, testPlan, blueprintFor, isActive,
} from '../../../core/test-generation.mjs';
import {
  validateQuestion as validateBankQuestion, validateBatch, promptKey,
} from '../../../core/question-intake.mjs';
import { parseSheet } from '../../../core/sheet-parser.mjs';
import {
  CANDIDATE_IMPORT_COLUMNS, candidateImportTemplateCsv, validateCandidateBatch, emailShapeProblem,
} from '../../../core/candidate-import.mjs';
import {
  effectiveBank, composeModules, composeFamilies, resolveFamily,
  nextAuthoredId, toStoredRecord, hydrate,
} from '../../bank-service.mjs';

/** Upper bound on one spreadsheet import, to bound request time and memory. */
export const MAX_IMPORT_ROWS = 2000;
/**
 * Rows a single commit request may write. A commit costs ~22 ms per portal
 * user before any network (a scrypt hash each, two at a time so the
 * threadpool stays available), so the 2000-row file the dry run happily
 * validates would run ~45 s as one request — past a serverless function's
 * 10 s (26 s at most) and past most proxies' patience — and be killed with
 * the candidates written and the users not. The client commits in pages
 * (`offset` + `limit`); a larger single request is refused up front.
 */
export const MAX_IMPORT_COMMIT_ROWS = 200;

/**
 * Candidate field lengths, shared by the create form and PATCH so an edit can
 * never store a value the create path would reject (PATCH used to truncate
 * name/current_title/location/source at 200 while POST capped them at 120).
 */
export const CANDIDATE_TEXT_FIELDS = {
  name: 120, email: 200, phone: 60, current_title: 120, location: 120, source: 120, notes: 4000,
};

/**
 * Point a candidate at `assessorId` (null = unassigned) — the default for
 * their future papers — and move their *open* assessments (allocated, in
 * progress, submitted) to it, each under its own assessment lock so the move
 * cannot interleave with an exam write. Scored / validated reports keep the
 * assessor who actually scored them, the same rule the Assessments page's
 * Reassign enforces. Returns the updated candidate and the papers that moved.
 */
export async function setCandidateAssessor(store, actor, candidate, assessorId, extraPatch = {}) {
  const OPEN = ['assigned', 'in_progress', 'submitted'];
  const nextAssessor = assessorId || null;
  const changed = (candidate.assessor_id || null) !== nextAssessor;
  const updated = await store.update('candidates', candidate.id, { ...extraPatch, assessor_id: nextAssessor });
  const moved = [];
  if (changed) {
    const papers = (await store.list('assessments', { candidate_id: candidate.id }, { detached: false }))
      .filter((a) => OPEN.includes(a.status) && (a.assessor_id || null) !== nextAssessor);
    for (const a of papers) {
      const row = await withLock(`assessment:${a.id}`, async () => {
        const fresh = await store.get('assessments', a.id);
        // Re-read under the lock: a paper finalized since the listing stays
        // with the assessor who scored it, like PATCH /admin/assessments/:id.
        if (!fresh || !OPEN.includes(fresh.status) || (fresh.assessor_id || null) === nextAssessor) return null;
        return store.update('assessments', a.id, { assessor_id: nextAssessor });
      });
      if (row) moved.push(row);
    }
    if (moved.length) {
      try {
        await bulkInsert(store, 'audit_log', moved.map((a) => ({
          actor_id: actor.id, actor_name: actor.name || 'admin',
          action: 'assessment_reassigned', entity: 'assessments', entity_id: a.id,
          message: nextAssessor ? 'Assessor allocation updated from the candidate record' : 'Assessor unassigned from the candidate record',
        })));
      } catch { /* audit must never break the request */ }
    }
  }
  return { updated, moved, changed };
}

/**
 * A candidate's default assessor (`candidates.assessor_id`): the assessor who
 * scores the papers auto-allocated for them (user provisioning, bulk import)
 * and the one the Edit form changes. Returns `{ error }` when the body names
 * a login that cannot score — not an assessor, or deactivated — otherwise
 * `{ id }` (null when the field is blank / cleared).
 */
export async function candidateAssessorField(store, value) {
  if (value === undefined || value === null || value === '') return { id: null };
  if (typeof value !== 'string') return { error: 'Assessor must be an active assessor user.' };
  const id = await resolveAssessorId(store, value);
  if (!id) return { error: 'Assessor must be an active assessor user.' };
  return { id };
}

export function trackAssessorSummary(role, user) {
  return {
    default_assessor_id: role.default_assessor_id || null,
    default_assessor_name: user?.name || '',
    default_assessor_active: Boolean(user && user.role === 'assessor' && user.active !== false),
  };
}

/**
 * Competency text fields, shared by POST and PATCH for the same reason: PATCH
 * used to cap every one of them at 1500, so an edit could store a 1500-char
 * name or category that the create path refuses.
 */
export const COMPETENCY_TEXT_FIELDS = {
  name: 160, key: 60, category: 60, description: 1500, enrichment_hint: 1500,
};

/**
 * A competency key derived from its name, unique in its track. The derivation
 * keeps a-z and 0-9 only, so a name in another script used to derive a blank
 * key, and two competencies with the same name shared one. The published
 * catalogue sync matches competencies by key, so neither is harmless.
 */
export function derivedCompetencyKey(name, taken) {
  const max = COMPETENCY_TEXT_FIELDS.key;
  const base = str(name, max).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'competency';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, max - String(n).length - 1)}-${n}`;
  return key;
}

/** The columns the import understands, in the order the template lists them. */
export const IMPORT_COLUMNS = [
  { key: 'Module', required: true, note: 'T01-T10, C01-C04, P01-P04, F01-F02' },
  { key: 'Family', required: false, note: 'Family name inside that module; a new name creates a new family' },
  { key: 'Type', required: true, note: 'objective or open' },
  { key: 'Prompt', required: true, note: 'The question itself' },
  { key: 'Option A', required: false, note: 'Objective questions only' },
  { key: 'Option B', required: false, note: 'Objective questions only' },
  { key: 'Option C', required: false, note: '' },
  { key: 'Option D', required: false, note: '' },
  { key: 'Correct', required: false, note: 'Objective only, e.g. B' },
  { key: 'Rubric', required: false, note: 'Open only: what good evidence looks like' },
  { key: 'Difficulty', required: false, note: '1-5 (default 4)' },
  { key: 'Band', required: false, note: 'Foundation / Intermediate / Advanced' },
  { key: 'Tags', required: false, note: 'Comma-separated' },
];

/**
 * Merge a PATCH body over the stored question before re-validating.
 *
 * A plain spread is wrong here: the stored record carries fields *derived* from
 * values the patch is changing, and those stale leftovers then beat the new
 * input. Moving a question to another module kept the old `family_id`, which
 * out-ranks `family` in the validator ("family X does not exist in module Y");
 * switching an objective question to open kept its `options`, which an open
 * question is forbidden to have. Both made the edit impossible rather than
 * merely wrong. So: drop the derived field whenever its source is being
 * changed, and drop the fields belonging to the other answer type on a type
 * switch.
 */
export function mergeForPatch(current, body = {}) {
  const merged = { ...current, ...body };
  const changing = (k) => body[k] !== undefined;

  // `family_id` is derived from module + family; re-derive it when either moves.
  if ((changing('module') || changing('family')) && !changing('family_id')) {
    delete merged.family_id;
  }
  // Switching answer type retires the other type's payload.
  const nextType = changing('type') ? String(body.type).toLowerCase() : current.type;
  if (nextType !== current.type) {
    if (nextType === 'open') {
      delete merged.options;
      delete merged.correct_option_ids;
      delete merged.correct;
      delete merged.rationale;
      delete merged.needs_option_review;
    } else {
      delete merged.rubric;
      delete merged.probes;
    }
  }
  return merged;
}

/**
 * Remove a published question from circulation (or restore it).
 *
 * Published questions live in a generated file, so they cannot be edited or
 * hard-deleted at runtime. Removal is a visibility override row instead:
 * `{ question_id, active: false }` hides the question from the tree counts,
 * the plan and generation until the override is deleted again (restore).
 * Overrides are found by `question_id` rather than record id so the Airtable
 * adapter — which mints its own record ids — works the same as the rest.
 */
/**
 * Remove/restore is scoped by role key: a question id only exists inside one
 * published bank, but the override row carries the key so the two banks can
 * never hide each other's questions, and legacy rows (pre role-scoping)
 * resolve to the default bank.
 */
export async function setPublishedVisibility(store, questionId, active, actorId, roleKey) {
  const key = roleKey || DEFAULT_MODULE_BANK_ROLE_KEY;
  const rows = (await store.list('bank_question_overrides', { question_id: questionId }))
    .filter((r) => (r.role_key || DEFAULT_MODULE_BANK_ROLE_KEY) === key);
  if (active) {
    await bulkRemove(store, 'bank_question_overrides', rows.map((r) => r.id));
    return null;
  }
  if (rows[0]) return rows[0];
  return store.insert('bank_question_overrides', {
    question_id: questionId, role_key: key, active: false, created_by: actorId || null,
  });
}

/**
 * A downloadable CSV template with the header row and one example of each
 * type. The example module/family names are derived from the bank's own
 * published structure (first technical module, first non-technical module),
 * so the starter rows always point at a real module and family.
 */
export function importTemplateCsv(bank) {
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = IMPORT_COLUMNS.map((c) => c.key);
  const firstTechnical = bank.modules.find((m) => m.technical === true) || bank.modules[0];
  const firstNonTechnical = bank.modules.find((m) => m.technical !== true) || bank.modules[0];
  const techFamily = (firstTechnical?.families[0]?.name) || '';
  const openFamily = (firstNonTechnical?.families[0]?.name) || '';
  const example = [
    [firstTechnical?.key || 'T01', techFamily, 'objective',
      'Which Unity Catalog object is the boundary for cross-workspace data sharing?',
      'The cluster', 'The metastore', 'The notebook', 'The job',
      'B', '', '4', 'Advanced', 'governance,unity-catalog'],
    [firstNonTechnical?.key || 'C01', openFamily, 'open',
      'A client cannot articulate their success criteria. How do you run the discovery?',
      '', '', '', '', '',
      'Structures discovery, maps stakeholders, converts vague goals into measurable criteria.',
      '4', 'Intermediate', 'discovery'],
  ];
  return [header, ...example].map((r) => r.map((c) => esc(String(c))).join(',')).join('\n');
}

/** The Module column note for a bank: its real module keys, not RSA's. */
export function importColumnsFor(bank) {
  const moduleKeys = bank.modules.map((m) => m.key).join(', ');
  return IMPORT_COLUMNS.map((c) => (c.key === 'Module'
    ? { ...c, note: moduleKeys }
    : c));
}

/**
 * Read an uploaded spreadsheet out of a JSON request body.
 *
 * The API is JSON-only (no multipart), so the browser sends either
 * `file_base64` for a binary .xlsx or `csv` for text. Both land here and come
 * out as { headers, rows }.
 */
export function readImportPayload(body = {}) {
  const name = String(body.filename || '').toLowerCase();
  if (body.file_base64) {
    const raw = String(body.file_base64).replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(raw)) throw new Error('The uploaded file is not valid base64.');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) throw new Error('The uploaded file is empty.');
    if (buf.length > MAX_SPREADSHEET_BYTES) throw new Error('The file is larger than 8 MB.');
    // A .xlsx always starts with the ZIP magic "PK"; anything else is text.
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    if (isZip || name.endsWith('.xlsx')) {
      try {
        return parseSheet(buf, { format: 'xlsx' });
      } catch (err) {
        throw new Error(`That .xlsx could not be read: ${err.message}`);
      }
    }
    return parseSheet(buf.toString('utf8'), { format: 'csv' });
  }
  if (typeof body.csv === 'string' && body.csv.trim()) {
    return parseSheet(body.csv, { format: 'csv' });
  }
  throw new Error('Attach a .xlsx or .csv file to import.');
}

export const A = ['admin'];

// Assessment mutations serialize per assessment (shared with the candidate
// and assessor handlers): a delete racing a submit must not orphan response
// rows, and a reassignment racing a finalize must see the final status.
export const lockedAssessment = (fn) => async (ctx) => withLock(`assessment:${ctx.params.id}`, () => fn(ctx));


export const paginate = (rows, query, sortFn) => {
  const limit = Math.min(500, Math.max(1, Math.floor(Number(query.limit) || 200)));
  const requestedOffset = Number(query.offset);
  const offset = Number.isFinite(requestedOffset)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(requestedOffset))) : 0;
  if (sortFn) rows.sort(sortFn);
  const total = rows.length;
  const slice = rows.slice(offset, offset + limit);
  return { rows: slice, total, limit, offset };
};

/**
 * The gap map subtracts the observed level (a whole 1-5) from this target,
 * and the severity cutoffs are whole levels too — a target of 2.5 produced
 * half-level gaps that matched neither cutoff the way the editor promised.
 */
export const targetLevelError = (value) => {
  const level = num(value, NaN);
  return Number.isInteger(level) && level >= 1 && level <= 5 ? null : 'Target level must be a whole number from 1 to 5.';
};
export function validateCompetency(body) {
  if (!str(body.name)) return 'Competency name is required.';
  if (body.weight !== undefined && (num(body.weight, -1) < 0 || num(body.weight) > 100)) return 'Weight must be 0-100.';
  if (body.target_level !== undefined && targetLevelError(body.target_level)) return targetLevelError(body.target_level);
  return null;
}

export const validateQuestion = (body) => {
  if (!QUESTION_TYPE_KEYS.includes(body.type)) return `Type must be one of: ${QUESTION_TYPE_KEYS.join(', ')}`;
  if (!str(body.prompt)) return 'Question prompt is required.';
  if (!isTextish(body.prompt)) return 'Question prompt must be plain text.';
  if (body.help_text !== undefined && !isTextish(body.help_text)) return 'Question help text must be plain text.';
  if (body.rubric !== undefined && !isTextish(body.rubric)) return 'Question rubric must be plain text.';
  const points = questionPoints(body);
  if (!Number.isFinite(points) || points < 1 || points > 20) return 'Points must be between 1 and 20.';
  if (DIFFICULTIES.includes(body.difficulty) === false && body.difficulty !== undefined && body.difficulty !== '')
    return `Difficulty must be one of: ${DIFFICULTIES.join(', ')}`;
  if (body.type === 'mcq_single' || body.type === 'mcq_multi') {
    const opts = cleanOptions(body.options);
    if (opts.length < 2) {
      // Say why when the admin typed options that were then dropped: a row
      // with a blank label used to fail with the misleading "at least two
      // options" even though the form clearly showed two.
      // Only a typed-and-blank label is named here; a structured (non-text)
      // id or label is a shape problem, which the count rule already covers.
      const blankLabels = Array.isArray(body.options)
        ? body.options.filter((o) => o && typeof o === 'object' && isTextish(o.id) && isTextish(o.label) && str(o.label, 500) === '').length
        : 0;
      return blankLabels > 0 ? 'Every answer option needs a label.' : 'At least two options are required.';
    }
    const ids = new Set(opts.map((o) => o.id));
    // Two options sharing an id are indistinguishable once served: the
    // candidate's pick is stored by id, so either label would score as the
    // key. Same for two identical labels — a choice the candidate cannot
    // tell apart is not a question.
    if (ids.size !== opts.length) return 'Each answer option needs a unique id.';
    const labels = new Set(opts.map((o) => o.label.toLowerCase()));
    if (labels.size !== opts.length) return 'Answer options must be distinct.';
    // Compared as stored (strings): `correct_option_ids: [1]` must line up
    // with `options: [{ id: 1 }]`, which cleanOptions stringifies.
    const correct = Array.isArray(body.correct_option_ids)
      ? [...new Set(body.correct_option_ids.filter(isTextish).map((x) => str(x, 40)))]
      : [];
    if (body.type === 'mcq_single' && correct.length !== 1) return 'Exactly one correct option is required.';
    if (body.type === 'mcq_multi' && (correct.length < 1 || correct.length >= opts.length))
      return 'Select at least one (but not all) correct options.';
    if (correct.some((id) => !ids.has(id))) return 'Correct options must be chosen from the option list.';
  }
  if (body.type === 'text' && !str(body.rubric)) return 'An assessor rubric (expected evidence) is required for open questions.';
  return null;
};

/**
 * Is another question in this role's bank already this prompt?
 *
 * This bank is what allocation draws the paper from, so a duplicate here is
 * literally the same question asked twice in one assessment — and the admin
 * question form had no such check at all (the module-bank authoring route
 * did, which is why the gap went unnoticed). Compared by the shared prompt
 * key so a re-typed or re-pasted copy is caught, not just a byte-identical
 * one; scoped to the role, because the identical prompt in another role's
 * bank is a deliberate reuse, not a duplicate.
 */
export const duplicatePromptInRole = async (store, roleId, prompt, exceptId = null) => {
  const key = promptKey(prompt);
  if (!key) return null;
  const rows = await store.list('questions', { role_id: roleId });
  return rows.find((q) => q.id !== exceptId && promptKey(q.prompt) === key) || null;
};

export const roleKeyOf = (src) => {
  const key = (src && (src.role_key || src.roleKey)) || '';
  return key || DEFAULT_MODULE_BANK_ROLE_KEY;
};
export const requireBank = (roleKey) => moduleBankFor(roleKey) || null;

// The published catalogue in src/content is generated and read-only, so
// every read below goes through effectiveBank(), which merges it with the
// admin-authored questions in the `bank_questions` table. One source of
// truth for the tree, the drill-down, the plan, the preview and generation.
export const bankContext = async (store, roleKey) => {
  const questions = await effectiveBank(store, roleKey);
  return { questions, modules: composeModules(questions, roleKey), families: composeFamilies(questions, roleKey) };
};

/** Years of experience: empty/omitted → null, never coerced to 0 via Number(null). */
export function yearsExperience(value) {
  if (value === undefined || value === null || value === '') return null;
  return num(value, null);
}

/**
 * A password must be a real string of 8+ characters. The old check was
 * `String(body.password).length >= 8`, so a structured value posted by a
 * scripted client (`{}`, `[...]`, `12345678`) was accepted and hashed as its
 * string form ("[object Object]", "1,2,3,…") — a login nobody could type.
 */
export function passwordError(value) {
  if (typeof value !== 'string') return 'Password must be a string.';
  if (value.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

/**
 * The optional `question_count` an allocation may carry — the manual Allocate
 * dialog, a candidate-user creation and the bulk import all accept it. Blank
 * or omitted means the default cap; anything else must be a whole number in
 * 1..MAX_ASSESSMENT_QUESTIONS. The automatic paths used to swallow junk here
 * ('abc', -1, 9999) and quietly allocate the default 50, so an admin who
 * mistyped the count never learned their number was ignored.
 */
export function questionCountError(value) {
  if (value === undefined || value === null || value === '') return null;
  // Only a number or a numeric string counts; `Number(true)` is 1 and
  // `Number([])` is 0, neither of which anyone typed.
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) return 'Number of questions must be a whole number of 1 or more.';
  if (n > MAX_ASSESSMENT_QUESTIONS) return `Number of questions cannot exceed ${MAX_ASSESSMENT_QUESTIONS}.`;
  return null;
}

/**
 * An email, when given, must look like one. Blank/omitted is fine (contact
 * details are optional); anything else must be `local@domain.tld` with no
 * whitespace. Kept deliberately loose — the point is to catch a name or a
 * phone number typed into the wrong box, not to police RFC 5322. The bulk
 * import and the admin form apply the same rule.
 */
export function emailError(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isTextish(value)) return 'Email must be plain text.';
  return emailShapeProblem(String(value));
}

/** Validate years-of-experience input the same way the bulk import does. */
export function yearsError(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 50) {
    return 'Years of experience must be a number between 0 and 50.';
  }
  return null;
}

/**
 * The option entries a request may carry are untrusted: a hand-edited JSON
 * import or a stale form can post `null`, a bare string or a number inside the
 * array. Validation and persistence must agree on what survives, so both call
 * this one cleaner — an option needs to be an object with a non-blank label, and
 * its id/label are stored exactly as validated (numbers stringified, so an
 * `options:[{id:1}]` row and a `correct_option_ids:[1]` reference line up).
 */
export function cleanOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o) => o && typeof o === 'object')
    // An option whose id or label is a structured value is dropped, not
    // stringified: `str({…})` would store the literal "[object Object]" as a
    // served answer choice. Numbers survive (stringified, so `{id: 1}` still
    // lines up with `correct_option_ids: [1]`).
    .filter((o) => isTextish(o.id) && isTextish(o.label))
    .map((o) => ({ id: str(o.id, 40), label: str(o.label, 500) }))
    .filter((o) => o.label !== '');
}

/**
 * The points a request means, exactly as validation reads them: a missing or
 * blank value is the 4-point default. Persistence used to run the same input
 * through `num(body.points, 4)`, and `Number('')` is 0 — so a form that posted
 * `points: ""` passed validation as "default 4" and was stored as a 0-point
 * question, which then scored its competency at 0% (a critical gap) no matter
 * how the candidate answered.
 */
export function questionPoints(body) {
  return body.points === undefined || body.points === '' ? 4 : Number(body.points);
}

export function normalizeQuestion(body, existing = {}) {
  const type = body.type || existing.type;
  // Options and answer keys only mean something on a choice question. A row
  // switched from mcq_* to text/scale used to keep its stale option list and
  // key, which the candidate projection then served alongside the open prompt.
  const isChoice = type === 'mcq_single' || type === 'mcq_multi';
  const options = isChoice ? cleanOptions(body.options) : [];
  return {
    role_id: body.role_id || existing.role_id,
    competency_id: body.competency_id || existing.competency_id,
    type,
    prompt: str(body.prompt, 2000), help_text: str(body.help_text, 1000),
    options,
    correct_option_ids: isChoice && Array.isArray(body.correct_option_ids)
      ? [...new Set(body.correct_option_ids.filter(isTextish).map((x) => str(x, 40)))]
      : [],
    points: questionPoints(body), difficulty: body.difficulty || 'intermediate',
    rubric: str(body.rubric, 3000), order: num(body.order, existing.order ?? 0),
    active: body.active !== undefined ? bool(body.active) : true,
    // Oral/spoken-question metadata must survive an edit: an admin fixing a
    // typo (or toggling a field) on a spoken question must not strip the
    // microphone requirement, the pinned-first rule or set membership — the
    // form does not send these, so they persist from the existing record.
    question_set: str(body.question_set ?? existing.question_set ?? '', 80),
    pin_first: body.pin_first !== undefined ? bool(body.pin_first) : existing.pin_first === true,
    // The microphone is a rule of the open-question type, not a preference:
    // `requiresSpokenAnswer` makes an open row always demand a recording, so an
    // edit can never store a silent open question (and a non-open row keeps
    // whatever explicit opt-in the caller sent).
    audio_required: requiresSpokenAnswer({
      type: body.type || existing.type,
      audio_required: body.audio_required !== undefined ? bool(body.audio_required) : existing.audio_required === true,
    }),
  };
}

export {
  purgePreview,
  purgePerson,
  deleteUnfinalizedCandidate,
  listBookings,
  newToken,
  expireExam,
  creationRequest,
  sameCreation,
  creationId,
  issueRecoveryLink,
  hashPasswordAsync,
  hashPasswordsAsync,
  verifyPasswordAsync,
  ok,
  created,
  bad,
  notFound,
  conflict,
  forbidden,
  unprocessable,
  audit,
  str,
  num,
  bool,
  missing,
  bulkInsert,
  bulkUpdate,
  bulkRemove,
  isTextish,
  textField,
  publicUser,
  withLock,
  USER_ROLES,
  STAGE_KEYS,
  QUESTION_TYPE_KEYS,
  DIFFICULTIES,
  DEFAULT_FRAMEWORK_CONFIG,
  PIPELINE_STAGES,
  MAX_ASSESSMENT_QUESTIONS,
  MAX_SPREADSHEET_BYTES,
  validateFrameworkConfig,
  requiresSpokenAnswer,
  defaultQuestionCountForRole,
  buildSnapshot,
  roleBank,
  automaticSnapshotFromBank,
  advanceStage,
  autoAllocateAssessment,
  planBulkAutoAllocation,
  paperSummary,
  paperFacts,
  allocationLockKey,
  resolveAssessorId,
  allocationPreview,
  hasStrictModuleAllocation,
  catalogueStatus,
  catalogueMissing,
  syncCatalogue,
  catalogueForRoleKey,
  listCatalogues,
  installCatalogue,
  isCatalogueCompetency,
  moduleBankFor,
  DEFAULT_MODULE_BANK_ROLE_KEY,
  readRetentionSettings,
  saveRetentionSettings,
  runRetentionSweep,
  retentionStatus,
  sweepInBackground,
  paperRetention,
  DEFAULT_RETENTION,
  generateTest,
  testPlan,
  blueprintFor,
  isActive,
  validateBankQuestion,
  validateBatch,
  promptKey,
  parseSheet,
  CANDIDATE_IMPORT_COLUMNS,
  candidateImportTemplateCsv,
  validateCandidateBatch,
  emailShapeProblem,
  effectiveBank,
  composeModules,
  composeFamilies,
  resolveFamily,
  nextAuthoredId,
  toStoredRecord,
  hydrate,
};
