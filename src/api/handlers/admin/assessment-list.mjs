import {
  A, paginate, expireExam, ok, bad, notFound, unprocessable, missing, MAX_ASSESSMENT_QUESTIONS, roleBank, automaticSnapshotFromBank, paperFacts, allocationPreview, hasStrictModuleAllocation, catalogueMissing, catalogueForRoleKey, readRetentionSettings, sweepInBackground, paperRetention,
} from './shared.mjs';
import { integrityRisk } from '../../../core/integrity-risk.mjs';

/** Assessment listing and the allocation question plan. */
export function assessmentListRoutes(route) {
  route('GET', '/admin/assessments', A, async ({ store, query }) => {
    // Small columns only: the papers stay in their own objects (one fetch per
    // row would make this listing cost every paper ever allocated).
    let rows = await store.list('assessments', {}, { detached: false });
    rows = await Promise.all(rows.map((a) => expireExam(store, a)));
    // Opportunistic cleanup (no scheduler in this deployment): the listing the
    // admin is looking at is exactly the set the policy applies to. Never
    // awaited — the response is already built from the rows below.
    const { settings: retention } = await readRetentionSettings(store);
    sweepInBackground(store, { rows });
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
        integrity_risk: integrityRisk(a.quiz_state),
        // Whether this paper's raw material is still here, and when the
        // cleanup will take it (src/core/retention.mjs).
        retention: paperRetention(a, retention),
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
    if (hasStrictModuleAllocation(bank.role)) {
      const snapshot = automaticSnapshotFromBank(bank);
      if (!snapshot) return unprocessable('The 50-question module blueprint cannot be filled. Check active questions in each module.');
      return ok({ role: { id: bank.role.id, name: bank.role.name }, max_questions: 50, required_question_count: 50,
        allocation_mode: 'module', catalogue: null,
        ...allocationPreview(snapshot.questions, snapshot.competencies, 50), bank_total: bank.questions.length,
        blueprint: snapshot.allocation_blueprint, per_module: snapshot.allocation_blueprint.sections });
    }
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
}
