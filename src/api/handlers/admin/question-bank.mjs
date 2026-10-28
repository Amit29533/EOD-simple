import {
  MAX_IMPORT_ROWS, mergeForPatch, setPublishedVisibility, importTemplateCsv, importColumnsFor, readImportPayload, A, roleKeyOf, requireBank, bankContext, ok, created, bad, notFound, conflict, unprocessable, audit, bool, bulkInsert, withLock, defaultQuestionCountForRole, roleBank, automaticSnapshotFromBank, hasStrictModuleAllocation, DEFAULT_MODULE_BANK_ROLE_KEY, generateTest, testPlan, blueprintFor, isActive, validateBankQuestion, validateBatch, promptKey, effectiveBank, composeFamilies, resolveFamily, nextAuthoredId, toStoredRecord, hydrate,
} from './shared.mjs';

/** Question Bank: modules, families, plans, authoring and spreadsheet import. */
export function questionBankRoutes(route) {
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
    if (body.mode === 'allocation') {
      const role = (await store.list('roles', { key: roleKey })).find((r) => r.active !== false);
      if (!role) return bad('Install and activate this role before previewing its allocated assessment.');
      const bank = await roleBank(store, role.id);
      const snapshot = automaticSnapshotFromBank(bank);
      if (!snapshot?.questions.length) return unprocessable('The active question bank cannot fill this role’s default assessment.');
      const counts = { total: snapshot.questions.length, technical_objective: 0, technical_open: 0, non_technical_objective: 0, non_technical_open: 0, from_optional: 0 };
      const comps = new Map(bank.competencies.map((c) => [c.id, c]));
      const questions = snapshot.questions.map((q) => {
        const comp = comps.get(q.competency_id);
        const nonTechnical = hasStrictModuleAllocation(role) ? !q.module.startsWith('T') : ['advisory', 'behavioral'].includes(comp?.category);
        counts[`${nonTechnical ? 'non_technical' : 'technical'}_${q.type === 'text' ? 'open' : 'objective'}`]++;
        return { id: q.id, module: q.module || comp?.name || '', family: q.family || (q.type === 'scale' ? 'Scale' : ''), type: q.type === 'text' ? 'open' : 'objective', prompt: q.prompt };
      });
      const requested = defaultQuestionCountForRole(role);
      return ok({ mode: 'allocation', role_name: role.name, requested, counts, blueprint: counts, sections: snapshot.allocation_blueprint?.sections || [], questions,
        warnings: counts.total < requested ? [`Only ${counts.total} eligible questions are available for the configured ${requested}-question assessment.`] : [] });
    }
    const bank = requireBank(roleKey);
    if (!bank) return bad(`No published module bank for role key "${roleKey}".`);
    const { questions } = await bankContext(store, roleKey);
    const optionalQuestions = bank.optional ? bank.optional.questions : [];
    const result = generateTest({
      modules: bank.modules,
      questions: [...questions, ...optionalQuestions],
    });
    return ok({
      mode: 'module-template',
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
    // One step per bank, same lock as the create and import routes: the
    // authored-row edit below is a read-then-check-then-write (duplicate
    // prompt, in-place update), and the published-row branch's override is a
    // check-then-insert. Unlocked, two concurrent renames onto one prompt —
    // or a rename racing a create — both passed the check and both landed.
    return withLock(`bank:${roleKey}`, async () => {
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
}
