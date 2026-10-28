import {
  A, roleKeyOf, ok, created, bad, conflict, audit, str, missing, withLock, catalogueStatus, syncCatalogue, catalogueForRoleKey, listCatalogues, installCatalogue,
} from './shared.mjs';

/** Published catalogue sync and track installation. */
export function contentRoutes(route) {
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
}
