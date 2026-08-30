import { hashPassword, verifyPassword } from '../../core/passwords.mjs';
import { ok, created, bad, notFound, conflict, forbidden, unprocessable, audit, str, num, bool, missing } from '../helpers.mjs';
import { publicUser } from '../projections.mjs';
import {
  USER_ROLES, STAGE_KEYS, QUESTION_TYPE_KEYS, DIFFICULTIES, DEFAULT_FRAMEWORK_CONFIG,
  PIPELINE_STAGES, MAX_ASSESSMENT_QUESTIONS, MODULE_TEST_STRUCTURE,
} from '../../core/constants.mjs';
import { validateFrameworkConfig } from '../../core/scoring.mjs';
import { requiresSpokenAnswer } from '../../core/spoken-answer.mjs';
import { buildSnapshot, roleBank } from '../assessment-service.mjs';
import { allocationPreview } from '../../core/question-selection.mjs';
import { catalogueStatus, catalogueMissing, syncCatalogue } from '../catalogue-service.mjs';
import { RSA_ROLE, RSA_QUESTIONS } from '../../content/rsa-catalogue.mjs';
import {
  MODULE_GROUPS, MODULES, QUESTIONS, QUESTION_BANK_VERSION,
} from '../../content/rsa-question-bank.mjs';
import { OPTIONAL_QUESTIONS, OPTIONAL_FAMILIES, optionalSummary } from '../../content/rsa-optional-bank.mjs';
import { generateTest, testPlan, TEST_BLUEPRINT, isActive } from '../../core/test-generation.mjs';
import {
  validateQuestion as validateBankQuestion, validateBatch, promptKey,
} from '../../core/question-intake.mjs';
import { parseSheet } from '../../core/sheet-parser.mjs';
import {
  effectiveBank, composeModules, composeFamilies, resolveFamily,
  nextAuthoredId, toStoredRecord, hydrate,
} from '../bank-service.mjs';

/** Upper bound on one spreadsheet import, to bound request time and memory. */
const MAX_IMPORT_ROWS = 2000;

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
  { key: 'Minutes', required: false, note: 'Expected answer time' },
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

