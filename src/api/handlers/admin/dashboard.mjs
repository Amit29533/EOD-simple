import {
  A, listBookings, expireExam, ok, PIPELINE_STAGES, sweepInBackground,
} from './shared.mjs';

/** Admin dashboard counts and upcoming work. */
export function dashboardRoutes(route) {
  // ------------------------------------------------ dashboard
  route('GET', '/admin/dashboard', A, async ({ store }) => {
    // Repair interrupted booking-to-profile creation before counting candidates.
    const bookings = await listBookings(store);
    const upcoming = bookings.filter((b) => b.status === 'booked' && !['submitted', 'scored', 'validated', 'cancelled', 'unavailable'].includes(b.assessment_status)
      && Date.parse(b.scheduled_end_at || b.scheduled_at) > Date.now());
    const [candidates, listedAssessments, roles] = await Promise.all([
      store.list('candidates'), store.list('assessments', {}, { detached: false }), store.list('roles'),
    ]);
    const assessments = await Promise.all(listedAssessments.map((a) => expireExam(store, a)));
    // Opportunistic retention cleanup from the one screen an admin opens first
    // (see src/api/retention-service.mjs): the rows are already in hand, so
    // this costs no extra listing and is never awaited.
    sweepInBackground(store, { rows: assessments });
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
        upcoming_tests: upcoming.length,
      },
      by_stage: byStage,
      by_status: byStatus,
      recent_activity: auditRows,
      upcoming_tests: upcoming.slice(0, 10),
    });
  });

  // ------------------------------------------------ candidates
  // Pagination: limit/offset to prevent OOM on large directories. Default 200, max 500.
}
