/**
 * Provision the ECOD table set in Airtable via the Meta API, then print the
 * next step. Requires:
 *   AIRTABLE_API_KEY  (PAT with data.records:read/write AND schema.bases:write
 *                      - if your PAT lacks schema.bases:write, the script prints
 *                        the exact tables/fields to create manually instead)
 *   AIRTABLE_BASE_ID  (app...)
 */
const apiKey = process.env.AIRTABLE_API_KEY;
const baseId = process.env.AIRTABLE_BASE_ID;
const apiUrl = process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0';

if (!apiKey || !baseId) {
  console.error('Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID first.');
  process.exit(1);
}

const T = 'singleLineText', L = 'multilineText', N = { type: 'number', options: { precision: 2 } }, C = 'checkbox';
const num = N, txt = { type: T }, long = { type: L }, chk = { type: C, options: { icon: 'check', color: 'greenBright' } };

const SCHEMA = {
  users:        ['username', 'name', 'email', 'role', 'password_hash', 'candidate_id', 'created_by', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt })).concat([{ name: 'active', ...chk }]),
  sessions:     ['token', 'user_id', 'expires_at', 'created_at'].map((f) => ({ name: f, ...txt })),
  candidates:   ['name', 'email', 'phone', 'current_title', 'location', 'source', 'target_role_id', 'stage', 'created_by', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'years_experience', ...num }, { name: 'notes', ...long }]),
  roles:        ['key', 'name', 'technology', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'description', ...long }, { name: 'active', ...chk }]),
  competencies: ['role_id', 'key', 'name', 'category', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'description', ...long }, { name: 'enrichment_hint', ...long },
                         { name: 'weight', ...num }, { name: 'target_level', ...num }, { name: 'order', ...num }, { name: 'active', ...chk }]),
  questions:    ['role_id', 'competency_id', 'type', 'difficulty', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'prompt', ...long }, { name: 'help_text', ...long }, { name: 'options', ...long },
                         { name: 'correct_option_ids', ...long }, { name: 'rubric', ...long },
                         { name: 'points', ...num }, { name: 'order', ...num }, { name: 'active', ...chk }]),
  frameworks:   ['role_id', 'name', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'config', ...long }, { name: 'active', ...chk }]),
  assessments:  ['candidate_id', 'role_id', 'assessor_id', 'status', 'created_by', 'created_at', 'updated_at', 'started_at', 'submitted_at', 'scored_at', 'readiness_key', 'readiness_label'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'snapshot_json', ...long }, { name: 'report_json', ...long }, { name: 'quiz_state', ...long }, { name: 'overall_pct', ...num }]),
  responses:    ['assessment_id', 'question_id', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'answer', ...long }, { name: 'assessor_comment', ...long },
                         { name: 'auto_score', ...num }, { name: 'assessor_score', ...num }, { name: 'final_score', ...num }]),
  audit_log:    ['actor_id', 'actor_name', 'action', 'entity', 'entity_id', 'created_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'message', ...long }, { name: 'meta', ...long }]),
};

let failures = 0;
for (const [tableName, fields] of Object.entries(SCHEMA)) {
  const res = await fetch(`${apiUrl}/meta/bases/${baseId}/tables`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tableName, description: `ECOD platform table: ${tableName}`, fields }),
  });
  if (res.ok) { console.log(`[airtable] created table "${tableName}"`); continue; }
  const text = await res.text();
  if (res.status === 422 && /already exists|DUPLICATE/i.test(text)) { console.log(`[airtable] table "${tableName}" already exists - skipped`); continue; }
  failures += 1;
  console.error(`[airtable] failed to create "${tableName}" (${res.status}): ${text.slice(0, 200)}`);
}

if (failures) {
  console.log(`\n${failures} table(s) could not be created via API.`);
  console.log('If your token lacks schema.bases:write, create these tables manually in the base:');
  for (const [name, fields] of Object.entries(SCHEMA))
    console.log(`- ${name}: ${fields.map((f) => `${f.name} (${f.type === 'multilineText' ? 'long text' : f.type})`).join(', ')}`);
  process.exit(1);
}
console.log('\n[airtable] schema ready. Next: STORAGE=airtable node scripts/seed.mjs');
