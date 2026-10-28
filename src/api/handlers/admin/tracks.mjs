import {
  candidateAssessorField, trackAssessorSummary, COMPETENCY_TEXT_FIELDS, derivedCompetencyKey, A, paginate, targetLevelError, validateCompetency, validateQuestion, duplicatePromptInRole, questionCountError, normalizeQuestion, ok, created, bad, notFound, conflict, unprocessable, audit, str, num, bool, missing, bulkUpdate, bulkRemove, isTextish, textField, withLock, DEFAULT_FRAMEWORK_CONFIG, MAX_ASSESSMENT_QUESTIONS, validateFrameworkConfig, defaultQuestionCountForRole, hasStrictModuleAllocation, isCatalogueCompetency, isActive, effectiveBank,
} from './shared.mjs';

/** Role tracks, competencies, the legacy question list and scoring frameworks. */
export function trackRoutes(route) {
  route('GET', '/admin/roles', A, async ({ store }) => {
    const [roles, comps, questions, assessments, users] = await Promise.all([
      store.list('roles'), store.list('competencies'), store.list('questions'), store.list('assessments', {}, { detached: false }), store.list('users'),
    ]);
    roles.sort((a, b) => a.name.localeCompare(b.name));
    const moduleCounts = new Map(await Promise.all(roles.filter(hasStrictModuleAllocation).map(async (r) =>
      [r.id, (await effectiveBank(store, r.key)).filter(isActive).length])));
    return ok({
      roles: roles.map((r) => ({
        ...r,
        ...trackAssessorSummary(r, users.find((u) => u.id === r.default_assessor_id)),
        default_question_count: defaultQuestionCountForRole(r),
        competency_count: comps.filter((c) => c.role_id === r.id).length,
        question_count: moduleCounts.has(r.id) ? moduleCounts.get(r.id) : questions.filter((q) => q.role_id === r.id).length,
        ...(hasStrictModuleAllocation(r) ? { allocation_mode: 'module', module_count: 20 } : {}),
        assessment_count: assessments.filter((a) => a.role_id === r.id).length,
      })),
    });
  });

  route('POST', '/admin/roles', A, async ({ store, body, auth }) => {
    const miss = missing(body, ['key', 'name', 'technology']);
    if (miss.length) return bad(`Missing: ${miss.join(', ')}`);
    const structured = textField(body, ['name', 'technology', 'description']);
    if (structured) return bad(`Role ${structured} must be plain text.`);
    const defaultAssessor = await candidateAssessorField(store, body.default_assessor_id);
    if (defaultAssessor.error) return bad(defaultAssessor.error);
    const defaultCountProblem = questionCountError(body.default_question_count);
    if (defaultCountProblem) return bad(defaultCountProblem.replace('Number of questions', 'Default allocation'));
    if (hasStrictModuleAllocation({ key: str(body.key, 60).toLowerCase() }) && body.default_question_count && Number(body.default_question_count) !== 50)
      return bad('RSA and AI/BI use a fixed 50-question module blueprint.');
    const key = str(body.key, 60).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) return bad('Key must be a slug like databricks-rsa.');
    // The uniqueness check and the insert are one step per key (shared with
    // the published-track install), so a double submit cannot create twins.
    return withLock(`role-key:${key}`, async () => {
      if ((await store.list('roles', { key })).length) return conflict('A role with this key already exists.');
      const rec = await store.insert('roles', {
        key, name: str(body.name, 120), technology: str(body.technology, 120),
        description: str(body.description, 2000),
        ...(defaultAssessor.id ? { default_assessor_id: defaultAssessor.id } : {}),
        default_question_count: body.default_question_count === undefined || body.default_question_count === null || body.default_question_count === ''
          ? MAX_ASSESSMENT_QUESTIONS : Number(body.default_question_count),
        active: true,
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
    const defaultCountProblem = questionCountError(body.default_question_count);
    if (defaultCountProblem) return bad(defaultCountProblem.replace('Number of questions', 'Default allocation'));
    if (hasStrictModuleAllocation(r) && body.default_question_count && Number(body.default_question_count) !== 50)
      return bad('RSA and AI/BI use a fixed 50-question module blueprint.');
    // Creation requires a name; an edit must not be able to blank it (the role
    // then renders as an unnamed track everywhere it is listed).
    if (body.name !== undefined && !str(body.name)) return bad('Role name is required.');
    const patch = {};
    const requestedAssessor = body.default_assessor_id === '' ? null : body.default_assessor_id;
    if (requestedAssessor !== undefined && requestedAssessor !== (r.default_assessor_id || null)) {
      const defaultAssessor = await candidateAssessorField(store, body.default_assessor_id);
      if (defaultAssessor.error) return bad(defaultAssessor.error);
      patch.default_assessor_id = defaultAssessor.id;
    }
    for (const f of ['name', 'technology', 'description']) if (body[f] !== undefined) patch[f] = str(body[f], f === 'description' ? 2000 : 120);
    if (body.default_question_count !== undefined && body.default_question_count !== null && body.default_question_count !== '') patch.default_question_count = Number(body.default_question_count);
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
    const assessor = role.default_assessor_id ? await store.get('users', role.default_assessor_id) : null;
    return ok({ role: { ...role, ...trackAssessorSummary(role, assessor), default_question_count: defaultQuestionCountForRole(role) }, competencies: comps, questions, framework: frameworks.find((f) => f.active !== false) || null });
  });

  // ------------------------------------------------ competencies

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
    // in the bank twice — refused for the same reason as the create path. The
    // check-then-write runs under the same per-role lock the create path uses:
    // two concurrent renames onto one prompt (or a rename racing a create)
    // both used to pass the check before either wrote, and both landed.
    return withLock(`questions:${merged.role_id}`, async () => {
      if (await duplicatePromptInRole(store, merged.role_id, merged.prompt, params.id)) {
        return conflict('Another question for this role already uses this prompt.');
      }
      const rec = await store.update('questions', params.id, normalizeQuestion(merged, q));
      await audit(store, auth.user, 'question_updated', 'questions', params.id, 'Question updated');
      return ok(rec);
    });
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
}
