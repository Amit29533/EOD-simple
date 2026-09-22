/**
 * Table registry shared by every storage adapter.
 * `json` lists fields that hold structured data. Airtable stores those as
 * JSON strings in long-text fields; the file/blobs adapters keep them native.
 */
export const TABLES = {
  users:        { json: [], flags: ['active'] },
  sessions:     { json: [], flags: [] },
  candidates:   { json: [], flags: [] },
  roles:        { json: [], flags: ['active'] },
  competencies: { json: [], flags: ['active'] },
  questions:    { json: ['options', 'correct_option_ids'], flags: ['active', 'pin_first', 'audio_required'] },
  // Admin-authored bank questions. The published bank in src/content is
  // generated and read-only, so additions live here and are merged over it.
  bank_questions: { json: ['options', 'correct_option_ids', 'probes', 'tags'], flags: ['active', 'randomizable', 'needs_option_review'] },
  // Visibility overrides for published questions. A published question cannot
  // be edited or hard-deleted (it lives in a generated file), but an admin
  // can remove it from circulation: { question_id, active: false }. Restoring
  // deletes the override row. Merged over the published set in effectiveBank.
  bank_question_overrides: { json: [], flags: ['active'] },
  frameworks:   { json: ['config'], flags: ['active'] },
  // A whole-bank paper (100+ questions with options, rubrics and help text)
  // and its report run past a single 100,000-character Airtable cell; a
  // recorded answer (up to 400,000 base64 characters of audio) always does.
  // The file and blob adapters keep the paper and the report OUTSIDE the
  // assessments table object (src/storage/row-tables.mjs DETACHED_COLUMNS):
  // the row itself is small and is rewritten on every exam step. Listings
  // read the paper facts kept beside it (question_count, total_points,
  // question_limit, bank_total, role_name — assessment-service paperSummary).
  assessments:  { json: ['snapshot_json', 'report_json', 'quiz_state'], flags: [],
                  overflow: { snapshot_json: 3, report_json: 1, quiz_state: 1 } },
  // One object per assessment in the file and blob adapters (SHARD_TABLES):
  // every read filters by assessment_id, and the exam step that writes it
  // must not carry — or collide with — every other candidate's paper.
  responses:    { json: ['answer'], flags: ['locked'], overflow: { answer: 4 } },
  // One recorded spoken answer per (assessment, question): `audio` is
  // `{ b64, mime }`, up to ~400,000 characters. Kept off the response row so
  // the exam's per-request reads and the assessor's detail payload stay small;
  // the file and blob adapters store this table one object per row
  // (src/storage/row-tables.mjs), Airtable one record with continuation cells.
  recordings:   { json: ['audio'], flags: [], overflow: { audio: 4 } },
  audit_log:    { json: ['meta'], flags: [] },
};

/**
 * `flags` lists the boolean columns. The application distinguishes an explicit
 * `false` from "not set" (`active === false` means deactivated; `pin_first`,
 * `locked` and the bank flags are read the same way), and Airtable stores a
 * boolean as a checkbox — which its API omits from the record when unchecked.
 * An adapter that cannot round-trip `false` natively must restore it for these
 * columns on read, or a deactivated login reads back as active.
 *
 * `overflow` names the JSON columns that may exceed one Airtable text cell
 * (100,000 characters) and how many continuation columns each has. The
 * continuation column for `answer` piece 2 is `answer__2`, and so on; see
 * `overflowColumns()` — the Airtable adapter splits/rejoins transparently and
 * `scripts/airtable-setup.mjs` provisions the columns.
 */
export const overflowColumn = (field, index) => `${field}__${index}`;
export function overflowColumns(table) {
  const out = [];
  for (const [field, extra] of Object.entries(TABLES[table]?.overflow || {})) {
    for (let i = 2; i <= extra + 1; i += 1) out.push(overflowColumn(field, i));
  }
  return out;
}
export const TABLE_NAMES = Object.keys(TABLES);

/**
 * Storage adapter contract (implemented by json-file, airtable, netlify-blobs):
 *   list(table, filter?, opts?) -> Promise<record[]> // filter = equality AND of primitives;
 *                                                // opts.detached === false lets an adapter
 *                                                // that stores heavy columns apart
 *                                                // (row-tables.mjs DETACHED_COLUMNS) leave
 *                                                // them out — listings must then use the
 *                                                // paper facts on the row, not the paper
 *   get(table, id)        -> Promise<record|null> // always the full record
 *   insert(table, data)   -> Promise<record>     // id generated when absent
 *   insertMany(table, rows) -> Promise<record[]> // optional; atomic-ish batch write,
 *                                                // same per-row semantics as insert,
 *                                                // order preserved. Handlers fall back
 *                                                // to a loop when an adapter lacks it.
 *   update(table, id, patch) -> Promise<record|null>
 *   remove(table, id)     -> Promise<boolean>
 */
