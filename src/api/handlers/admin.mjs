import { hashPasswordAsync, hashPasswordsAsync, verifyPasswordAsync } from '../../core/passwords.mjs';
import {
  ok, created, bad, notFound, conflict, forbidden, unprocessable, audit,
  str, num, bool, missing, bulkInsert, bulkUpdate, bulkRemove, isTextish, textField,
} from '../helpers.mjs';
import { publicUser } from '../projections.mjs';
import { withLock } from '../mutex.mjs';
import {
  USER_ROLES, STAGE_KEYS, QUESTION_TYPE_KEYS, DIFFICULTIES, DEFAULT_FRAMEWORK_CONFIG,
  PIPELINE_STAGES, MAX_ASSESSMENT_QUESTIONS, MAX_SPREADSHEET_BYTES,
} from '../../core/constants.mjs';
import { validateFrameworkConfig } from '../../core/scoring.mjs';
import { requiresSpokenAnswer } from '../../core/spoken-answer.mjs';
import {
  buildSnapshot, roleBank, advanceStage, autoAllocateAssessment, planBulkAutoAllocation, paperSummary, paperFacts,
  allocationLockKey, resolveAssessorId,
} from '../assessment-service.mjs';
import { allocationPreview } from '../../core/question-selection.mjs';
import {
  catalogueStatus, catalogueMissing, syncCatalogue, catalogueForRoleKey,
  listCatalogues, installCatalogue, isCatalogueCompetency,
} from '../catalogue-service.mjs';
import {
  moduleBankFor, DEFAULT_MODULE_BANK_ROLE_KEY,
} from '../../content/module-banks.mjs';
import {
  generateTest, testPlan, blueprintFor, isActive,
} from '../../core/test-generation.mjs';
import {
  validateQuestion as validateBankQuestion, validateBatch, promptKey,
} from '../../core/question-intake.mjs';
import { parseSheet } from '../../core/sheet-parser.mjs';
import {
  CANDIDATE_IMPORT_COLUMNS, candidateImportTemplateCsv, validateCandidateBatch, emailShapeProblem,
} from '../../core/candidate-import.mjs';
import {
  effectiveBank, composeModules, composeFamilies, resolveFamily,
  nextAuthoredId, toStoredRecord, hydrate,
} from '../bank-service.mjs';

/** Upper bound on one spreadsheet import, to bound request time and memory. */
const MAX_IMPORT_ROWS = 2000;
/**
 * Rows a single commit request may write. A commit costs ~22 ms per portal
 * user before any network (a scrypt hash each, two at a time so the
 * threadpool stays available), so the 2000-row file the dry run happily
 * validates would run ~45 s as one request — past a serverless function's
 * 10 s (26 s at most) and past most proxies' patience — and be killed with
 * the candidates written and the users not. The client commits in pages
 * (`offset` + `limit`); a larger single request is refused up front.
 */
const MAX_IMPORT_COMMIT_ROWS = 200;

/**
 * Candidate field lengths, shared by the create form and PATCH so an edit can
 * never store a value the create path would reject (PATCH used to truncate
 * name/current_title/location/source at 200 while POST capped them at 120).
 */
const CANDIDATE_TEXT_FIELDS = {
  name: 120, email: 200, phone: 60, current_title: 120, location: 120, source: 120, notes: 4000,
};

/**
 * A candidate's default assessor (`candidates.assessor_id`): the assessor who
 * scores the papers auto-allocated for them (user provisioning, bulk import)
 * and the one the Edit form changes. Returns `{ error }` when the body names
 * a login that cannot score — not an assessor, or deactivated — otherwise
 * `{ id }` (null when the field is blank / cleared).
 */
async function candidateAssessorField(store, value) {
  if (value === undefined || value === null || value === '') return { id: null };
  if (typeof value !== 'string') return { error: 'Assessor must be an active assessor user.' };
  const id = await resolveAssessorId(store, value);
  if (!id) return { error: 'Assessor must be an active assessor user.' };
  return { id };
}

/**
 * Competency text fields, shared by POST and PATCH for the same reason: PATCH
 * used to cap every one of them at 1500, so an edit could store a 1500-char
 * name or category that the create path refuses.
 */
const COMPETENCY_TEXT_FIELDS = {
  name: 160, key: 60, category: 60, description: 1500, enrichment_hint: 1500,
};

/**
 * A competency key derived from its name, unique in its track. The derivation
 * keeps a-z and 0-9 only, so a name in another script used to derive a blank
 * key, and two competencies with the same name shared one. The published
 * catalogue sync matches competencies by key, so neither is harmless.
 */