/** A downloadable CSV template with the header row and one example of each type. */
function importTemplateCsv() {
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = IMPORT_COLUMNS.map((c) => c.key);
  const example = [
    ['T01', 'Advanced Technical Judgment', 'objective',
      'Which Unity Catalog object is the boundary for cross-workspace data sharing?',
      'The cluster', 'The metastore', 'The notebook', 'The job',
      'B', '', '4', 'Advanced', '2', 'governance,unity-catalog'],
    ['C01', 'Customer Solutioning', 'open',
      'A client cannot articulate their success criteria. How do you run the discovery?',
      '', '', '', '', '',
      'Structures discovery, maps stakeholders, converts vague goals into measurable criteria.',
      '4', 'Intermediate', '5', 'discovery'],
  ];
  return [header, ...example].map((r) => r.map((c) => esc(String(c))).join(',')).join('\n');
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
    if (buf.length > 8_000_000) throw new Error('The file is larger than 8 MB.');
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

export function adminHandlers(route) {

  // ------------------------------------------------ dashboard
  route('GET', '/admin/dashboard', A, async ({ store }) => {
    const [candidates, assessments, roles] = await Promise.all([
      store.list('candidates'), store.list('assessments'), store.list('roles'),
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
  route('GET', '/admin/candidates', A, async ({ store, query }) => {
    let rows = await store.list('candidates');
    if (query.stage) rows = rows.filter((c) => c.stage === query.stage);
    if (query.role_id) rows = rows.filter((c) => c.target_role_id === query.role_id);
    if (query.q) {
      const q = String(query.q).toLowerCase();
      rows = rows.filter((c) => `${c.name} ${c.email || ''}`.toLowerCase().includes(q));
    }
    const roles = await store.list('roles');
    const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ok({ candidates: rows.map((c) => ({ ...c, role_name: roleName[c.target_role_id] || '' })) });
  });

  route('POST', '/admin/candidates', A, async ({ store, body, auth }) => {
    const miss = missing(body, ['name']);
    if (miss.length) return bad('Candidate name is required.');
    if (body.stage && !STAGE_KEYS.includes(body.stage)) return bad('Unknown pipeline stage.');
    if (body.target_role_id && !(await store.get('roles', body.target_role_id))) return bad('Unknown target role.');
    const rec = await store.insert('candidates', {
      name: str(body.name, 120), email: str(body.email, 200), phone: str(body.phone, 60),
      current_title: str(body.current_title, 120), years_experience: num(body.years_experience, null),
      location: str(body.location, 120), source: str(body.source, 120), notes: str(body.notes, 4000),
      target_role_id: body.target_role_id || null,
      stage: body.stage || (body.target_role_id ? 'role_mapped' : 'intake'),
      created_by: auth.user.id,
    });
    await audit(store, auth.user, 'candidate_created', 'candidates', rec.id, `Candidate "${rec.name}" added`);
    return created(rec);
  });

  route('GET', '/admin/candidates/:id', A, async ({ store, params }) => {
    const c = await store.get('candidates', params.id);
    if (!c) return notFound('Candidate not found.');
    const [assessments, roles, users] = await Promise.all([
      store.list('assessments', { candidate_id: c.id }), store.list('roles'), store.list('users'),
    ]);
    const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    const assessorName = Object.fromEntries(users.map((u) => [u.id, u.name]));
    assessments.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const events = (await store.list('audit_log', { entity: 'candidates', entity_id: c.id }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30);
    return ok({
      candidate: c,
      role_name: roleName[c.target_role_id] || '',
      assessments: assessments.map((a) => ({
        id: a.id, status: a.status, created_at: a.created_at, submitted_at: a.submitted_at,
        scored_at: a.scored_at, overall_pct: a.overall_pct, readiness_label: a.readiness_label,
        role_name: roleName[a.role_id] || 'Assessment',
        assessor_name: assessorName[a.assessor_id] || null,
        question_count: (a.snapshot_json?.questions || []).length,
        question_limit: a.snapshot_json?.question_limit ?? null,
        bank_total: a.snapshot_json?.bank_total ?? null,
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
    if (body.stage && !STAGE_KEYS.includes(body.stage)) return bad('Unknown pipeline stage.');
    if (body.target_role_id && !(await store.get('roles', body.target_role_id))) return bad('Unknown target role.');
    const patch = {};
    for (const f of ['name', 'email', 'phone', 'current_title', 'location', 'source', 'notes', 'stage', 'target_role_id'])
      if (body[f] !== undefined) patch[f] = body[f] === '' ? (f === 'target_role_id' ? null : '') : str(body[f], f === 'notes' ? 4000 : 200);
    if (body.years_experience !== undefined) patch.years_experience = num(body.years_experience, null);
    const updated = await store.update('candidates', params.id, patch);
    await audit(store, auth.user, 'candidate_updated', 'candidates', params.id, `Candidate "${updated.name}" updated`);
    return ok(updated);
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
    if (!verifyPassword(body.password, auth.user.password_hash))
      return forbidden('Incorrect admin password — deletion cancelled.');

    const assessments = await store.list('assessments', { candidate_id: params.id });
    if (assessments.some((a) => ['scored', 'validated'].includes(a.status)))
      return conflict('This candidate has finalized assessment reports and cannot be deleted.');

    let removedAssessments = 0;
    for (const a of assessments) {
      for (const r of await store.list('responses', { assessment_id: a.id })) await store.remove('responses', r.id);
      await store.remove('assessments', a.id);
      removedAssessments += 1;
    }
    const users = await store.list('users', { candidate_id: params.id });
    for (const u of users) {
      for (const s of await store.list('sessions', { user_id: u.id })) await store.remove('sessions', s.id);
      await store.remove('users', u.id);
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
  route('GET', '/admin/users', A, async ({ store }) => {
    const users = (await store.list('users')).map(publicUser);
    const candidates = await store.list('candidates');
    const cname = Object.fromEntries(candidates.map((c) => [c.id, c.name]));
    users.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    return ok({ users: users.map((u) => ({ ...u, candidate_name: cname[u.candidate_id] || null })) });
  });

  route('POST', '/admin/users', A, async ({ store, body, auth }) => {
    const miss = missing(body, ['username', 'name', 'role', 'password']);
    if (miss.length) return bad(`Missing: ${miss.join(', ')}`);
    if (!USER_ROLES.includes(body.role)) return bad(`Role must be one of: ${USER_ROLES.join(', ')}`);
    const username = str(body.username, 100).toLowerCase();
    if (!/^[a-z0-9._-]{3,}$/.test(username)) return bad('Username must be 3+ chars: a-z 0-9 . _ -');
    if (String(body.password).length < 8) return bad('Password must be at least 8 characters.');
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
      password_hash: hashPassword(body.password), candidate_id, active: true, created_by: auth.user.id,
    });
    await audit(store, auth.user, 'user_created', 'users', rec.id, `User "${username}" (${body.role}) created`);
    return created(publicUser(rec));
  });

  route('PATCH', '/admin/users/:id', A, async ({ store, body, params, auth }) => {
    const u = await store.get('users', params.id);
    if (!u) return notFound('User not found.');
    const patch = {};
    if (body.name !== undefined) patch.name = str(body.name, 120);
    if (body.email !== undefined) patch.email = str(body.email, 200);
    if (body.active !== undefined) patch.active = bool(body.active);
    if (body.password !== undefined && body.password !== '') {
      if (String(body.password).length < 8) return bad('Password must be at least 8 characters.');
      patch.password_hash = hashPassword(body.password);
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
    const updated = await store.update('users', params.id, patch);
    await audit(store, auth.user, 'user_updated', 'users', params.id, `User "${u.username}" updated`);
    return ok(publicUser(updated));
  });

  // ------------------------------------------------ roles (assessment tracks)
  route('GET', '/admin/roles', A, async ({ store }) => {
    const [roles, comps, questions, assessments] = await Promise.all([
      store.list('roles'), store.list('competencies'), store.list('questions'), store.list('assessments'),
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
    const key = str(body.key, 60).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) return bad('Key must be a slug like databricks-rsa.');
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

  route('PATCH', '/admin/roles/:id', A, async ({ store, body, params, auth }) => {
    const r = await store.get('roles', params.id);
    if (!r) return notFound('Role not found.');
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
    if ((await store.list('assessments', { role_id: params.id })).length)
      return conflict('Assessments exist for this role. Deactivate it instead of deleting.');
    for (const q of await store.list('questions', { role_id: params.id })) await store.remove('questions', q.id);
    for (const c of await store.list('competencies', { role_id: params.id })) await store.remove('competencies', c.id);
    for (const f of await store.list('frameworks', { role_id: params.id })) await store.remove('frameworks', f.id);
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
  const validateCompetency = (body, store, roleId) => (async () => {
    if (!str(body.name)) return 'Competency name is required.';
    if (body.weight !== undefined && (num(body.weight, -1) < 0 || num(body.weight) > 100)) return 'Weight must be 0-100.';
    if (body.target_level !== undefined && (num(body.target_level) < 1 || num(body.target_level) > 5)) return 'Target level must be 1-5.';
    return null;
  })();

  route('POST', '/admin/competencies', A, async ({ store, body, auth }) => {
    if (!body.role_id || !(await store.get('roles', body.role_id))) return bad('A valid role is required.');
    const problem = await validateCompetency(body, store, body.role_id);
    if (problem) return bad(problem);
    const rec = await store.insert('competencies', {
      role_id: body.role_id,
      key: str(body.key, 60) || str(body.name, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: str(body.name, 160), category: str(body.category, 60) || 'technical',
      description: str(body.description, 1500), enrichment_hint: str(body.enrichment_hint, 1500),
      weight: num(body.weight, 0), target_level: num(body.target_level, 4),
      order: num(body.order, 0), active: body.active !== undefined ? bool(body.active) : true,
    });
    await audit(store, auth.user, 'competency_created', 'competencies', rec.id, `Competency "${rec.name}" created`);
    return created(rec);
  });

  route('PATCH', '/admin/competencies/:id', A, async ({ store, body, params, auth }) => {
    const c = await store.get('competencies', params.id);
    if (!c) return notFound('Competency not found.');
    if (body.weight !== undefined && (num(body.weight, -1) < 0 || num(body.weight) > 100)) return bad('Weight must be 0-100.');
    if (body.target_level !== undefined && (num(body.target_level) < 1 || num(body.target_level) > 5)) return bad('Target level must be 1-5.');
    const patch = {};
    for (const f of ['name', 'category', 'description', 'enrichment_hint', 'key'])
      if (body[f] !== undefined) patch[f] = str(body[f], 1500);
    for (const f of ['weight', 'target_level', 'order']) if (body[f] !== undefined) patch[f] = num(body[f], c[f]);
    if (body.active !== undefined) patch.active = bool(body.active);
    const updated = await store.update('competencies', params.id, patch);
    await audit(store, auth.user, 'competency_updated', 'competencies', params.id, `Competency "${updated.name}" updated`);
    return ok(updated);
  });

  route('DELETE', '/admin/competencies/:id', A, async ({ store, params, auth }) => {
    const c = await store.get('competencies', params.id);
    if (!c) return notFound('Competency not found.');
    for (const q of await store.list('questions', { competency_id: params.id })) await store.remove('questions', q.id);
    await store.remove('competencies', params.id);
    await audit(store, auth.user, 'competency_deleted', 'competencies', params.id, `Competency "${c.name}" (and its questions) deleted`);
    return ok({ ok: true });
  });

  // ------------------------------------------------ question bank
  const validateQuestion = (body) => {
    if (!QUESTION_TYPE_KEYS.includes(body.type)) return `Type must be one of: ${QUESTION_TYPE_KEYS.join(', ')}`;
    if (!str(body.prompt)) return 'Question prompt is required.';
    const points = num(body.points, 4);
    if (!(points > 0 && points <= 20)) return 'Points must be between 1 and 20.';
    if (DIFFICULTIES.includes(body.difficulty) === false && body.difficulty !== undefined && body.difficulty !== '')
      return `Difficulty must be one of: ${DIFFICULTIES.join(', ')}`;
    if (body.type === 'mcq_single' || body.type === 'mcq_multi') {
      const opts = Array.isArray(body.options) ? body.options.filter((o) => str(o.label)) : [];
      if (opts.length < 2) return 'At least two options are required.';
      const ids = new Set(opts.map((o) => o.id));
      const correct = Array.isArray(body.correct_option_ids) ? body.correct_option_ids : [];
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
    return ok({ questions: rows.map((q) => ({ ...q, competency_name: cname[q.competency_id] || '' })) });
  });

  route('POST', '/admin/questions', A, async ({ store, body, auth }) => {
    if (!body.role_id || !(await store.get('roles', body.role_id))) return bad('A valid role is required.');
    const comp = body.competency_id ? await store.get('competencies', body.competency_id) : null;
    if (!comp) return bad('A valid competency is required.');
    if (comp.role_id !== body.role_id) return bad('Competency must belong to the selected role.');
    const problem = validateQuestion(body);
    if (problem) return bad(problem);
    const rec = await store.insert('questions', normalizeQuestion(body));
    await audit(store, auth.user, 'question_created', 'questions', rec.id, `Question added (${rec.type})`);
    return created(rec);
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
    if (!query.role_id) return bad('role_id is required.');
    const rows = await store.list('frameworks', { role_id: query.role_id });
    const active = rows.find((f) => f.active !== false);
    return ok({ framework: active || { role_id: query.role_id, name: 'ECOD Readiness Framework v1', config: DEFAULT_FRAMEWORK_CONFIG, unsaved: true } });
  });

  route('PUT', '/admin/frameworks', A, async ({ store, body, auth }) => {
    if (!body.role_id || !(await store.get('roles', body.role_id))) return bad('A valid role is required.');
    const config = body.config;
    const problems = validateFrameworkConfig(config);
    if (problems.length) return unprocessable('Invalid framework configuration.', { problems });
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
    let rows = await store.list('assessments');
    if (query.status) rows = rows.filter((a) => a.status === query.status);
    if (query.assessor_id) rows = rows.filter((a) => a.assessor_id === query.assessor_id);
    if (query.role_id) rows = rows.filter((a) => a.role_id === query.role_id);
    const [candidates, users, roles] = await Promise.all([store.list('candidates'), store.list('users'), store.list('roles')]);
    const cmap = Object.fromEntries(candidates.map((c) => [c.id, c]));
    const uname = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const rname = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ok({
      assessments: rows.map((a) => ({
        id: a.id, status: a.status, created_at: a.created_at, started_at: a.started_at,
        submitted_at: a.submitted_at, scored_at: a.scored_at, overall_pct: a.overall_pct,
        readiness_key: a.readiness_key, readiness_label: a.readiness_label,
        candidate_id: a.candidate_id, candidate_name: cmap[a.candidate_id]?.name || '(deleted)',
        role_id: a.role_id, role_name: rname[a.role_id] || '(deleted)',
        assessor_id: a.assessor_id, assessor_name: uname[a.assessor_id] || null,
        question_count: (a.snapshot_json?.questions || []).length,
        question_limit: a.snapshot_json?.question_limit ?? null,
        bank_total: a.snapshot_json?.bank_total ?? null,
        integrity_count: Object.values(a.quiz_state?.integrity || {}).reduce((s, v) => s + Number(v || 0), 0),
        last_integrity_event: a.quiz_state?.events?.length
          ? a.quiz_state.events[a.quiz_state.events.length - 1].event
          : null,
      })),
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
    // Catalogue context: when this track matches the published catalogue and
    // the bank is smaller than the allocation cap, the UI can offer a one-click
    // top-up instead of leaving the admin stuck below the cap.
    const isCatalogueRole = bank.role.key === RSA_ROLE.key;
    const catalogue = isCatalogueRole
      ? { total: RSA_QUESTIONS.length, missing: catalogueMissing(await store.list('questions', { role_id: bank.role.id })) }
      : null;
    return ok({
      role: { id: bank.role.id, name: bank.role.name },
      max_questions: MAX_ASSESSMENT_QUESTIONS,
      catalogue,
      ...allocationPreview(bank.questions, bank.competencies, previewLimit),
    });
  });

  // ------------------------------------------------ question bank
  // The module-structured bank: modules, families and the fixed 50-question
  // paper shape.
  //
  // The published catalogue in src/content is generated and read-only, so
  // every read below goes through effectiveBank(), which merges it with the
  // admin-authored questions in the `bank_questions` table. One source of
  // truth for the tree, the drill-down, the plan, the preview and generation.
  const bankContext = async (store) => {
    const questions = await effectiveBank(store);
    return { questions, modules: composeModules(questions), families: composeFamilies(questions) };
  };

  route('GET', '/admin/question-bank/modules', A, async ({ store, query }) => {
    const includeOptional = bool(query.include_optional);
    const { questions, modules } = await bankContext(store);

    const optionalByFamily = new Map();
    const optionalByModule = new Map();
    if (includeOptional) {
      for (const q of OPTIONAL_QUESTIONS) {
        optionalByFamily.set(q.family_id, (optionalByFamily.get(q.family_id) || 0) + 1);
        optionalByModule.set(q.module, (optionalByModule.get(q.module) || 0) + 1);
      }
    }

    return ok({
      version: QUESTION_BANK_VERSION,
      blueprint: TEST_BLUEPRINT,
      // How many modules the paper-wide blueprint totals are spread across,
      // so a client can show the per-module quota without hardcoding it.
      technical_modules: MODULE_TEST_STRUCTURE.technical_modules,
      non_technical_modules: MODULE_TEST_STRUCTURE.non_technical_modules,
      groups: MODULE_GROUPS,
      modules: modules.map((m) => {
        const own = m.families.map((f) => ({ ...f, optional: optionalByFamily.get(f.id) || 0 }));
        // Legacy families are appended after the curated ones so the tree shows
        // where retired questions live without implying they are the default
        // place to add a new question. Their members are all optional, so
        // `objective`/`open` describe what the family holds while `optional`
        // carries the same total - otherwise the row would read 0/0.
        const legacy = includeOptional
          ? OPTIONAL_FAMILIES.filter((f) => f.module === m.key).map((f) => ({
              ...f, optional: optionalByFamily.get(f.id) || 0,
            }))
          : [];
        return { ...m, optional: optionalByModule.get(m.key) || 0, families: [...own, ...legacy] };
      }),
      // Totals describe what generation can actually draw; deactivated
      // questions are reported separately instead of padding the headline.
      bank_total: questions.filter(isActive).length,
      published_total: QUESTIONS.filter(isActive).length,
      authored_total: questions.filter((q) => q.authored && isActive(q)).length,
      inactive_total: questions.filter((q) => !isActive(q)).length,
      family_total: composeFamilies(questions).length,
      optional: optionalSummary(),
    });
  });

  // One family's questions, so an admin can review a family before adding to
  // it. Families are addressed by their compound `<MODULE>:<slug>` id.
  route('GET', '/admin/question-bank/families/:id', A, async ({ store, params }) => {
    const { questions } = await bankContext(store);
    const family = resolveFamily(params.id, questions)
      || OPTIONAL_FAMILIES.find((f) => f.id === params.id)
      || null;
    if (!family) return notFound('Family not found.');
    const rows = [...questions, ...OPTIONAL_QUESTIONS].filter((q) => q.family_id === family.id);
    return ok({
      family,
      questions: rows.map((q) => ({
        id: q.id, type: q.type, prompt: q.prompt,
        difficulty: q.difficulty, band: q.band, minutes: q.minutes,
        optional: q.optional === true,
        authored: q.authored === true,
        active: isActive(q),
        tags: q.tags || [],
        needs_option_review: q.needs_option_review === true,
      })),
    });
  });

  // What a generated paper would look like, and whether every module can meet
  // its quota - the module-based equivalent of /roles/:id/question-plan.
  route('GET', '/admin/question-bank/plan', A, async ({ store }) => {
    const { questions } = await bankContext(store);
    return ok(testPlan({ modules: MODULES, questions: [...questions, ...OPTIONAL_QUESTIONS] }));
  });

  // Draw a sample paper so an admin can inspect the structure before relying
  // on it. Never persisted - allocation builds its own paper.
  route('POST', '/admin/question-bank/preview', A, async ({ store }) => {
    const { questions } = await bankContext(store);
    const result = generateTest({
      modules: MODULES,
      questions: [...questions, ...OPTIONAL_QUESTIONS],
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
  route('POST', '/admin/question-bank/questions', A, async ({ store, body, auth }) => {
    const { questions, families } = await bankContext(store);
    const result = validateBankQuestion(body, { modules: MODULES, families });
    if (!result.ok) return unprocessable('This question is not valid.', { errors: result.errors });

    const key = promptKey(result.question.prompt);
    if (questions.some((q) => promptKey(q.prompt) === key)) {
      return conflict('A question with this prompt already exists in the bank.');
    }

    const id = nextAuthoredId(result.question.module, await store.list('bank_questions'));
    const rec = await store.insert('bank_questions', toStoredRecord(result.question, { id, actorId: auth.user.id }));
    await audit(store, auth.user, 'bank_question_created', 'bank_questions', rec.id,
      `Question added to ${rec.module} / ${rec.family}`);
    return created({ question: hydrate(rec) });
  });

  route('PATCH', '/admin/question-bank/questions/:id', A, async ({ store, body, params, auth }) => {
    const existing = (await store.list('bank_questions')).find((q) => q.id === params.id);
    if (!existing) {
      return notFound('Only admin-authored questions can be edited; this id is not one of them.');
    }
    const { questions, families } = await bankContext(store);
    const merged = mergeForPatch(hydrate(existing), body);
    const result = validateBankQuestion(merged, { modules: MODULES, families });
    if (!result.ok) return unprocessable('This question is not valid.', { errors: result.errors });

    const key = promptKey(result.question.prompt);
    if (questions.some((q) => q.id !== params.id && promptKey(q.prompt) === key)) {
      return conflict('Another question already uses this prompt.');
    }
    const patch = toStoredRecord(result.question, { id: params.id, actorId: existing.created_by });
    if (body.active !== undefined) patch.active = bool(body.active);
    const rec = await store.update('bank_questions', params.id, patch);
    await audit(store, auth.user, 'bank_question_updated', 'bank_questions', params.id, 'Question updated');
    return ok({ question: hydrate(rec) });
  });

  route('DELETE', '/admin/question-bank/questions/:id', A, async ({ store, params, auth }) => {
    const existing = (await store.list('bank_questions')).find((q) => q.id === params.id);
    if (!existing) {
      return notFound('Only admin-authored questions can be deleted; the published bank is read-only.');
    }
    await store.remove('bank_questions', params.id);
    await audit(store, auth.user, 'bank_question_deleted', 'bank_questions', params.id,
      `Question removed from ${existing.module}`);
    return ok({ ok: true });
  });

  // ---- authoring: bulk import from a spreadsheet -----------------------
  // Accepts a base64 .xlsx or raw .csv text. `dry_run` validates and reports
  // without writing, which is what the UI calls first so an admin sees the
  // per-row outcome before committing.
  route('POST', '/admin/question-bank/import', A, async ({ store, body, auth }) => {
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

    const { questions, families } = await bankContext(store);
    const report = validateBatch(parsed.rows, {
      modules: MODULES, families, existingPrompts: questions.map((q) => q.prompt),
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
    // cannot hand two questions the same id.
    const existingRows = await store.list('bank_questions');
    const allocated = [...existingRows];
    let imported = 0;
    for (const { question } of report.accepted) {
      const id = nextAuthoredId(question.module, allocated);
      const rec = toStoredRecord(question, { id, actorId: auth.user.id });
      await store.insert('bank_questions', rec);
      allocated.push(rec);
      imported += 1;
    }
    if (imported) {
      await audit(store, auth.user, 'bank_questions_imported', 'bank_questions', '',
        `${imported} question(s) imported from a spreadsheet`);
    }
    return ok({ ...summary, imported });
  });

  // A ready-to-fill template, so an admin never has to guess the columns.
  route('GET', '/admin/question-bank/import-template', A, async () => ok({
    filename: 'ecod-question-import-template.csv',
    content_type: 'text/csv',
    columns: IMPORT_COLUMNS,
    csv: importTemplateCsv(),
  }));


  // ------------------------------------------------ published catalogue
  // The effective allocation ceiling is min(cap, bank size). These endpoints
  // let an admin top a small bank up to the published catalogue from inside
  // the app — the same sync `npm run seed` performs, available to deployments
  // (e.g. Netlify) where there is no CLI.
  route('GET', '/admin/content/catalogue', A, async ({ store }) =>
    ok(await catalogueStatus(store)));

  route('POST', '/admin/content/sync', A, async ({ store, auth }) => {
    const result = await syncCatalogue(store);
    if (result.error) return bad(result.error);
    await audit(store, auth.user, 'catalogue_synced', 'questions', result.role_id,
      `Published catalogue synced: ${result.added} question(s) added, bank now ${result.bank_total}`);
    return ok(result);
  });

  route('POST', '/admin/assessments', A, async ({ store, body, auth }) => {
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
    if (body.question_count !== undefined && body.question_count !== null && body.question_count !== '') {
      questionLimit = Number(body.question_count);
      if (!Number.isInteger(questionLimit) || questionLimit < 1)
        return bad('Number of questions must be a whole number of 1 or more.');
      if (questionLimit > MAX_ASSESSMENT_QUESTIONS)
        return bad(`Number of questions cannot exceed ${MAX_ASSESSMENT_QUESTIONS}.`);
    }
    const open = (await store.list('assessments', { candidate_id: candidate.id }))
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
      question_count: snapshot.questions.length,
      overall_pct: null, readiness_key: '', readiness_label: '', created_by: auth.user.id,
    });
    await store.update('candidates', candidate.id, { target_role_id: candidate.target_role_id || body.role_id });
    await advanceCandidate(store, candidate.id, 'assessment');
    const scope = snapshot.question_limit
      ? `${snapshot.questions.length} of ${snapshot.bank_total} questions`
      : `all ${snapshot.questions.length} questions`;
    await audit(store, auth.user, 'assessment_allocated', 'assessments', rec.id,
      `Assessment allocated to "${candidate.name}" (${scope})${assessor_id ? '' : ' — assessor to be assigned'}`);
    return created(rec);
  });

  route('PATCH', '/admin/assessments/:id', A, async ({ store, body, params, auth }) => {
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
  });

  route('DELETE', '/admin/assessments/:id', A, async ({ store, params, auth }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status))
      return conflict('Only assessments that have not been submitted can be deleted.');
    for (const r of await store.list('responses', { assessment_id: params.id })) await store.remove('responses', r.id);
    await store.remove('assessments', params.id);
    await audit(store, auth.user, 'assessment_deleted', 'assessments', params.id, 'Assessment deleted before submission');
    return ok({ ok: true });
  });

  // ------------------------------------------------ integrity / anti-cheat trail
  route('GET', '/admin/assessments/:id/integrity', A, async ({ store, params }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    const candidate = await store.get('candidates', a.candidate_id);
    const quiz = a.quiz_state || {};
    const events = Array.isArray(quiz.events) ? quiz.events : [];
    return ok({
      assessment: { id: a.id, status: a.status, started_at: a.started_at, submitted_at: a.submitted_at },
      candidate: { id: candidate?.id, name: candidate?.name, current_title: candidate?.current_title || '' },
      integrity: quiz.integrity || {},
      events_count: events.length,
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
    return ok({ events: rows.slice(0, 200) });
  });
}

/** Move candidate stage forward only (never regress on re-allocation). */
async function advanceCandidate(store, candidateId, stage) {
  const c = await store.get('candidates', candidateId);
  if (!c) return;
  const cur = STAGE_KEYS.indexOf(c.stage || 'intake');
  const next = STAGE_KEYS.indexOf(stage);
  if (next > cur) await store.update('candidates', candidateId, { stage });
}

function normalizeQuestion(body, existing = {}) {
  const options = Array.isArray(body.options)
    ? body.options.filter((o) => str(o.label)).map((o) => ({ id: str(o.id, 40), label: str(o.label, 500) }))
    : [];
  return {
    role_id: body.role_id || existing.role_id,
    competency_id: body.competency_id || existing.competency_id,
    type: body.type || existing.type,
    prompt: str(body.prompt, 2000), help_text: str(body.help_text, 1000),
    options,
    correct_option_ids: Array.isArray(body.correct_option_ids) ? body.correct_option_ids.map((x) => str(x, 40)) : [],
    points: num(body.points, 4), difficulty: body.difficulty || 'intermediate',
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
