/**
 * Bounded growth policy for the append-only audit table.
 *
 * Every state-changing request appends an audit row, so an unbounded table is a
 * slow leak in the one file/blob the whole store rewrites on each write. The
 * trim runs on the write path (not a scheduled job, because there is no
 * scheduler) and removes a batch rather than a single row, so the table hovers
 * just under the cap instead of paying a trim on every subsequent insert.
 *
 * Shared by every storage adapter: rotation is a property of the audit table,
 * not of the medium it is stored on, and per-adapter copies of this rule drift.
 */

export const AUDIT_TABLE = 'audit_log';
export const AUDIT_MAX_ROWS = 2000;
export const AUDIT_TRIM_ROWS = 500;

/**
 * Drop the oldest rows when the table has outgrown the cap. Mutates the given
 * id-keyed row object in place and returns how many rows it removed.
 *
 * Insert paths only — never the update path: audit rows are append-only, so a
 * bulk insert that skipped this check would be the one place the cap leaks.
 */
export function trimAuditRows(rowsById) {
  const all = Object.values(rowsById);
  if (all.length <= AUDIT_MAX_ROWS) return 0;
  all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let removed = 0;
  for (const row of all.slice(0, AUDIT_TRIM_ROWS)) {
    delete rowsById[row.id];
    removed += 1;
  }
  return removed;
}
