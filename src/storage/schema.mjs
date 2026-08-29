/**
 * Table registry shared by every storage adapter.
 * `json` lists fields that hold structured data. Airtable stores those as
 * JSON strings in long-text fields; the file/blobs adapters keep them native.
 */
export const TABLES = {
  users:        { json: [] },
  sessions:     { json: [] },
  candidates:   { json: [] },
  roles:        { json: [] },
  competencies: { json: [] },
  questions:    { json: ['options', 'correct_option_ids'] },
  frameworks:   { json: ['config'] },
  assessments:  { json: ['snapshot_json', 'report_json', 'quiz_state'] },
  responses:    { json: ['answer'] },
  audit_log:    { json: ['meta'] },
};
export const TABLE_NAMES = Object.keys(TABLES);

/**
 * Storage adapter contract (implemented by json-file, airtable, netlify-blobs):
 *   list(table, filter?)  -> Promise<record[]>   // filter = equality AND of primitives
 *   get(table, id)        -> Promise<record|null>
 *   insert(table, data)   -> Promise<record>     // id generated when absent
 *   update(table, id, patch) -> Promise<record|null>
 *   remove(table, id)     -> Promise<boolean>
 */