function derivedCompetencyKey(name, taken) {
  const max = COMPETENCY_TEXT_FIELDS.key;
  const base = str(name, max).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'competency';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, max - String(n).length - 1)}-${n}`;
  return key;
}

/** The columns the import understands, in the order the template lists them. */
const IMPORT_COLUMNS = [
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
function mergeForPatch(current, body = {}) {
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
async function setPublishedVisibility(store, questionId, active, actorId, roleKey) {
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
function importTemplateCsv(bank) {
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
function importColumnsFor(bank) {
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
function readImportPayload(body = {}) {
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

const A = ['admin'];

// Assessment mutations serialize per assessment (shared with the candidate
// and assessor handlers): a delete racing a submit must not orphan response
// rows, and a reassignment racing a finalize must see the final status.
const lockedAssessment = (fn) => async (ctx) => withLock(`assessment:${ctx.params.id}`, () => fn(ctx));

export function adminHandlers(route) {

  // ------------------------------------------------ dashboard
  route('GET', '/admin/dashboard', A, async ({ store }) => {
    const [candidates, assessments, roles] = await Promise.all([
      store.list('candidates'), store.list('assessments', {}, { detached: false }), store.list('roles'),
    ]);
    const byStage = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, 0]));
    for (const c of candidates) byStage[c.stage || 'intake'] = (byStage[c.stage || 'intake'] ?? 0) + 1;
    const byStatus = {};
    for (const a of assessments) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    const scored = assessments.filter((a) => a.status === 'scored' || a.status === 'validated');
    const ready = scored.filter((a) => a.readiness_key === 'enterprise_ready');
    const avg = scored.length
      ? Math.round((scored.reduce((s, a) => s + Number(a.overall_pct || 0), 0) / scored.length) * 10) / 10
      : null;
    const auditRows = (await store.list('audit_log'))
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, 12);
    return ok({
      counts: {
        candidates: candidates.length,
        enterprise_ready: new Set(ready.map((a) => a.candidate_id)).size,
        active_assessments: assessments.filter((a) => ['assigned', 'in_progress', 'submitted'].includes(a.status)).length,
        awaiting_scoring: byStatus.submitted || 0,
        roles: roles.length,
        avg_score: avg,
      },
      by_stage: byStage,
      by_status: byStatus,
      recent_activity: auditRows,
    });
  });

  // ------------------------------------------------ candidates
  // Pagination: limit/offset to prevent OOM on large directories. Default 200, max 500.
  const paginate = (rows, query, sortFn) => {
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));
    const offset = Math.max(0, Number(query.offset) || 0);
    if (sortFn) rows.sort(sortFn);
    const total = rows.length;
    const slice = rows.slice(offset, offset + limit);
    return { rows: slice, total, limit, offset };
  };

  route('GET', '/admin/candidates', A, async ({ store, query }) => {
    let rows = await store.list('candidates');
    if (query.stage) rows = rows.filter((c) => c.stage === query.stage);
    if (query.role_id) rows = rows.filter((c) => c.target_role_id === query.role_id);
    if (query.q) {
      const q = String(query.q).toLowerCase();
      rows = rows.filter((c) => `${c.name} ${c.email || ''}`.toLowerCase().includes(q));
    }
    const [roles, users] = await Promise.all([store.list('roles'), store.list('users')]);
    const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    const userName = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const sorted = rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const page = paginate(sorted, query, null);
    return ok({
      candidates: page.rows.map((c) => ({
        ...c,
        role_name: roleName[c.target_role_id] || '',
        assessor_name: (c.assessor_id && userName[c.assessor_id]) || '',
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  });

  route('POST', '/admin/candidates', A, async ({ store, body, auth }) => {
    const miss = missing(body, ['name']);
    if (miss.length) return bad('Candidate name is required.');
    const structured = textField(body, Object.keys(CANDIDATE_TEXT_FIELDS));
    if (structured) return bad(`Candidate ${structured} must be plain text.`);
    if (!str(body.name)) return bad('Candidate name is required.');
    const emailProblem = emailError(body.email);
    if (emailProblem) return bad(emailProblem);
    if (body.stage && !STAGE_KEYS.includes(body.stage)) return bad('Unknown pipeline stage.');
    if (body.target_role_id) {
      const role = await store.get('roles', body.target_role_id);
      if (!role) return bad('Unknown target role.');
      if (role.active === false) return bad('Target role is inactive.');
    }
    const yearsProblem = yearsError(body.years_experience);
    if (yearsProblem) return bad(yearsProblem);
    const assessorField = await candidateAssessorField(store, body.assessor_id);
    if (assessorField.error) return bad(assessorField.error);
    const rec = await store.insert('candidates', {
      name: str(body.name, 120), email: str(body.email, 200), phone: str(body.phone, 60),
      current_title: str(body.current_title, 120), years_experience: yearsExperience(body.years_experience),
      location: str(body.location, 120), source: str(body.source, 120), notes: str(body.notes, 4000),
      target_role_id: body.target_role_id || null,
      assessor_id: assessorField.id,
      stage: body.stage || (body.target_role_id ? 'role_mapped' : 'intake'),
      created_by: auth.user.id,
    });
    await audit(store, auth.user, 'candidate_created', 'candidates', rec.id, `Candidate "${rec.name}" added`);
    return created(rec);
  });

  // ------------------------------------------------ bulk import (candidates + portal users)
  // The same spreadsheet workflow as the question-bank import: every upload is
  // validated as a dry run first (nothing written), rows are reported as
  // ready / rejected / duplicate with their reasons, then the commit creates
  // candidate records and — when asked — their linked candidate-role portal
  // users. Blank usernames/passwords are generated, and the plaintext
  // credentials are returned exactly once in the commit response.
  route('GET', '/admin/candidates/import-template', A, async () => ok({
    filename: 'ecod-candidates-import-template.csv',
    content_type: 'text/csv',
    columns: CANDIDATE_IMPORT_COLUMNS,
    csv: candidateImportTemplateCsv(),
  }));

  route('POST', '/admin/candidates/import', A, async ({ store, body, auth }) => {
    const countProblem = questionCountError(body.question_count);
    if (countProblem) return bad(countProblem);
    let parsed;
    try {
      parsed = readImportPayload(body);
    } catch (err) {
      return bad(err.message);
    }
    if (!parsed.rows.length) {
      return unprocessable('No data rows found. The first row must be a header (Name, Email, Target role, ...).', {
        headers: parsed.headers,
      });
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      return unprocessable(`This file has ${parsed.rows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import.`);
    }

    const createUsers = bool(body.create_users);
    // Username/email uniqueness is checked against a snapshot of the tables
    // and the rows are then written in batches: two imports (or an import and
    // an Add user) in flight together used to pass the check independently.
    // Users are created under the same lock as single-user creation.
    return withLock('users:create', async () => {
    const [roles, existingCandidates, existingUsers] = await Promise.all([
      store.list('roles'), store.list('candidates'), store.list('users'),
    ]);
    const report = validateCandidateBatch(parsed.rows, {
      roles,
      stages: PIPELINE_STAGES,
      assessors: existingUsers,
      createUsers,
      existingCandidates,
      existingUsernames: existingUsers.map((u) => u.username),
    });

    // Bulk imports auto-allocate the same default 50-question assessment each
    // single candidate user gets — the whole point is that onboarding 2000
    // candidates must not need 2000 manual Allocate clicks. The plan is built
    // before anything is written, so the dry run previews exactly what the
    // commit will allocate, and imported rows land with the right target
    // track and pipeline stage in the same batched write. Pass
    // `{ auto_allocate: false }` for logins without assessments.
    const autoAllocate = createUsers
      && body.auto_allocate !== false && body.auto_allocate !== 'false'
      && body.skip_auto_allocation !== true && body.skip_auto_allocation !== 'true';
    const dryRun = bool(body.dry_run);

    // A commit writes one page of the file: the rows at [offset, offset+limit)
    // that passed validation. The whole file is validated every time so an
    // in-file duplicate is judged the same way on every page; rows written by
    // an earlier page are simply found in the directory by the next. Without
    // paging parameters the whole file is one page, capped. A dry run always
    // looks at the whole file.
    const total = parsed.rows.length;
    const paged = !dryRun && (body.offset !== undefined || body.limit !== undefined);
    const offset = dryRun ? 0 : Math.max(0, Math.min(total, Math.floor(Number(body.offset) || 0)));
    const limitRaw = Math.floor(Number(body.limit));
    const limit = !dryRun && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_IMPORT_COMMIT_ROWS) : total - offset;
    const end = Math.min(total, offset + limit);
    if (!dryRun && end - offset > MAX_IMPORT_COMMIT_ROWS) {
      return unprocessable(`A commit writes at most ${MAX_IMPORT_COMMIT_ROWS} rows per request; this file has ${total}. `
        + `Send the commit in pages with \`offset\` and \`limit\` (the import dialog does this for you).`);
    }
    const inWindow = ({ line }) => line - 2 >= offset && line - 2 < end;
    const windowAccepted = dryRun ? report.accepted : report.accepted.filter(inWindow);

    // Papers are planned only for the rows this request will write (a dry
    // run plans the whole file, which is what its preview reports).
    const plans = autoAllocate && windowAccepted.length
      ? await planBulkAutoAllocation(store, windowAccepted, {
        roles, questionCount: body.question_count ?? MAX_ASSESSMENT_QUESTIONS,
      })
      : [];
    const plannedCount = plans.filter((p) => p.ok).length;

    // The dialog-wide default assessor (`assessor_id`) scores every planned
    // paper whose row left the Assessor column blank; an unknown or inactive
    // default is ignored rather than failing the whole file.
    const defaultAssessorId = await resolveAssessorId(store, body.assessor_id || null);
    const defaultAssessorName = defaultAssessorId ? (existingUsers.find((u) => u.id === defaultAssessorId)?.name || '') : '';

    const summary = {
      headers: parsed.headers,
      create_users: createUsers,
      auto_allocate: autoAllocate,
      default_assessor_id: defaultAssessorId,
      default_assessor_name: defaultAssessorName,
      would_auto_allocate: plannedCount,
      auto_skipped: plans.length - plannedCount,
      total: parsed.rows.length,
      accepted: report.accepted.length,
      rejected: report.rejected.length,
      duplicates: report.duplicates.length,
      dry_run: dryRun,
      errors: report.rejected.slice(0, 50),
      duplicate_rows: report.duplicates.slice(0, 50),
      preview: report.accepted.slice(0, 10).map((a) => ({
        line: a.line,
        name: a.candidate.name,
        target_role: a.candidate.target_role || '',
        stage: a.candidate.stage || '',
        assessor: a.candidate.assessor || defaultAssessorName || '',
        username: a.candidate.username || '',
      })),
    };
    if (dryRun) return ok({ ...summary, imported: 0, users_created: 0, credentials: [] });

    const pageAccepted = windowAccepted.map((a, i) => ({ ...a, plan: plans[i] }));
    const page = { offset, limit: end - offset, total, next_offset: end < total ? end : null };
    const pageSummary = paged
      ? {
        ...summary,
        accepted: pageAccepted.length,
        rejected: report.rejected.filter(inWindow).length,
        duplicates: report.duplicates.filter(inWindow).length,
        errors: report.rejected.filter(inWindow).slice(0, 50),
        duplicate_rows: report.duplicates.filter(inWindow).slice(0, 50),
      }
      : summary;

    // The expensive part first, before anything is written: a request killed
    // mid-way (a function timeout, a dropped connection) then leaves nothing
    // behind, rather than candidates without their portal users.
    const hashes = createUsers && pageAccepted.length
      ? await hashPasswordsAsync(pageAccepted.map(({ candidate }) => candidate.password))
      : [];

    // One batched write per table (the adapters' `insertMany`; a plain loop
    // as a fallback), so a 2000-row onboarding is a handful of store writes
    // instead of thousands of full-file rewrites. Rows with a planned
    // assessment land with their target track filled in (when the sheet left
    // it blank) and their stage already at Assessment.
    const batch = pageAccepted.map(({ candidate, plan }) => {
      const target_role_id = candidate.target_role_id || (plan?.ok ? plan.role.id : null) || null;
      let stage = candidate.stage || (target_role_id ? 'role_mapped' : 'intake');
      if (plan?.ok && STAGE_KEYS.indexOf(stage) < STAGE_KEYS.indexOf('assessment')) stage = 'assessment';
      return {
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        current_title: candidate.current_title,
        years_experience: candidate.years_experience ?? null,
        location: candidate.location,
        source: candidate.source,
        notes: candidate.notes,
        target_role_id,
        assessor_id: candidate.assessor_id || defaultAssessorId || null,
        stage,
        created_by: auth.user.id,
      };
    });
    const importedRecords = batch.length ? await bulkInsert(store, 'candidates', batch) : [];
    const imported = importedRecords.length;

    let credentials = [];
    let usersCreated = 0;
    if (createUsers && importedRecords.length) {
      const userBatch = pageAccepted.map(({ candidate }, i) => ({
        username: candidate.username,
        name: candidate.name,
        email: candidate.email,
        role: 'candidate',
        password_hash: hashes[i],
        candidate_id: importedRecords[i].id,
        active: true,
        created_by: auth.user.id,
      }));
      const users = await bulkInsert(store, 'users', userBatch);
      usersCreated = users.length;
      credentials = users.map((u, i) => ({
        username: u.username,
        name: pageAccepted[i].candidate.name,
        password: pageAccepted[i].candidate.password,
      }));
    }

    // The planned assessments land in one more batched write, with one audit
    // row each (also batched) so the trail matches single-user onboarding.
    let auto_allocated = 0;
    let auto_allocations = [];
    if (autoAllocate && importedRecords.length && usersCreated) {
      const assessmentBatch = [];
      const allocatedIdx = [];
      auto_allocations = importedRecords.map((rec, i) => {
        const plan = pageAccepted[i].plan;
        const username = credentials[i]?.username || '';
        if (!plan?.ok) {
          return { username, name: rec.name, allocated: false, reason: plan?.reason || 'No assessment track available.' };
        }
        const scope = plan.snapshot.question_limit
          ? `${plan.question_count} of ${plan.snapshot.bank_total} questions`
          : `all ${plan.question_count} questions`;
        // The row's own Assessor column wins; the dialog default fills blanks.
        const assessorId = rec.assessor_id || null;
        assessmentBatch.push({
          candidate_id: rec.id, role_id: plan.role.id, assessor_id: assessorId,
          status: 'assigned', snapshot_json: plan.snapshot, report_json: null,
          // The same listing facts every other allocation path stamps. Without
          // them the file and blob adapters (which store the paper apart from
          // the row) made the first assessments listing after an import fetch
          // each imported paper whole and rewrite its row, one after another:
          // up to 2,000 sequential reads and writes for one import.
          ...paperSummary(plan.snapshot),
          overall_pct: null, readiness_key: '', readiness_label: '', created_by: auth.user.id,
        });
        allocatedIdx.push(i);
        return {
          username, name: rec.name, allocated: true,
          role_id: plan.role.id, role_name: plan.role.name,
          question_count: plan.question_count,
          assessor_id: assessorId,
          assessor_name: assessorId ? (existingUsers.find((u) => u.id === assessorId)?.name || '') : '',
          detail: `${scope} · ${plan.role.name}`,
        };
      });
      if (assessmentBatch.length) {
        const inserted = await bulkInsert(store, 'assessments', assessmentBatch);
        inserted.forEach((a, k) => { auto_allocations[allocatedIdx[k]].assessment_id = a.id; });
        auto_allocated = inserted.length;
        try {
          await bulkInsert(store, 'audit_log', inserted.map((a, k) => {
            const row = auto_allocations[allocatedIdx[k]];
            return {
              actor_id: auth.user.id, actor_name: auth.user.name || 'admin',
              action: 'assessment_allocated', entity: 'assessments', entity_id: a.id,
              message: `Assessment auto-allocated to “${row.name}” (${row.detail})${row.assessor_id ? '' : ' — assessor to be assigned'}`,
            };
          }));
        } catch { /* audit must never break the request */ }
      }
    }
    if (imported) {
      await audit(store, auth.user, 'candidates_bulk_imported', 'candidates', '',
        `${imported} candidate(s) imported from a spreadsheet`
        + (paged ? ` (rows ${offset + 1}–${end} of ${total})` : '')
        + (usersCreated ? ` (${usersCreated} portal user(s) created)` : '')
        + (auto_allocated ? ` (${auto_allocated} assessment(s) auto-allocated)` : ''));
    }
    return ok({ ...pageSummary, imported, users_created: usersCreated, credentials, auto_allocated, auto_allocations, page });
    });
  });

  route('GET', '/admin/candidates/:id', A, async ({ store, params }) => {
    const c = await store.get('candidates', params.id);
    if (!c) return notFound('Candidate not found.');
    const [assessments, roles, users] = await Promise.all([
      store.list('assessments', { candidate_id: c.id }, { detached: false }), store.list('roles'), store.list('users'),
    ]);
    const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    const assessorName = Object.fromEntries(users.map((u) => [u.id, u.name]));
    assessments.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const facts = await paperFacts(store, assessments);
    // The timeline is the candidate's journey. Their papers' milestones
    // (allocated, reassigned, submitted, scored) are audited against the
    // assessment, not the candidate, so a timeline built from candidate
    // events alone never showed any of them, and a candidate created by a
    // spreadsheet import (one audit row for the whole file) read "No events
    // yet". Integrity beacons and exam notices stay out: they have their own
    // screen, and up to 200 of them per paper would push the milestones out
    // of the 30-event list.
    const events = [...await store.list('audit_log', { entity: 'candidates', entity_id: c.id })];
    for (const a of assessments) {
      const rows = await store.list('audit_log', { entity: 'assessments', entity_id: a.id });
      events.push(...rows.filter((e) => String(e.action || '').startsWith('assessment_')));
    }
    events.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    events.splice(30);
    return ok({
      candidate: c,
      role_name: roleName[c.target_role_id] || '',
      assessor_name: (c.assessor_id && assessorName[c.assessor_id]) || '',
      assessments: assessments.map((a, i) => ({
        id: a.id, status: a.status, created_at: a.created_at, submitted_at: a.submitted_at,
        scored_at: a.scored_at, overall_pct: a.overall_pct, readiness_label: a.readiness_label,
        role_name: roleName[a.role_id] || 'Assessment',
        assessor_name: assessorName[a.assessor_id] || null,
        question_count: facts[i].question_count,
        question_limit: facts[i].question_limit,
        bank_total: facts[i].bank_total,
        integrity_count: Object.values(a.quiz_state?.integrity || {}).reduce((s, v) => s + Number(v || 0), 0),
        last_integrity_event: a.quiz_state?.events?.length
          ? a.quiz_state.events[a.quiz_state.events.length - 1].event
          : null,
      })),
      linked_user: users.find((u) => u.candidate_id === c.id) ? publicUser(users.find((u) => u.candidate_id === c.id)) : null,
      timeline: events,
    });
  });

  route('PATCH', '/admin/candidates/:id', A, async ({ store, body, params, auth }) => {
    const c = await store.get('candidates', params.id);
    if (!c) return notFound('Candidate not found.');
    const structured = textField(body, Object.keys(CANDIDATE_TEXT_FIELDS));
    if (structured) return bad(`Candidate ${structured} must be plain text.`);
    // Create requires a name; an edit must not be able to blank it (the
    // record then renders as a nameless row in every list and audit line).
    if (body.name !== undefined && !str(body.name)) return bad('Candidate name is required.');
    const emailProblem = emailError(body.email);
    if (emailProblem) return bad(emailProblem);
    if (body.stage !== undefined && (!body.stage || !STAGE_KEYS.includes(body.stage)))
      return bad('Unknown pipeline stage.');
    if (body.target_role_id) {
      const role = await store.get('roles', body.target_role_id);
      if (!role) return bad('Unknown target role.');
      if (role.active === false) return bad('Target role is inactive.');
    }
    const patch = {};
    for (const [f, max] of Object.entries(CANDIDATE_TEXT_FIELDS))
      if (body[f] !== undefined) patch[f] = body[f] === '' ? '' : str(body[f], max);
    if (body.target_role_id !== undefined)
      patch.target_role_id = body.target_role_id === '' ? null : str(body.target_role_id, 60);
    if (body.years_experience !== undefined) {
      const yearsProblem = yearsError(body.years_experience);
      if (yearsProblem) return bad(yearsProblem);
      patch.years_experience = yearsExperience(body.years_experience);
    }
    // Stage was validated above but never written — the admin Edit form sends it
    // on every save, so changing a candidate's pipeline stage silently no-op'd.
    if (body.stage !== undefined) patch.stage = body.stage;
    // The assessor is editable from the candidate record. Changing it moves
    // the candidate's open papers (not yet scored) to the new assessor too —
    // that is what an admin editing "Assessor" on a candidate means — while
    // finalized reports keep the assessor who actually scored them.
    let assessorChanged = false;
    let reassigned = [];
    if (body.assessor_id !== undefined) {
      const assessorField = await candidateAssessorField(store, body.assessor_id);
      if (assessorField.error) return bad(assessorField.error);
      patch.assessor_id = assessorField.id;
      assessorChanged = (c.assessor_id || null) !== assessorField.id;
    }
    const updated = await store.update('candidates', params.id, patch);
    if (assessorChanged) {
      const nextAssessor = updated.assessor_id || null;
      const open = (await store.list('assessments', { candidate_id: c.id }, { detached: false }))
        .filter((a) => ['assigned', 'in_progress', 'submitted'].includes(a.status) && (a.assessor_id || null) !== nextAssessor);
      // Same lock as PATCH /admin/assessments/:id so the move cannot
      // interleave with an exam write; status is re-read under it because a
      // paper may have been finalized between the listing and the move.
      for (const a of open) {
        const moved = await withLock(`assessment:${a.id}`, async () => {
          const fresh = await store.get('assessments', a.id);
          if (!fresh || ['scored', 'validated'].includes(fresh.status)) return null;
          return store.update('assessments', a.id, { assessor_id: nextAssessor });
        });
        if (moved) reassigned.push(moved);
      }
      if (reassigned.length) {
        try {
          await bulkInsert(store, 'audit_log', reassigned.map((a) => ({
            actor_id: auth.user.id, actor_name: auth.user.name || 'admin',
            action: 'assessment_reassigned', entity: 'assessments', entity_id: a.id,
            message: nextAssessor ? 'Assessor allocation updated from the candidate record' : 'Assessor unassigned from the candidate record',
          })));
        } catch { /* audit must never break the request */ }
      }
    }
    await audit(store, auth.user, 'candidate_updated', 'candidates', params.id, `Candidate "${updated.name}" updated`
      + (reassigned.length ? ` (${reassigned.length} open assessment${reassigned.length === 1 ? '' : 's'} moved to the new assessor)` : ''));
    return ok({ ...updated, reassigned_assessments: reassigned.length });
  });

  // Password-gated destructive delete. The signed-in admin must re-enter
  // their own password; the delete then cascades over everything that hangs
  // off the candidate so no orphaned login or draft data is left behind:
  //   candidate -> open (unscored) assessments + their draft responses
  //             -> linked portal user(s) + their live sessions
  // Candidates with FINALIZED (scored/validated) reports are protected.
  route('DELETE', '/admin/candidates/:id', A, async ({ store, params, auth, body }) => {
    const c = await store.get('candidates', params.id);
    if (!c) return notFound('Candidate not found.');
    if (!body?.password || typeof body.password !== 'string')
      return forbidden('Admin password is required to delete a candidate.');
    if (!(await verifyPasswordAsync(body.password, auth.user.password_hash)))
      return forbidden('Incorrect admin password — deletion cancelled.');

    const assessments = await store.list('assessments', { candidate_id: params.id }, { detached: false });
    if (assessments.some((a) => ['scored', 'validated'].includes(a.status)))
      return conflict('This candidate has finalized assessment reports and cannot be deleted.');

    // The portal login goes first so an exam the candidate has open cannot
    // keep writing (every candidate route re-resolves the session), then each
    // paper is removed under its own assessment lock so an in-flight /next or
    // autosave cannot interleave with the cascade and leave an orphan row.
    const users = await store.list('users', { candidate_id: params.id });
    for (const u of users) {
      await bulkRemove(store, 'sessions', (await store.list('sessions', { user_id: u.id })).map((s) => s.id));
    }
    await bulkRemove(store, 'users', users.map((u) => u.id));
    let removedAssessments = 0;
    for (const a of assessments) {
      await withLock(`assessment:${a.id}`, async () => {
        await bulkRemove(store, 'responses', (await store.list('responses', { assessment_id: a.id })).map((r) => r.id));
        await bulkRemove(store, 'recordings', (await store.list('recordings', { assessment_id: a.id })).map((r) => r.id));
        await store.remove('assessments', a.id);
      });
      removedAssessments += 1;
    }
    await store.remove('candidates', params.id);

    const cascade = [
      removedAssessments ? `${removedAssessments} open assessment(s)` : '',
      users.length ? `portal user(s) ${users.map((u) => `"${u.username}"`).join(', ')}` : '',
    ].filter(Boolean).join(' and ');
    await audit(store, auth.user, 'candidate_deleted', 'candidates', params.id,
      `Candidate "${c.name}" deleted${cascade ? ` (also removed ${cascade})` : ''}`);
    return ok({ ok: true, removed_users: users.length, removed_assessments: removedAssessments });
  });

  // ------------------------------------------------ users & access
  route('GET', '/admin/users', A, async ({ store, query }) => {
    const users = (await store.list('users')).map(publicUser);
    const candidates = await store.list('candidates');
    const cname = Object.fromEntries(candidates.map((c) => [c.id, c.name]));
    users.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    const page = paginate(users, query, null);
    return ok({
      users: page.rows.map((u) => ({ ...u, candidate_name: cname[u.candidate_id] || null })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  });

  route('POST', '/admin/users', A, async ({ store, body, auth }) => {
    const miss = missing(body, ['username', 'name', 'role', 'password']);
    if (miss.length) return bad(`Missing: ${miss.join(', ')}`);
    if (!USER_ROLES.includes(body.role)) return bad(`Role must be one of: ${USER_ROLES.join(', ')}`);
    const structured = textField(body, ['name', 'email']);
    if (structured) return bad(`User ${structured} must be plain text.`);
    if (!str(body.name)) return bad('Missing: name');
    const emailProblem = emailError(body.email);
    if (emailProblem) return bad(emailProblem);
    const countProblem = questionCountError(body.question_count);
    if (countProblem) return bad(countProblem);
    const username = str(body.username, 100).toLowerCase();
    if (!/^[a-z0-9._-]{3,}$/.test(username)) return bad('Username must be 3+ chars: a-z 0-9 . _ -');
    const passwordProblem = passwordError(body.password);
    if (passwordProblem) return bad(passwordProblem);
    // Username and candidate-link uniqueness are check-then-insert; a double
    // submit of the Add user form used to create two logins with one username
    // (and two portal users for one candidate). User creation is rare enough
    // that one lock for the whole route is the simplest correct answer.
    return withLock('users:create', async () => {
    if ((await store.list('users', { username })).length) return conflict('Username already exists.');
    let candidate_id = null;
    if (body.role === 'candidate') {
      if (!body.candidate_id) return bad('A candidate record must be linked for candidate users.');
      const c = await store.get('candidates', body.candidate_id);
      if (!c) return bad('Linked candidate not found.');
      if ((await store.list('users', { candidate_id: c.id })).length) return conflict('That candidate already has a portal user.');
      candidate_id = c.id;
    }
    const rec = await store.insert('users', {
      username, name: str(body.name, 120), email: str(body.email, 200), role: body.role,
      password_hash: await hashPasswordAsync(body.password), candidate_id, active: true, created_by: auth.user.id,
    });
    await audit(store, auth.user, 'user_created', 'users', rec.id, `User "${username}" (${body.role}) created`);

    // Every candidate-role user is auto-allocated the default 50-question
    // assessment for their track, so onboarding never needs a manual Allocate
    // step per candidate. Best-effort: a skip (no track, empty bank, or an
    // open assessment already on that track) is reported in the response, and
    // provisioning itself never fails because of it. Pass
    // `{ auto_allocate: false }` (or `{ skip_auto_allocation: true }`) to
    // provision the login only; `role_id` / `assessor_id` / `question_count`
    // optionally steer the automatic paper.
    let auto_allocation = null;
    if (rec.role === 'candidate') {
      const enabled = body.auto_allocate !== false && body.auto_allocate !== 'false'
        && body.skip_auto_allocation !== true && body.skip_auto_allocation !== 'true';
      if (!enabled) {
        auto_allocation = { allocated: false, skipped: true, reason: 'Automatic allocation was switched off for this user.' };
      } else {
        try {
          const candidate = await store.get('candidates', candidate_id);
          const result = await autoAllocateAssessment(store, candidate, {
            actor: auth.user,
            roleId: body.role_id || null,
            assessorId: body.assessor_id || null,
            questionCount: body.question_count ?? MAX_ASSESSMENT_QUESTIONS,
            auditFn: (action, entity, entity_id, message) => audit(store, auth.user, action, entity, entity_id, message),
          });
          auto_allocation = result.allocated
            ? {
              allocated: true, assessment_id: result.assessment.id,
              role_id: result.role.id, role_name: result.role.name,
              question_count: result.question_count,
              assessor_id: result.assessment.assessor_id || null,
            }
            : {
              allocated: false, reason: result.reason,
              ...(result.role ? { role_id: result.role.id, role_name: result.role.name } : {}),
              ...(result.assessment_id ? { assessment_id: result.assessment_id } : {}),
            };
        } catch {
          auto_allocation = { allocated: false, reason: 'Automatic allocation failed unexpectedly — allocate manually from the candidate record.' };
        }
      }
    }
    return created(auto_allocation ? { ...publicUser(rec), auto_allocation } : publicUser(rec));
    });
  });

  route('PATCH', '/admin/users/:id', A, async ({ store, body, params, auth }) => {
    const u = await store.get('users', params.id);
    if (!u) return notFound('User not found.');
    const structured = textField(body, ['name', 'email']);
    if (structured) return bad(`User ${structured} must be plain text.`);
    if (body.name !== undefined && !str(body.name)) return bad('User name is required.');
    const emailProblem = emailError(body.email);
    if (emailProblem) return bad(emailProblem);
    const patch = {};
    if (body.name !== undefined) patch.name = str(body.name, 120);
    if (body.email !== undefined) patch.email = str(body.email, 200);
    if (body.active !== undefined) patch.active = bool(body.active);
    if (body.password !== undefined && body.password !== '') {
      const passwordProblem = passwordError(body.password);
      if (passwordProblem) return bad(passwordProblem);
      patch.password_hash = await hashPasswordAsync(body.password);
    }
    if (body.candidate_id !== undefined && u.role === 'candidate') {
      if (!body.candidate_id) return bad('Candidate users must be linked to a candidate record.');
      const linkedCandidate = await store.get('candidates', body.candidate_id);
      if (!linkedCandidate) return bad('Linked candidate not found.');
      const alreadyLinked = (await store.list('users', { candidate_id: body.candidate_id }))
        .find((row) => row.id !== u.id);
      if (alreadyLinked) return conflict('That candidate already has a portal user.');
      patch.candidate_id = body.candidate_id;
    }
    if (u.username === 'admin' && patch.active === false) return bad('The primary admin account cannot be deactivated.');
    // An admin deactivating their own login is locked out the moment the
    // response lands (every session check requires an active user), and with
    // no other admin there is nobody left to undo it. Refuse the self-lockout.
    if (u.id === auth.user.id && patch.active === false) return bad('You cannot deactivate your own account.');
    const updated = await store.update('users', params.id, patch);
    // A password reset is what an admin reaches for when a login is
    // compromised, and deactivating is how they shut one out — neither is
    // done if the tokens already issued keep working. Revoke every session
    // of a user whose password changed or whose account was switched off
    // (reactivating later starts from zero live sessions rather than
    // resurrecting the ones that were revoked). The admin resetting their
    // OWN password keeps the session they are using; their other devices
    // are signed out like anyone else's.
    const passwordChanged = patch.password_hash !== undefined;
    const switchedOff = patch.active === false && u.active !== false;
    if (passwordChanged || switchedOff) {
      const sessions = await store.list('sessions', { user_id: u.id });
      const keep = u.id === auth.user.id ? auth.session.id : null;
      await Promise.all(sessions
        .filter((sess) => sess.id !== keep)
        .map((sess) => store.remove('sessions', sess.id).catch(() => {})));
    }
    await audit(store, auth.user, 'user_updated', 'users', params.id, `User "${u.username}" updated`);
    return ok(publicUser(updated));
  });

  // ------------------------------------------------ roles (assessment tracks)
  route('GET', '/admin/roles', A, async ({ store }) => {
    const [roles, comps, questions, assessments] = await Promise.all([
      store.list('roles'), store.list('competencies'), store.list('questions'), store.list('assessments', {}, { detached: false }),
    ]);
    roles.sort((a, b) => a.name.localeCompare(b.name));
    return ok({
      roles: roles.map((r) => ({
        ...r,
        competency_count: comps.filter((c) => c.role_id === r.id).length,
        question_count: questions.filter((q) => q.role_id === r.id).length,
        assessment_count: assessments.filter((a) => a.role_id === r.id).length,
      })),
    });
  });

  route('POST', '/admin/roles', A, async ({ store, body, auth }) => {
    const miss = missing(body, ['key', 'name', 'technology']);
    if (miss.length) return bad(`Missing: ${miss.join(', ')}`);
    const structured = textField(body, ['name', 'technology', 'description']);
    if (structured) return bad(`Role ${structured} must be plain text.`);
    const key = str(body.key, 60).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) return bad('Key must be a slug like databricks-rsa.');
    // The uniqueness check and the insert are one step per key (shared with
    // the published-track install), so a double submit cannot create twins.
    return withLock(`role-key:${key}`, async () => {
      if ((await store.list('roles', { key })).length) return conflict('A role with this key already exists.');
      const rec = await store.insert('roles', {
        key, name: str(body.name, 120), technology: str(body.technology, 120),
        description: str(body.description, 2000), active: true,
      });
      await store.insert('frameworks', {
        role_id: rec.id, name: 'ECOD Readiness Framework v1', config: DEFAULT_FRAMEWORK_CONFIG, active: true,
      });
      await audit(store, auth.user, 'role_created', 'roles', rec.id, `Role "${rec.name}" created`);
      return created(rec);
    });
  });

  route('PATCH', '/admin/roles/:id', A, async ({ store, body, params, auth }) => {
    const r = await store.get('roles', params.id);
    if (!r) return notFound('Role not found.');
    const structured = textField(body, ['name', 'technology', 'description']);
    if (structured) return bad(`Role ${structured} must be plain text.`);
    // Creation requires a name; an edit must not be able to blank it (the role
    // then renders as an unnamed track everywhere it is listed).
    if (body.name !== undefined && !str(body.name)) return bad('Role name is required.');
    const patch = {};
    for (const f of ['name', 'technology', 'description']) if (body[f] !== undefined) patch[f] = str(body[f], f === 'description' ? 2000 : 120);
    if (body.active !== undefined) patch.active = bool(body.active);
    const updated = await store.update('roles', params.id, patch);
    await audit(store, auth.user, 'role_updated', 'roles', params.id, `Role "${updated.name}" updated`);
    return ok(updated);
  });

  route('DELETE', '/admin/roles/:id', A, async ({ store, params, auth }) => {
    const r = await store.get('roles', params.id);
    if (!r) return notFound('Role not found.');
    if ((await store.list('assessments', { role_id: params.id }, { detached: false })).length)
      return conflict('Assessments exist for this role. Deactivate it instead of deleting.');
    for (const table of ['questions', 'competencies', 'frameworks']) {
      await bulkRemove(store, table, (await store.list(table, { role_id: params.id })).map((r) => r.id));
    }
    // Candidates pointed at the track would otherwise keep a dangling
    // target_role_id: the list shows a blank track and auto-allocation for
    // them fails with "no track" instead of falling back to the workspace
    // default.
    const pointed = await store.list('candidates', { target_role_id: params.id });
    await bulkUpdate(store, 'candidates', pointed.map((c) => ({ id: c.id, patch: { target_role_id: null } })));
    await store.remove('roles', params.id);
    await audit(store, auth.user, 'role_deleted', 'roles', params.id, `Role "${r.name}" deleted`);
    return ok({ ok: true });
  });

  route('GET', '/admin/roles/:id', A, async ({ store, params }) => {
    const role = await store.get('roles', params.id);
    if (!role) return notFound('Role not found.');
    const [comps, questions, frameworks] = await Promise.all([
      store.list('competencies', { role_id: role.id }),
      store.list('questions', { role_id: role.id }),
      store.list('frameworks', { role_id: role.id }),
    ]);
    comps.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    questions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return ok({ role, competencies: comps, questions, framework: frameworks.find((f) => f.active !== false) || null });
  });

  // ------------------------------------------------ competencies
  /**
   * The gap map subtracts the observed level (a whole 1-5) from this target,
   * and the severity cutoffs are whole levels too — a target of 2.5 produced
   * half-level gaps that matched neither cutoff the way the editor promised.
   */
  const targetLevelError = (value) => {
    const level = num(value, NaN);
    return Number.isInteger(level) && level >= 1 && level <= 5 ? null : 'Target level must be a whole number from 1 to 5.';
  };
  function validateCompetency(body) {
    if (!str(body.name)) return 'Competency name is required.';
    if (body.weight !== undefined && (num(body.weight, -1) < 0 || num(body.weight) > 100)) return 'Weight must be 0-100.';
    if (body.target_level !== undefined && targetLevelError(body.target_level)) return targetLevelError(body.target_level);
    return null;
  }

  route('POST', '/admin/competencies', A, async ({ store, body, auth }) => {
    if (!body.role_id || !(await store.get('roles', body.role_id))) return bad('A valid role is required.');
    const structured = textField(body, Object.keys(COMPETENCY_TEXT_FIELDS));
    if (structured) return bad(`Competency ${structured} must be plain text.`);
    const problem = validateCompetency(body);
    if (problem) return bad(problem);
    // Keys are unique per track (the catalogue sync matches by key); the lock
    // keeps two simultaneous creates from both taking the same one.
    return withLock(`competencies:${body.role_id}`, async () => {
      const taken = new Set((await store.list('competencies', { role_id: body.role_id })).map((x) => x.key));
      const explicitKey = str(body.key, COMPETENCY_TEXT_FIELDS.key);
      if (explicitKey && taken.has(explicitKey)) return conflict('Another competency in this track already uses that key.');
      const rec = await store.insert('competencies', {
        role_id: body.role_id,
        key: explicitKey || derivedCompetencyKey(body.name, taken),
        name: str(body.name, COMPETENCY_TEXT_FIELDS.name),
        category: str(body.category, COMPETENCY_TEXT_FIELDS.category) || 'technical',
        description: str(body.description, COMPETENCY_TEXT_FIELDS.description),
        enrichment_hint: str(body.enrichment_hint, COMPETENCY_TEXT_FIELDS.enrichment_hint),
        weight: num(body.weight, 0), target_level: num(body.target_level, 4),
        order: num(body.order, 0), active: body.active !== undefined ? bool(body.active) : true,
      });
      await audit(store, auth.user, 'competency_created', 'competencies', rec.id, `Competency "${rec.name}" created`);
      return created(rec);
    });
  });

  route('PATCH', '/admin/competencies/:id', A, async ({ store, body, params, auth }) => {
    const c = await store.get('competencies', params.id);
    if (!c) return notFound('Competency not found.');
    const structured = textField(body, Object.keys(COMPETENCY_TEXT_FIELDS));
    if (structured) return bad(`Competency ${structured} must be plain text.`);
    if (body.name !== undefined && !str(body.name)) return bad('Competency name is required.');
    if (body.weight !== undefined && (num(body.weight, -1) < 0 || num(body.weight) > 100)) return bad('Weight must be 0-100.');
    if (body.target_level !== undefined && targetLevelError(body.target_level)) return bad(targetLevelError(body.target_level));
    const patch = {};
    for (const [f, max] of Object.entries(COMPETENCY_TEXT_FIELDS))
      if (body[f] !== undefined) patch[f] = str(body[f], max);
    for (const f of ['weight', 'target_level', 'order']) if (body[f] !== undefined) patch[f] = num(body[f], c[f]);
    if (body.active !== undefined) patch.active = bool(body.active);
    // The key identifies the competency to the published catalogue sync, which
    // finds competencies by key and creates any it cannot find. A blank key
    // used to be accepted, and the next sync added a second, empty copy of
    // the competency (on RSA: 8 competencies, weights summing to 118).
    if (patch.key !== undefined) {
      if (!patch.key) return bad('Competency key cannot be blank.');
      if (patch.key === c.key) delete patch.key;
    }
    const apply = async () => {
      if (patch.key !== undefined) {
        const role = await store.get('roles', c.role_id);
        if (isCatalogueCompetency(role, c)) {
          return conflict(`"${c.name}" comes from the published ${role.name} catalogue. Its key links it to the catalogue sync and cannot be changed.`);
        }
        const siblings = await store.list('competencies', { role_id: c.role_id });
        if (siblings.some((x) => x.id !== c.id && x.key === patch.key)) {
          return conflict('Another competency in this track already uses that key.');
        }
      }
      const updated = await store.update('competencies', params.id, patch);
      await audit(store, auth.user, 'competency_updated', 'competencies', params.id, `Competency "${updated.name}" updated`);
      return ok(updated);
    };
    return patch.key !== undefined ? withLock(`competencies:${c.role_id}`, apply) : apply();
  });

  route('DELETE', '/admin/competencies/:id', A, async ({ store, params, auth }) => {
    const c = await store.get('competencies', params.id);
    if (!c) return notFound('Competency not found.');
    await bulkRemove(store, 'questions', (await store.list('questions', { competency_id: params.id })).map((q) => q.id));
    await store.remove('competencies', params.id);
    await audit(store, auth.user, 'competency_deleted', 'competencies', params.id, `Competency "${c.name}" (and its questions) deleted`);
    return ok({ ok: true });
  });

  // ------------------------------------------------ question bank
  const validateQuestion = (body) => {
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

  route('GET', '/admin/questions', A, async ({ store, query }) => {
    let rows = await store.list('questions');
    if (query.role_id) rows = rows.filter((q) => q.role_id === query.role_id);
    if (query.competency_id) rows = rows.filter((q) => q.competency_id === query.competency_id);
    const comps = await store.list('competencies');
    const cname = Object.fromEntries(comps.map((c) => [c.id, c.name]));
    rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const page = paginate(rows, { ...query, limit: query.limit || 500 }, null);
    return ok({
      questions: page.rows.map((q) => ({ ...q, competency_name: cname[q.competency_id] || '' })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  });

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
  const duplicatePromptInRole = async (store, roleId, prompt, exceptId = null) => {
    const key = promptKey(prompt);
    if (!key) return null;
    const rows = await store.list('questions', { role_id: roleId });
    return rows.find((q) => q.id !== exceptId && promptKey(q.prompt) === key) || null;
  };

  route('POST', '/admin/questions', A, async ({ store, body, auth }) => {
    if (!body.role_id || !(await store.get('roles', body.role_id))) return bad('A valid role is required.');
    const comp = body.competency_id ? await store.get('competencies', body.competency_id) : null;
    if (!comp) return bad('A valid competency is required.');
    if (comp.role_id !== body.role_id) return bad('Competency must belong to the selected role.');
    const problem = validateQuestion(body);
    if (problem) return bad(problem);
    // The duplicate-prompt rule is a check-then-insert; a double-clicked Save
    // used to put the same question in the bank twice. One step per role.
    return withLock(`questions:${body.role_id}`, async () => {
      if (await duplicatePromptInRole(store, body.role_id, body.prompt)) {
        return conflict('A question with this prompt already exists for this role. Edit the existing question instead of adding a second copy.');
      }
      const rec = await store.insert('questions', normalizeQuestion(body));
      await audit(store, auth.user, 'question_created', 'questions', rec.id, `Question added (${rec.type})`);
      return created(rec);
    });
  });

  route('PATCH', '/admin/questions/:id', A, async ({ store, body, params, auth }) => {
    const q = await store.get('questions', params.id);
    if (!q) return notFound('Question not found.');
    const merged = { ...q, ...body, type: body.type || q.type };
    if (!merged.role_id || !(await store.get('roles', merged.role_id))) return bad('A valid role is required.');
    const comp = merged.competency_id ? await store.get('competencies', merged.competency_id) : null;
    if (!comp) return bad('A valid competency is required.');
    if (comp.role_id !== merged.role_id) return bad('Competency must belong to the selected role.');
    const problem = validateQuestion(merged);
    if (problem) return bad(problem);
    // Renaming one question onto another's prompt would put the same question
    // in the bank twice — refused for the same reason as the create path.
    if (await duplicatePromptInRole(store, merged.role_id, merged.prompt, params.id)) {
      return conflict('Another question for this role already uses this prompt.');
    }
    const rec = await store.update('questions', params.id, normalizeQuestion(merged, q));
    await audit(store, auth.user, 'question_updated', 'questions', params.id, 'Question updated');
    return ok(rec);
  });

  route('DELETE', '/admin/questions/:id', A, async ({ store, params, auth }) => {
    const q = await store.get('questions', params.id);
    if (!q) return notFound('Question not found.');
    await store.remove('questions', params.id);
    await audit(store, auth.user, 'question_deleted', 'questions', params.id, 'Question deleted');
    return ok({ ok: true });
  });

  // ------------------------------------------------ assessment framework
  route('GET', '/admin/frameworks', A, async ({ store, query }) => {
    if (!query.role_id || typeof query.role_id !== 'string') return bad('role_id is required.');
    // A track that does not exist has no framework, default or otherwise; the
    // route used to answer with an "unsaved default" for any string at all.
    if (!(await store.get('roles', query.role_id))) return notFound('Role not found.');
    const rows = await store.list('frameworks', { role_id: query.role_id });
    const active = rows.find((f) => f.active !== false);
    return ok({ framework: active || { role_id: query.role_id, name: 'ECOD Readiness Framework v1', config: DEFAULT_FRAMEWORK_CONFIG, unsaved: true } });
  });

  route('PUT', '/admin/frameworks', A, async ({ store, body, auth }) => {
    if (!body.role_id || !(await store.get('roles', body.role_id))) return bad('A valid role is required.');
    if (body.name !== undefined && !isTextish(body.name)) return bad('Framework name must be plain text.');
    const problems = validateFrameworkConfig(body.config);
    if (problems.length) return unprocessable('Invalid framework configuration.', { problems });
    // Validation accepts numeric strings (a form posts "80"), so store the
    // numbers the validator actually checked: the scoring engine compares and
    // sorts on these, and the editor re-renders them. Only the fields the
    // engine and the report card read are stored — the config is copied into
    // every assessment snapshot, so an arbitrary extra payload would be
    // duplicated into each paper allocated against the track.
    const config = {
      readiness_bands: body.config.readiness_bands.map((b) => ({
        key: b.key.trim(),
        label: b.label.trim(),
        min: Number(b.min),
        ...(typeof b.tone === 'string' && b.tone ? { tone: str(b.tone, 20) } : {}),
        ...(typeof b.description === 'string' ? { description: b.description.trim() } : {}),
      })),
      level_thresholds: body.config.level_thresholds.map(Number),
      gap_severity: {
        moderate: Number(body.config.gap_severity.moderate),
        critical: Number(body.config.gap_severity.critical),
      },
    };
    const rows = await store.list('frameworks', { role_id: body.role_id });
    const active = rows.find((f) => f.active !== false);
    let rec;
    if (active) rec = await store.update('frameworks', active.id, { name: str(body.name, 120) || active.name, config });
    else rec = await store.insert('frameworks', { role_id: body.role_id, name: str(body.name, 120) || 'ECOD Readiness Framework v1', config, active: true });
    await audit(store, auth.user, 'framework_updated', 'frameworks', rec.id, `Framework for role updated`);
    return ok(rec);
  });

  // ------------------------------------------------ assessments & allocation
  route('GET', '/admin/assessments', A, async ({ store, query }) => {
    // Small columns only: the papers stay in their own objects (one fetch per
    // row would make this listing cost every paper ever allocated).
    let rows = await store.list('assessments', {}, { detached: false });
    if (query.status) rows = rows.filter((a) => a.status === query.status);
    if (query.assessor_id) rows = rows.filter((a) => a.assessor_id === query.assessor_id);
    if (query.role_id) rows = rows.filter((a) => a.role_id === query.role_id);
    const [candidates, users, roles] = await Promise.all([store.list('candidates'), store.list('users'), store.list('roles')]);
    const cmap = Object.fromEntries(candidates.map((c) => [c.id, c]));
    const uname = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const rname = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const page = paginate(rows, query, null);
    const facts = await paperFacts(store, page.rows);
    return ok({
      assessments: page.rows.map((a, i) => ({
        id: a.id, status: a.status, created_at: a.created_at, started_at: a.started_at,
        submitted_at: a.submitted_at, scored_at: a.scored_at, overall_pct: a.overall_pct,
        readiness_key: a.readiness_key, readiness_label: a.readiness_label,
        candidate_id: a.candidate_id, candidate_name: cmap[a.candidate_id]?.name || '(deleted)',
        role_id: a.role_id, role_name: rname[a.role_id] || '(deleted)',
        assessor_id: a.assessor_id, assessor_name: uname[a.assessor_id] || null,
        question_count: facts[i].question_count,
        question_limit: facts[i].question_limit,
        bank_total: facts[i].bank_total,
        integrity_count: Object.values(a.quiz_state?.integrity || {}).reduce((s, v) => s + Number(v || 0), 0),
        last_integrity_event: a.quiz_state?.events?.length
          ? a.quiz_state.events[a.quiz_state.events.length - 1].event
          : null,
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  });

  // How many questions a given role would serve for a chosen cap, and how they
  // spread across competencies. Lets the admin UI preview an allocation before
  // committing to it — same code path the snapshot builder uses.
  route('GET', '/admin/roles/:id/question-plan', A, async ({ store, params, query }) => {
    const bank = await roleBank(store, params.id);
    if (!bank) return notFound('Role not found or inactive.');
    const raw = query.limit;
    const limit = raw === undefined || raw === '' ? null : Number(raw);
    if (raw !== undefined && raw !== '' && (!Number.isInteger(limit) || limit < 1))
      return bad('limit must be a whole number of 1 or more.');
    // Preview requests are clamped rather than rejected so an old/bookmarked
    // request above the bank size still resolves to the available bank. When a
    // role has more than the product maximum, the preview never promises more
    // than the 50-question allocation cap.
    const previewLimit = limit === null ? null : Math.min(limit, MAX_ASSESSMENT_QUESTIONS);
    // Catalogue context: when this track has a published catalogue with
    // questions and the bank is smaller than the allocation cap, the UI can
    // offer a one-click top-up instead of leaving the admin stuck below the cap.
    const catalogueEntry = catalogueForRoleKey(bank.role.key);
    const catalogue = catalogueEntry && catalogueEntry.questions.length
      ? {
          total: catalogueEntry.questions.length,
          missing: catalogueMissing(await store.list('questions', { role_id: bank.role.id }), bank.role.key),
        }
      : null;
    return ok({
      role: { id: bank.role.id, name: bank.role.name },
      max_questions: MAX_ASSESSMENT_QUESTIONS,
      catalogue,
      ...allocationPreview(bank.questions, bank.competencies, previewLimit),
    });
  });

  // ------------------------------------------------ question bank
  // The module-structured bank: modules, families and the fixed per-module
  // paper shape. Every route is scoped by `role_key` (query or body); the
  // default is the historical RSA bank, so unscoped calls behave exactly as
  // before banks were role-aware. A role key without a published module bank
  // is a 400, not an empty bank.
  const roleKeyOf = (src) => {
    const key = (src && (src.role_key || src.roleKey)) || '';
    return key || DEFAULT_MODULE_BANK_ROLE_KEY;
  };
  const requireBank = (roleKey) => moduleBankFor(roleKey) || null;

  // The published catalogue in src/content is generated and read-only, so
  // every read below goes through effectiveBank(), which merges it with the
  // admin-authored questions in the `bank_questions` table. One source of
  // truth for the tree, the drill-down, the plan, the preview and generation.
  const bankContext = async (store, roleKey) => {
    const questions = await effectiveBank(store, roleKey);
    return { questions, modules: composeModules(questions, roleKey), families: composeFamilies(questions, roleKey) };
  };

  route('GET', '/admin/question-bank/modules', A, async ({ store, query }) => {
    const roleKey = roleKeyOf(query);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const includeOptional = bool(query.include_optional);
    const { questions, modules } = await bankContext(store, roleKey);

    const optionalByFamily = new Map();
    const optionalByModule = new Map();
    if (includeOptional && bank.optional) {
      for (const q of bank.optional.questions) {
        optionalByFamily.set(q.family_id, (optionalByFamily.get(q.family_id) || 0) + 1);
        optionalByModule.set(q.module, (optionalByModule.get(q.module) || 0) + 1);
      }
    }

    const technicalCount = bank.modules.filter((m) => m.technical === true).length;
    return ok({
      role_key: roleKey,
      role_name: bank.role_name,
      version: bank.version,
      blueprint: blueprintFor(bank.modules),
      // How many modules the paper-wide blueprint totals are spread across,
      // so a client can show the per-module quota without hardcoding it.
      technical_modules: technicalCount,
      non_technical_modules: bank.modules.length - technicalCount,
      groups: bank.groups,
      modules: modules.map((m) => {
        const own = m.families.map((f) => ({ ...f, optional: optionalByFamily.get(f.id) || 0 }));
        // Legacy families are appended after the curated ones so the tree shows
        // where retired questions live without implying they are the default
        // place to add a new question. Their members are all optional, so
        // `objective`/`open` describe what the family holds while `optional`
        // carries the same total - otherwise the row would read 0/0.
        const legacy = includeOptional && bank.optional
          ? bank.optional.families.filter((f) => f.module === m.key).map((f) => ({
              ...f, optional: optionalByFamily.get(f.id) || 0,
            }))
          : [];
        return { ...m, optional: optionalByModule.get(m.key) || 0, families: [...own, ...legacy] };
      }),
      // Totals describe what generation can actually draw; deactivated and
      // removed questions are reported separately instead of padding the
      // headline. All three are derived from the effective bank (published
      // minus removals, plus authored) so they cannot disagree with the tree.
      bank_total: questions.filter(isActive).length,
      published_total: questions.filter((q) => !q.authored && isActive(q)).length,
      authored_total: questions.filter((q) => q.authored && isActive(q)).length,
      inactive_total: questions.filter((q) => !isActive(q)).length,
      family_total: composeFamilies(questions, roleKey).length,
      optional: bank.optional ? bank.optional.summary : { total: 0, families: 0, modules: [] },
    });
  });

  // One family's questions, so an admin can review a family before adding to
  // it. Families are addressed by their compound `<MODULE>:<slug>` id.
  route('GET', '/admin/question-bank/families/:id', A, async ({ store, params, query }) => {
    const roleKey = roleKeyOf(query);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const { questions } = await bankContext(store, roleKey);
    const family = resolveFamily(params.id, questions, roleKey)
      || (bank.optional ? bank.optional.families.find((f) => f.id === params.id) : null)
      || null;
    if (!family) return notFound('Family not found.');
    const optionalQuestions = bank.optional ? bank.optional.questions : [];
    const rows = [...questions, ...optionalQuestions].filter((q) => q.family_id === family.id);
    return ok({
      family,
      questions: rows.map((q) => ({
        id: q.id, type: q.type, prompt: q.prompt,
        difficulty: q.difficulty, band: q.band, minutes: q.minutes,
        optional: q.optional === true,
        authored: q.authored === true,
        active: isActive(q),
        removed: q.removed === true,
        tags: q.tags || [],
        needs_option_review: q.needs_option_review === true,
      })),
    });
  });

  // What a generated paper would look like, and whether every module can meet
  // its quota - the module-based equivalent of /roles/:id/question-plan.
  route('GET', '/admin/question-bank/plan', A, async ({ store, query }) => {
    const roleKey = roleKeyOf(query);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const { questions } = await bankContext(store, roleKey);
    const optionalQuestions = bank.optional ? bank.optional.questions : [];
    return ok(testPlan({ modules: bank.modules, questions: [...questions, ...optionalQuestions] }));
  });

  // Draw a sample paper so an admin can inspect the structure before relying
  // on it. Never persisted - allocation builds its own paper.
  route('POST', '/admin/question-bank/preview', A, async ({ store, body }) => {
    const roleKey = roleKeyOf(body);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const { questions } = await bankContext(store, roleKey);
    const optionalQuestions = bank.optional ? bank.optional.questions : [];
    const result = generateTest({
      modules: bank.modules,
      questions: [...questions, ...optionalQuestions],
    });
    return ok({
      counts: result.counts,
      blueprint: result.blueprint,
      warnings: result.warnings,
      sections: result.sections,
      questions: result.questions.map((q) => ({
        id: q.id, module: q.module, family_id: q.family_id, family: q.family, type: q.type,
        prompt: q.prompt, optional: q.optional === true, authored: q.authored === true,
      })),
    });
  });

  // ---- authoring: add one question ------------------------------------
  // Validated by exactly the same code the bulk import uses, so the two can
  // never diverge on what counts as a usable question.
  // Authored ids are sequential per module (`RSA-T01-A007`) and the store
  // keys rows by id, so the allocate-then-insert must be atomic per bank: two
  // admins saving at once used to both compute A007 and the second insert
  // silently OVERWROTE the first question (both got a 201). The prompt
  // duplicate check has the same read-then-write shape and is covered by the
  // same lock. (The bulk import below goes through the same lock.)
  route('POST', '/admin/question-bank/questions', A, async ({ store, body, auth }) => {
    const roleKey = roleKeyOf(body);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    return withLock(`bank:${roleKey}`, async () => {
      const { questions, families } = await bankContext(store, roleKey);
      const result = validateBankQuestion(body, { modules: bank.modules, families });
      if (!result.ok) return unprocessable('This question is not valid.', { errors: result.errors });

      const key = promptKey(result.question.prompt);
      if (questions.some((q) => promptKey(q.prompt) === key)) {
        return conflict('A question with this prompt already exists in the bank.');
      }

      const id = nextAuthoredId(result.question.module, await store.list('bank_questions'), roleKey);
      const rec = await store.insert('bank_questions', toStoredRecord(result.question, { id, actorId: auth.user.id, roleKey }));
      await audit(store, auth.user, 'bank_question_created', 'bank_questions', rec.id,
        `Question added to ${rec.module} / ${rec.family}`);
      return created({ question: hydrate(rec) });
    });
  });

  route('PATCH', '/admin/question-bank/questions/:id', A, async ({ store, body, params, query, auth }) => {
    const roleKey = roleKeyOf(query);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const existing = (await store.list('bank_questions'))
      .find((q) => q.id === params.id && (q.role_key || DEFAULT_MODULE_BANK_ROLE_KEY) === roleKey);
    if (!existing) {
      // Published questions are read-only except for visibility: an admin can
      // remove one from circulation ({ active: false }) and restore it later
      // ({ active: true }). Anything else is rejected, not silently ignored.
      const published = bank.questions.find((q) => q.id === params.id);
      if (!published) return notFound('Question not found.');
      if (body.active === undefined) {
        return bad('Published questions are read-only; only visibility (active) can be changed. Remove it to hide it from tests, or restore it.');
      }
      const extra = Object.keys(body || {}).filter((k) => k !== 'active');
      if (extra.length) return bad(`Published questions are read-only; cannot change: ${extra.join(', ')}.`);
      const restore = bool(body.active);
      await setPublishedVisibility(store, params.id, restore, auth.user.id, roleKey);
      await audit(store, auth.user, restore ? 'bank_question_restored' : 'bank_question_removed',
        'bank_questions', params.id,
        restore
          ? `Published question restored to ${published.module}`
          : `Published question removed from ${published.module} (can be restored)`);
      const updated = (await effectiveBank(store, roleKey)).find((q) => q.id === params.id);
      return ok({ question: updated });
    }
    const { questions, families } = await bankContext(store, roleKey);
    const merged = mergeForPatch(hydrate(existing), body);
    const result = validateBankQuestion(merged, { modules: bank.modules, families });
    if (!result.ok) return unprocessable('This question is not valid.', { errors: result.errors });

    const key = promptKey(result.question.prompt);
    if (questions.some((q) => q.id !== params.id && promptKey(q.prompt) === key)) {
      return conflict('Another question already uses this prompt.');
    }
    const patch = toStoredRecord(result.question, { id: params.id, actorId: existing.created_by, roleKey });
    // `toStoredRecord` describes a freshly authored row (active, randomizable);
    // an edit must keep the row's own flags unless the request changes them —
    // fixing a typo on a deactivated question used to put it back into
    // circulation.
    patch.active = body.active !== undefined ? bool(body.active) : existing.active !== false;
    patch.randomizable = body.randomizable !== undefined ? bool(body.randomizable) : existing.randomizable !== false;
    const rec = await store.update('bank_questions', params.id, patch);
    await audit(store, auth.user, 'bank_question_updated', 'bank_questions', params.id, 'Question updated');
    return ok({ question: hydrate(rec) });
  });

  route('DELETE', '/admin/question-bank/questions/:id', A, async ({ store, params, query, auth }) => {
    const roleKey = roleKeyOf(query);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const existing = (await store.list('bank_questions'))
      .find((q) => q.id === params.id && (q.role_key || DEFAULT_MODULE_BANK_ROLE_KEY) === roleKey);
    if (existing) {
      await store.remove('bank_questions', params.id);
      await audit(store, auth.user, 'bank_question_deleted', 'bank_questions', params.id,
        `Question removed from ${existing.module}`);
      return ok({ ok: true });
    }
    // Published questions live in a generated file, so DELETE removes them
    // from circulation (hidden from counts and generation) rather than
    // destroying anything — restoring is PATCH { active: true }.
    const published = bank.questions.find((q) => q.id === params.id);
    if (!published) return notFound('Question not found.');
    await setPublishedVisibility(store, params.id, false, auth.user.id, roleKey);
    await audit(store, auth.user, 'bank_question_removed', 'bank_questions', params.id,
      `Published question removed from ${published.module} (can be restored)`);
    return ok({ ok: true, removed: true });
  });

  // ---- authoring: bulk import from a spreadsheet -----------------------
  // Accepts a base64 .xlsx or raw .csv text. `dry_run` validates and reports
  // without writing, which is what the UI calls first so an admin sees the
  // per-row outcome before committing.
  route('POST', '/admin/question-bank/import', A, async ({ store, body, auth }) => {
    const roleKey = roleKeyOf(body);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    let parsed;
    try {
      parsed = readImportPayload(body);
    } catch (err) {
      return bad(err.message);
    }
    if (!parsed.rows.length) {
      return unprocessable('No data rows found. The first row must be a header (Module, Type, Prompt, ...).', {
        headers: parsed.headers,
      });
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      return unprocessable(`This file has ${parsed.rows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import.`);
    }

    const { questions, families } = await bankContext(store, roleKey);
    const report = validateBatch(parsed.rows, {
      modules: bank.modules, families, existingPrompts: questions.map((q) => q.prompt),
    });

    const dryRun = bool(body.dry_run);
    const summary = {
      headers: parsed.headers,
      total: parsed.rows.length,
      accepted: report.accepted.length,
      rejected: report.rejected.length,
      duplicates: report.duplicates.length,
      dry_run: dryRun,
      errors: report.rejected.slice(0, 50),
      duplicate_rows: report.duplicates.slice(0, 50),
      preview: report.accepted.slice(0, 10).map((a) => ({
        line: a.line, module: a.question.module, family: a.question.family,
        type: a.question.type, prompt: a.question.prompt.slice(0, 160),
      })),
    };
    if (dryRun) return ok({ ...summary, imported: 0 });

    // Ids are allocated against a list that grows as we insert, so a batch
    // cannot hand two questions the same id. The whole batch then lands in a
    // single store write (adapters' `insertMany`; loop fallback otherwise).
    // Same per-bank lock as single authoring: an import racing a save (or a
    // second import) must not allocate the same ids and overwrite rows.
    const imported = await withLock(`bank:${roleKey}`, async () => {
      const existingRows = await store.list('bank_questions');
      const allocated = [...existingRows];
      const batch = report.accepted.map(({ question }) => {
        const id = nextAuthoredId(question.module, allocated, roleKey);
        const rec = toStoredRecord(question, { id, actorId: auth.user.id, roleKey });
        allocated.push(rec);
        return rec;
      });
      if (batch.length) await bulkInsert(store, 'bank_questions', batch);
      return batch.length;
    });
    if (imported) {
      await audit(store, auth.user, 'bank_questions_imported', 'bank_questions', '',
        `${imported} question(s) imported from a spreadsheet`);
    }
    return ok({ ...summary, imported });
  });

  // A ready-to-fill template, so an admin never has to guess the columns.
  route('GET', '/admin/question-bank/import-template', A, async ({ query }) => {
    const roleKey = roleKeyOf(query);
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    return ok({
      filename: `ecod-question-import-template-${roleKey}.csv`,
      content_type: 'text/csv',
      columns: importColumnsFor(bank),
      csv: importTemplateCsv(bank),
    });
  });


  // ------------------------------------------------ published catalogue
  // The effective allocation ceiling is min(cap, bank size). These endpoints
  // let an admin top a small bank up to its published catalogue from inside
  // the app — the same sync `npm run seed` performs, available to deployments
  // (e.g. Netlify) where there is no CLI. Scoped by role_key (query or body);
  // the default is the historical RSA catalogue.
  route('GET', '/admin/content/catalogue', A, async ({ store, query }) =>
    ok(await catalogueStatus(store, roleKeyOf(query))));

  route('POST', '/admin/content/sync', A, async ({ store, body, auth }) => {
    const roleKey = roleKeyOf(body);
    const result = await syncCatalogue(store, roleKey);
    if (result.error) return bad(result.error);
    await audit(store, auth.user, 'catalogue_synced', 'questions', result.role_id,
      `Published catalogue synced: ${result.added} question(s) added, bank now ${result.bank_total}`);
    return ok(result);
  });

  // Published tracks as a whole. A workspace seeded before a track was
  // published has no role for it, so the sync above has nothing to attach to
  // and the track never appears under Roles & frameworks (while the static
  // module bank still shows it on the Question Bank screen). Listing shows
  // every published track with its install state; POST installs a missing one
  // — role, default framework, competencies and published questions — or
  // tops up an installed one. A deactivated track is refused (409), never
  // duplicated. Requires an explicit role_key: there is no sensible default
  // for "install".
  route('GET', '/admin/content/tracks', A, async ({ store }) =>
    ok({ tracks: await listCatalogues(store) }));

  route('POST', '/admin/content/tracks', A, async ({ store, body, auth }) => {
    const roleKey = str(body?.role_key || body?.roleKey, 60);
    if (!roleKey) return bad('Missing: role_key');
    if (!catalogueForRoleKey(roleKey)) return bad(`No published track matches role key "${roleKey}".`);
    // "Does this track exist yet?" + "create it" must be one step: two admins
    // pressing Add to workspace together used to get two roles with the same
    // key, each with its own 100-question bank and framework.
    const result = await withLock(`role-key:${roleKey}`, () => installCatalogue(store, roleKey));
    if (result.error) return result.code === 'inactive' ? conflict(result.error) : bad(result.error);
    if (result.created) {
      await audit(store, auth.user, 'track_installed', 'roles', result.role.id,
        `Published track "${result.role.name}" added: ${result.competencies_added} competencies, ${result.bank_total} questions`);
      return created(result);
    }
    await audit(store, auth.user, 'catalogue_synced', 'questions', result.role_id,
      `Published catalogue synced: ${result.added} question(s) added, bank now ${result.bank_total}`);
    return ok(result);
  });

  route('POST', '/admin/assessments', A, async (ctx) =>
    withLock(allocationLockKey(ctx.body?.candidate_id, ctx.body?.role_id), async () => {
      const { store, body, auth } = ctx;
    const miss = missing(body, ['candidate_id', 'role_id']);
    if (miss.length) return bad('candidate_id and role_id are required.');
    const candidate = await store.get('candidates', body.candidate_id);
    if (!candidate) return bad('Candidate not found.');
    let assessor_id = body.assessor_id || null;
    if (assessor_id) {
      const assessor = await store.get('users', assessor_id);
      if (!assessor || assessor.role !== 'assessor' || assessor.active === false) return bad('Assessor must be an active assessor user.');
    }
    // Optional cap: serve only X questions, balanced across competencies by weight.
    let questionLimit = null;
    const countProblem = questionCountError(body.question_count);
    if (countProblem) return bad(countProblem);
    if (body.question_count !== undefined && body.question_count !== null && body.question_count !== '') {
      questionLimit = Number(body.question_count);
    }
    const open = (await store.list('assessments', { candidate_id: candidate.id }, { detached: false }))
      .find((a) => a.role_id === body.role_id && ['assigned', 'in_progress', 'submitted'].includes(a.status));
    if (open) return conflict('This candidate already has an open assessment for that role.');
    const snapshot = await buildSnapshot(store, body.role_id, { questionLimit });
    if (!snapshot) return bad('Role not found or inactive.');
    if (!snapshot.bank_total) return bad('That role has no active questions yet. Add questions first.');
    if (questionLimit !== null && questionLimit > snapshot.bank_total)
      return bad(`That role only has ${snapshot.bank_total} active question(s). Choose ${snapshot.bank_total} or fewer.`);
    if (!snapshot.questions.length) return bad('That role has no active questions yet. Add questions first.');
    const rec = await store.insert('assessments', {
      candidate_id: candidate.id, role_id: body.role_id, assessor_id,
      status: 'assigned', snapshot_json: snapshot, report_json: null,
      ...paperSummary(snapshot),
      overall_pct: null, readiness_key: '', readiness_label: '', created_by: auth.user.id,
    });
    await store.update('candidates', candidate.id, { target_role_id: candidate.target_role_id || body.role_id });
    await advanceStage(store, candidate.id, 'assessment');
    const scope = snapshot.question_limit
      ? `${snapshot.questions.length} of ${snapshot.bank_total} questions`
      : `all ${snapshot.questions.length} questions`;
    await audit(store, auth.user, 'assessment_allocated', 'assessments', rec.id,
      `Assessment allocated to "${candidate.name}" (${scope})${assessor_id ? '' : ' — assessor to be assigned'}`);
    return created(rec);
  }));

  route('PATCH', '/admin/assessments/:id', A, lockedAssessment(async ({ store, body, params, auth }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    if (body.assessor_id !== undefined) {
      if (['scored', 'validated'].includes(a.status)) return conflict('Assessment already scored; reassignment is locked.');
      if (body.assessor_id) {
        const u = await store.get('users', body.assessor_id);
        if (!u || u.role !== 'assessor' || u.active === false) return bad('Assessor must be an active assessor user.');
      }
      const updated = await store.update('assessments', params.id, { assessor_id: body.assessor_id || null });
      await audit(store, auth.user, 'assessment_reassigned', 'assessments', params.id, 'Assessor allocation updated');
      return ok(updated);
    }
    return bad('Nothing to update.');
  }));

  route('DELETE', '/admin/assessments/:id', A, lockedAssessment(async ({ store, params, auth }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status))
      return conflict('Only assessments that have not been submitted can be deleted.');
    await bulkRemove(store, 'responses', (await store.list('responses', { assessment_id: params.id })).map((r) => r.id));
    await bulkRemove(store, 'recordings', (await store.list('recordings', { assessment_id: params.id })).map((r) => r.id));
    await store.remove('assessments', params.id);
    await audit(store, auth.user, 'assessment_deleted', 'assessments', params.id, 'Assessment deleted before submission');
    return ok({ ok: true });
  }));

  // ------------------------------------------------ integrity / anti-cheat trail
  route('GET', '/admin/assessments/:id/integrity', A, async ({ store, params }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    const candidate = await store.get('candidates', a.candidate_id);
    const quiz = a.quiz_state || {};
    const events = Array.isArray(quiz.events) ? quiz.events : [];
    // `events` is the retained tail (see MAX_INTEGRITY_EVENTS); the counters and
    // this count cover every event ever reported, trimmed or not.
    const dropped = Number(quiz.events_dropped) || 0;
    return ok({
      assessment: { id: a.id, status: a.status, started_at: a.started_at, submitted_at: a.submitted_at },
      candidate: { id: candidate?.id, name: candidate?.name, current_title: candidate?.current_title || '' },
      integrity: quiz.integrity || {},
      events_count: events.length + dropped,
      events_truncated: dropped,
      events,
    });
  });

  // ------------------------------------------------ reports (full detail, admin view)
  route('GET', '/admin/reports/:id', A, async ({ store, params }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['scored', 'validated'].includes(a.status) || !a.report_json)
      return conflict('Report is available after scoring is finalized.');
    const candidate = await store.get('candidates', a.candidate_id);
    const assessor = a.assessor_id ? await store.get('users', a.assessor_id) : null;
    return ok({
      candidate: { id: candidate?.id, name: candidate?.name, current_title: candidate?.current_title, email: candidate?.email },
      assessor_name: assessor?.name || 'Unassigned',
      report: a.report_json,
      status: a.status,
    });
  });

  // ------------------------------------------------ audit log
  route('GET', '/admin/audit', A, async ({ store, query }) => {
    let rows = await store.list('audit_log');
    if (query.entity) rows = rows.filter((r) => r.entity === query.entity);
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    // Hard cap 200 for audit to prevent unbounded growth in response
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 200));
    const offset = Math.max(0, Number(query.offset) || 0);
    const total = rows.length;
    const slice = rows.slice(offset, offset + limit);
    return ok({ events: slice, total, limit, offset });
  });
}

/** Years of experience: empty/omitted → null, never coerced to 0 via Number(null). */
function yearsExperience(value) {
  if (value === undefined || value === null || value === '') return null;
  return num(value, null);
}

/**
 * A password must be a real string of 8+ characters. The old check was
 * `String(body.password).length >= 8`, so a structured value posted by a
 * scripted client (`{}`, `[...]`, `12345678`) was accepted and hashed as its
 * string form ("[object Object]", "1,2,3,…") — a login nobody could type.
 */
function passwordError(value) {
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
function questionCountError(value) {
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
function emailError(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isTextish(value)) return 'Email must be plain text.';
  return emailShapeProblem(String(value));
}

/** Validate years-of-experience input the same way the bulk import does. */
function yearsError(value) {
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
function cleanOptions(raw) {
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
function questionPoints(body) {
  return body.points === undefined || body.points === '' ? 4 : Number(body.points);
}

function normalizeQuestion(body, existing = {}) {
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
