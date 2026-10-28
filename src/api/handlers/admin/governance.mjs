import {
  A, ok, created, bad, audit, readRetentionSettings, saveRetentionSettings, runRetentionSweep, retentionStatus, DEFAULT_RETENTION,
} from './shared.mjs';

/** Audit log and the retention policy. */
export function governanceRoutes(route) {
  route('GET', '/admin/audit', A, async ({ store, query }) => {
    let rows = await store.list('audit_log');
    if (query.entity) rows = rows.filter((r) => r.entity === query.entity);
    if (query.action) rows = rows.filter((r) => r.action === query.action);
    if (query.actor_id) rows = rows.filter((r) => r.actor_id === query.actor_id);
    if (query.entity_id) rows = rows.filter((r) => r.entity_id === query.entity_id);
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    // Hard cap 200 for audit to prevent unbounded growth in response
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 200));
    const offset = Math.max(0, Number(query.offset) || 0);
    const total = rows.length;
    const slice = rows.slice(offset, offset + limit);
    return ok({ events: slice, total, limit, offset });
  });

  // ------------------------------------------------ settings: data retention
  /**
   * How long the raw material of a finished assessment is kept — the answer
   * sheet (typed notes + transcripts, and the objective answers when the scope
   * is `all`) and the recorded clips. Defaults to 30 days from the moment the
   * report was generated; the policy itself lives in src/core/retention.mjs.
   *
   * Reads the effective policy plus the counts the screen shows. A backend
   * without a settings table (an Airtable base created before this feature)
   * still answers with the defaults and says `provisioned: false`, so the page
   * explains what to run instead of failing.
   */
  route('GET', '/admin/settings/retention', A, async ({ store }) => {
    const { settings, row, provisioned, error } = await readRetentionSettings(store);
    // Deliberately NO cleanup here, unlike the dashboard and the assessments
    // list: this is the screen an admin opens to *decide* the policy, and it
    // must report what is due rather than act on it (and never clear a paper
    // under the policy the admin is halfway through changing). The button below
    // runs it explicitly.
    const rows = await store.list('assessments', {}, { detached: false });
    const status = await retentionStatus(store, settings, { rows });
    let updated_by_name = null;
    if (row?.updated_by) {
      const user = await store.get('users', row.updated_by);
      updated_by_name = user?.name || null;
    }
    return ok({
      settings,
      // The documented defaults, so the screen can say what "unset" means.
      defaults: DEFAULT_RETENTION,
      status,
      updated_at: row?.updated_at || null,
      updated_by_name,
      provisioned,
      ...(provisioned ? {} : { detail: `The settings table is not available on this backend yet (${error || 'not found'}).` }),
    });
  });

  route('PUT', '/admin/settings/retention', A, async ({ store, body, auth }) => {
    const saved = await saveRetentionSettings(store, body, auth.user);
    if (saved.error) return bad(saved.error);
    await audit(store, auth.user, 'retention_settings_updated', 'settings', saved.row?.id || 'retention',
      `Answer-sheet retention set to ${saved.settings.days} day(s) `
      + `(answers: ${saved.settings.auto_delete_answer_sheets ? saved.settings.scope : 'kept'}, `
      + `recordings: ${saved.settings.auto_delete_recordings ? 'deleted' : 'kept'})`,
      { settings: saved.settings });
    const rows = await store.list('assessments', {}, { detached: false });
    return ok({ settings: saved.settings, status: await retentionStatus(store, saved.settings, { rows }) });
  });

  /**
   * Run the cleanup now, for the papers that are due. Never deletes anything
   * early: a paper is only taken once its retention window has elapsed under
   * the CURRENT settings (set the period to 0 to clear a paper immediately).
   * Capped at 25 papers per run — press again for the rest.
   */
  route('POST', '/admin/retention/run', A, async ({ store, auth }) => {
    const result = await runRetentionSweep(store, { actor: auth.user, reason: 'retention' });
    const rows = await store.list('assessments', {}, { detached: false });
    if (result.ran && result.purged) {
      await audit(store, auth.user, 'retention_cleanup_run', 'settings', 'retention',
        `Retention cleanup removed ${result.rows} answer row(s) and ${result.clips} recording(s) from ${result.purged} assessment(s)`,
        { papers: result.papers.map((p) => p.id) });
    }
    return ok({
      ran: result.ran,
      reason: result.reason || null,
      purged: result.purged || 0,
      rows: result.rows || 0,
      clips: result.clips || 0,
      failed: result.failed || 0,
      remaining: result.remaining || 0,
      status: await retentionStatus(store, result.settings, { rows }),
    });
  });
}
