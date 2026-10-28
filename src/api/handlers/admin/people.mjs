import {
  MAX_IMPORT_ROWS, MAX_IMPORT_COMMIT_ROWS, CANDIDATE_TEXT_FIELDS, setCandidateAssessor, candidateAssessorField, readImportPayload, A, paginate, yearsExperience, passwordError, questionCountError, emailError, yearsError, purgePreview, purgePerson, deleteUnfinalizedCandidate, newToken, creationRequest, sameCreation, creationId, issueRecoveryLink, hashPasswordAsync, hashPasswordsAsync, verifyPasswordAsync, ok, created, bad, notFound, conflict, forbidden, unprocessable, audit, str, bool, missing, bulkInsert, bulkUpdate, textField, publicUser, withLock, USER_ROLES, STAGE_KEYS, PIPELINE_STAGES, autoAllocateAssessment, planBulkAutoAllocation, paperSummary, paperFacts, resolveAssessorId, CANDIDATE_IMPORT_COLUMNS, candidateImportTemplateCsv, validateCandidateBatch,
} from './shared.mjs';
import { integrityRisk } from '../../../core/integrity-risk.mjs';

/** Candidates, portal users, bulk import, assessor assignment and person purge. */
export function peopleRoutes(route) {
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
      // Only written when set: an Airtable base created before this column
      // existed rejects a row that names it (422), even with a null value.
      ...(assessorField.id ? { assessor_id: assessorField.id } : {}),
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

    // Bulk imports auto-allocate the same per-role default assessment each
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
        roles, questionCount: body.question_count ?? null,
      })
      : [];
    const plannedCount = plans.filter((p) => p.ok).length;

    // The dialog-wide default assessor (`assessor_id`) scores every planned
    // paper whose row left the Assessor column blank; an unknown or inactive
    // default is ignored rather than failing the whole file.
    const defaultAssessorId = await resolveAssessorId(store, body.assessor_id || null);
    const defaultAssessorName = defaultAssessorId ? (existingUsers.find((u) => u.id === defaultAssessorId)?.name || '') : '';
    const activeAssessorIds = new Set(existingUsers.filter((u) => u.role === 'assessor' && u.active !== false).map((u) => u.id));
    const importAssessorId = (candidate, plan) => [candidate.assessor_id, defaultAssessorId, plan?.ok && plan.role.default_assessor_id]
      .find((id) => activeAssessorIds.has(id)) || null;
    const planByCandidate = new Map(windowAccepted.map((row, i) => [row.candidate, plans[i]]));

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
        assessor: existingUsers.find((u) => u.id === importAssessorId(a.candidate, planByCandidate.get(a.candidate)))?.name || '',
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
      const assessor_id = importAssessorId(candidate, plan);
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
        ...(assessor_id ? { assessor_id } : {}),
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
    return ok({
      ...pageSummary, imported, users_created: usersCreated, credentials, auto_allocated, auto_allocations, page,
      imported_candidate_ids: importedRecords.map((r) => r.id),
    });
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
        integrity_risk: integrityRisk(a.quiz_state),
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
    // An unchanged target role is not re-validated: the Edit form sends the
    // current value back on every save, and a track deactivated since must
    // not block correcting the candidate's phone number (nor be silently
    // cleared — the form keeps it selectable, labelled inactive).
    if (body.target_role_id && body.target_role_id !== c.target_role_id) {
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
    // The assessor is editable from the candidate record, at any point of the
    // journey: changing it moves every paper of the candidate (allocated, in
    // progress, submitted or already scored) to the new assessor.
    let updated;
    let reassigned = [];
    // An unchanged assessor is never re-validated: the form sends the current
    // value back on every save, and a since-deactivated assessor must not
    // block editing the candidate's phone number.
    if (body.assessor_id !== undefined && (body.assessor_id || null) !== (c.assessor_id || null)) {
      const assessorField = await candidateAssessorField(store, body.assessor_id);
      if (assessorField.error) return bad(assessorField.error);
      ({ updated, moved: reassigned } = await setCandidateAssessor(store, auth.user, c, assessorField.id, patch));
    } else {
      updated = await store.update('candidates', params.id, patch);
    }
    await audit(store, auth.user, 'candidate_updated', 'candidates', params.id, `Candidate "${updated.name}" updated`
      + (reassigned.length ? ` (${reassigned.length} assessment${reassigned.length === 1 ? '' : 's'} moved to the new assessor)` : ''));
    return ok({ ...updated, reassigned_assessments: reassigned.length });
  });

  // One assessor for many candidates at once — the "apply to everyone I just
  // imported" step of the import dialog. Same rules and same paper moves as
  // editing each candidate; unknown ids are reported, not fatal.
  route('POST', '/admin/candidates/assessor', A, async ({ store, body, auth }) => {
    const ids = Array.isArray(body.candidate_ids)
      ? [...new Set(body.candidate_ids.filter((v) => typeof v === 'string' && v))].slice(0, MAX_IMPORT_ROWS)
      : [];
    if (!ids.length) return bad('candidate_ids must list at least one candidate.');
    const assessorField = await candidateAssessorField(store, body.assessor_id);
    if (assessorField.error) return bad(assessorField.error);
    const nextAssessor = assessorField.id;
    const assessorName = nextAssessor ? (await store.get('users', nextAssessor))?.name || '' : '';
    // Batched, not per candidate: right after a 2,000-row import this touches
    // 2,000 candidates and their papers, and the file/blob adapters rewrite a
    // whole table per single-row write. One read of each table, one write per
    // table, one audit batch — the same rule every other bulk path follows.
    const wanted = new Set(ids);
    const [allCandidates, allPapers] = await Promise.all([
      store.list('candidates'), store.list('assessments', {}, { detached: false }),
    ]);
    const found = allCandidates.filter((c) => wanted.has(c.id));
    const foundIds = new Set(found.map((c) => c.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    const candidatePatches = found
      .filter((c) => (c.assessor_id || null) !== nextAssessor)
      .map((c) => ({ id: c.id, patch: { assessor_id: nextAssessor } }));
    const paperPatches = allPapers
      .filter((a) => foundIds.has(a.candidate_id) && ['assigned', 'in_progress', 'submitted'].includes(a.status)
        && (a.assessor_id || null) !== nextAssessor)
      .map((a) => ({ id: a.id, patch: { assessor_id: nextAssessor } }));
    await bulkUpdate(store, 'candidates', candidatePatches);
    const moved = await bulkUpdate(store, 'assessments', paperPatches);
    if (moved.length) {
      try {
        await bulkInsert(store, 'audit_log', moved.map((a) => ({
          actor_id: auth.user.id, actor_name: auth.user.name || 'admin',
          action: 'assessment_reassigned', entity: 'assessments', entity_id: a.id,
          message: nextAssessor ? 'Assessor allocation updated for a batch of candidates' : 'Assessor unassigned for a batch of candidates',
        })));
      } catch { /* audit must never break the request */ }
    }
    await audit(store, auth.user, 'candidates_assessor_set', 'candidates', '',
      `Assessor ${assessorName ? `"${assessorName}"` : 'cleared'} for ${found.length} candidate(s)`
      + (moved.length ? ` (${moved.length} assessment(s) moved)` : ''));
    return ok({ updated: found.length, reassigned_assessments: moved.length, missing, assessor_id: nextAssessor, assessor_name: assessorName });
  });

  for (const kind of ['candidates', 'users']) {
    route('GET', `/admin/${kind}/:id/purge-preview`, A, (ctx) => purgePreview(ctx, kind));
    route('DELETE', `/admin/${kind}/:id/purge`, A, (ctx) => purgePerson(ctx, kind));
  }

  // Password-gated destructive delete. The signed-in admin must re-enter
  // their own password; the delete then cascades over everything that hangs
  // off the candidate so no orphaned login or draft data is left behind:
  //   candidate -> open (unscored) assessments + their draft responses
  //             -> linked portal user(s) + their live sessions
  // Candidates with FINALIZED (scored/validated) reports are protected.
  route('DELETE', '/admin/candidates/:id', A, deleteUnfinalizedCandidate);

  // ------------------------------------------------ users & access
  route('GET', '/admin/users', A, async ({ store, query }) => {
    const users = (await store.list('users')).map(publicUser);
    const candidates = await store.list('candidates');
    const cname = Object.fromEntries(candidates.map((c) => [c.id, c.name]));
    users.sort((a, b) => String(a.role || '').localeCompare(String(b.role || '')) || String(a.name || '').localeCompare(String(b.name || '')));
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
    // An assessor named for the automatic paper must be able to score it —
    // the same 400 the manual Allocate gives, rather than a login whose paper
    // silently landed unassigned. Checked before anything is written.
    if (body.role === 'candidate' && body.assessor_id) {
      if (typeof body.assessor_id !== 'string' || !(await resolveAssessorId(store, body.assessor_id)))
        return bad('Assessor must be an active assessor user.');
    }
    // Username and candidate-link uniqueness are check-then-insert; a double
    // submit of the Add user form used to create two logins with one username
    // (and two portal users for one candidate). User creation is rare enough
    // that one lock for the whole route is the simplest correct answer.
    return withLock('users:create', async () => {
    const request = creationRequest(body, auth.user.id);
    if (request?.error) return bad(request.error);
    if (request && (await store.list('users')).some((u) => u.creation_request?.key === request.key
      && u.creation_request.actor_id === auth.user.id && !sameCreation(u, request)))
      return conflict('This request id was already used with different account details.');
    const existing = (await store.list('users', { username }))[0];
    if (existing && (!sameCreation(existing, request) || existing.active === false
      || !await verifyPasswordAsync(body.password, existing.password_hash))) return conflict('Username already exists.');
    let candidate_id = null;
    if (body.role === 'candidate') {
      if (!body.candidate_id) return bad('A candidate record must be linked for candidate users.');
      const c = await store.get('candidates', body.candidate_id);
      if (!c || c.deleting) return bad('Linked candidate not found or being deleted.');
      if ((await store.list('users', { candidate_id: c.id })).some((u) => u.id !== existing?.id)) return conflict('That candidate already has a portal user.');
      candidate_id = c.id;
    }
    const rec = existing || await store.insert('users', {
      ...(request ? { id: creationId(request, 'user'), creation_request: request } : {}),
      username, name: str(body.name, 120), email: str(body.email, 200), role: body.role,
      password_hash: await hashPasswordAsync(body.password), candidate_id, active: true, created_by: auth.user.id,
    });
    if (!existing) await audit(store, auth.user, 'user_created', 'users', rec.id, `User "${username}" (${body.role}) created`);

    // Every candidate-role user is auto-allocated the configured default
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
            questionCount: body.question_count ?? null,
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

  route('PATCH', '/admin/users/:id', A, async ({ store, body, params, auth }) => withLock('users:create', () => withLock(`identity:${params.id}`, async () => {
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
    if (patch.active === true && u.candidate_id && (await store.get('candidates', u.candidate_id))?.deleting)
      return conflict('Candidate deletion is incomplete. Finish Delete all data before changing account access.');
    if (body.password !== undefined && body.password !== '') {
      const passwordProblem = passwordError(body.password);
      if (passwordProblem) return bad(passwordProblem);
      patch.password_hash = await hashPasswordAsync(body.password);
    }
    if (body.candidate_id !== undefined && u.role === 'candidate') {
      if (!body.candidate_id) return bad('Candidate users must be linked to a candidate record.');
      const linkedCandidate = await store.get('candidates', body.candidate_id);
      if (!linkedCandidate || linkedCandidate.deleting) return bad('Linked candidate not found or being deleted.');
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
    const passwordChanged = patch.password_hash !== undefined;
    const switchedOff = patch.active === false && u.active !== false;
    if (passwordChanged || switchedOff) {
      patch.session_generation = newToken();
      // Preserve only the admin's current session. Updating it first fails
      // closed if the user write fails; every other old token stays invalid
      // even if best-effort physical cleanup cannot remove its row.
      if (u.id === auth.user.id)
        await store.update('sessions', auth.session.id, { session_generation: patch.session_generation });
    }
    const updated = await store.update('users', params.id, patch);
    // A password reset is what an admin reaches for when a login is
    // compromised, and deactivating is how they shut one out — neither is
    // done if the tokens already issued keep working. Revoke every session
    // of a user whose password changed or whose account was switched off
    // (reactivating later starts from zero live sessions rather than
    // resurrecting the ones that were revoked). The admin resetting their
    // OWN password keeps the session they are using; their other devices
    // are signed out like anyone else's.
    if (passwordChanged || switchedOff) {
      const sessions = await store.list('sessions', { user_id: u.id });
      const keep = u.id === auth.user.id ? auth.session.id : null;
      await Promise.all(sessions
        .filter((sess) => sess.id !== keep)
        .map((sess) => store.remove('sessions', sess.id).catch(() => {})));
    }
    // Deactivating an assessor strands the papers still waiting on them: the
    // exam can go on, but nobody can score. Report how many so the admin can
    // reassign (the papers are left as they are — an audit trail, not a move).
    let stranded;
    if (switchedOff && u.role === 'assessor') {
      stranded = (await store.list('assessments', { assessor_id: u.id }, { detached: false }))
        .filter((a) => ['assigned', 'in_progress', 'submitted'].includes(a.status)).length;
    }
    await audit(store, auth.user, 'user_updated', 'users', params.id, `User "${u.username}" updated`
      + (stranded ? ` (${stranded} open assessment(s) still assigned to this deactivated assessor)` : ''));
    return ok(stranded !== undefined ? { ...publicUser(updated), open_assessments: stranded } : publicUser(updated));
  })));

  route('POST', '/admin/users/:id/recovery-link', A, async ({ store, params, body, auth }) => withLock(`identity:${params.id}`, async () => {
    if (typeof body.password !== 'string' || !body.password) return bad('Admin password is required.');
    const actor = await store.get('users', auth.user.id);
    if (typeof body.password !== 'string' || !actor || actor.active === false
      || !await verifyPasswordAsync(body.password, actor.password_hash)) return forbidden('Admin password is required and must be correct.');
    const user = await store.get('users', params.id);
    if (!user || user.active === false) return bad('The user must exist and be active.');
    const result = await issueRecoveryLink(store, user, user.id === actor.id ? auth.session : null);
    await audit(store, actor, 'recovery_link_created', 'users', user.id, '15-minute recovery link created; previous links and other sessions revoked.');
    return ok(result);
  }));

  // ------------------------------------------------ roles (assessment tracks)
}
