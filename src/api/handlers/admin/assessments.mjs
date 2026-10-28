import {
  A, lockedAssessment, questionCountError, creationRequest, sameCreation, creationId, ok, created, bad, notFound, conflict, audit, missing, bulkRemove, withLock, buildSnapshot, advanceStage, paperSummary, allocationLockKey, hasStrictModuleAllocation, readRetentionSettings, paperRetention,
} from './shared.mjs';
import { integrityRisk } from '../../../core/integrity-risk.mjs';

/** Allocating, editing and removing assessments; integrity trail and reports. */
export function assessmentRoutes(route) {
  route('POST', '/admin/assessments', A, async (ctx) =>
    withLock(allocationLockKey(ctx.body?.candidate_id, ctx.body?.role_id), async () => {
      const { store, body, auth } = ctx;
    const miss = missing(body, ['candidate_id', 'role_id']);
    if (miss.length) return bad('candidate_id and role_id are required.');
    const candidate = await store.get('candidates', body.candidate_id);
    if (!candidate || candidate.deleting) return bad('Candidate not found or being deleted.');
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
    const request = creationRequest(body, auth.user.id);
    if (request?.error) return bad(request.error);
    if (open && sameCreation(open, request)) {
      await store.update('candidates', candidate.id, { target_role_id: candidate.target_role_id || body.role_id });
      await advanceStage(store, candidate.id, 'assessment');
      return created(await store.get('assessments', open.id));
    }
    if (open) return conflict('This candidate already has an open assessment for that role.');
    const allocationRole = await store.get('roles', body.role_id);
    if (hasStrictModuleAllocation(allocationRole) && questionLimit !== null && questionLimit !== 50)
      return bad('RSA and AI/BI require exactly 50 questions: 30 technical objective, 10 technical open and 10 non-technical open.');
    const snapshot = await buildSnapshot(store, body.role_id, { questionLimit });
    if (!snapshot) return bad(hasStrictModuleAllocation(allocationRole)
      ? 'The role’s 50-question module blueprint cannot be filled. Check active questions in every module.' : 'Role not found or inactive.');
    if (!snapshot.bank_total) return bad('That role has no active questions yet. Add questions first.');
    if (questionLimit !== null && questionLimit > snapshot.bank_total)
      return bad(`That role only has ${snapshot.bank_total} active question(s). Choose ${snapshot.bank_total} or fewer.`);
    if (!snapshot.questions.length) return bad('That role has no active questions yet. Add questions first.');
    const rec = await store.insert('assessments', {
      ...(request ? { id: creationId(request, 'assessment'), creation_request: request } : {}),
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
      // The candidate's own assessor follows, so the Edit candidate form and
      // the next auto-allocated paper agree with the reassignment.
      const cand = await store.get('candidates', a.candidate_id);
      if (cand && (cand.assessor_id || null) !== (body.assessor_id || null)) {
        await store.update('candidates', cand.id, { assessor_id: body.assessor_id || null });
      }
      await audit(store, auth.user, 'assessment_reassigned', 'assessments', params.id, 'Assessor allocation updated');
      return ok(updated);
    }
    return bad('Nothing to update.');
  }));

  route('DELETE', '/admin/assessments/:id', A, lockedAssessment(async ({ store, params, auth }) => {
    const a = await store.get('assessments', params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress', 'cancelled'].includes(a.status))
      return conflict('Only assessments that have not been submitted can be deleted.');
    if (a.booking_id) {
      const decide = (booking) => booking && ['pending', 'booked'].includes(booking.status)
        ? { status: 'cancelled', provisioning_json: null } : undefined;
      if (typeof store.changeRow === 'function') await store.changeRow('test_bookings', { id: a.booking_id }, decide);
      else {
        const patch = decide(await store.get('test_bookings', a.booking_id));
        if (patch) await store.update('test_bookings', a.booking_id, patch);
      }
    }
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
      integrity_risk: integrityRisk(quiz),
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
    const { settings: retention } = await readRetentionSettings(store);
    return ok({
      candidate: { id: candidate?.id, name: candidate?.name, current_title: candidate?.current_title, email: candidate?.email },
      assessor_name: assessor?.name || 'Unassigned',
      report: a.report_json,
      status: a.status,
      // Is the evidence behind this report (answer sheet, transcripts,
      // recordings) still kept, or already removed by the cleanup?
      retention: paperRetention(a, retention),
      integrity_risk: integrityRisk(a.quiz_state),
    });
  });

  // ------------------------------------------------ audit log
}
