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

// Importable (tests pin SCHEMA coverage) without provisioning: the run below
// only fires when the file is executed directly.
import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

const T = 'singleLineText', L = 'multilineText', N = { type: 'number', options: { precision: 2 } }, C = 'checkbox';
const num = N, txt = { type: T }, long = { type: L }, chk = { type: C, options: { icon: 'check', color: 'greenBright' } };

/**
 * Every field the application writes must exist here: Airtable rejects record
 * writes carrying an unknown field (422), so a missing column breaks the
 * feature that writes it — allocation (`assessments.question_count`), exam
 * locking (`responses.locked`), the spoken-question contract
 * (`questions.question_set/pin_first/audio_required`) and bank authoring (the
 * `bank_questions`/`bank_question_overrides` tables) all failed on Airtable
 * until those were added. `updated_at` is on every table the app updates (the
 * adapter stamps it on each PATCH); insert-only tables omit it. Exported so
 * tests can pin the coverage.
 */
export const SCHEMA = {
  users:        ['username', 'name', 'email', 'role', 'password_hash', 'candidate_id', 'created_by', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt })).concat([{ name: 'active', ...chk }]),
  sessions:     ['token', 'user_id', 'expires_at', 'created_at'].map((f) => ({ name: f, ...txt })),
  candidates:   ['name', 'email', 'phone', 'current_title', 'location', 'source', 'target_role_id', 'stage', 'created_by', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'years_experience', ...num }, { name: 'notes', ...long }]),
  roles:        ['key', 'name', 'technology', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'description', ...long }, { name: 'active', ...chk }]),
  competencies: ['role_id', 'key', 'name', 'category', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'description', ...long }, { name: 'enrichment_hint', ...long },
                         { name: 'weight', ...num }, { name: 'target_level', ...num }, { name: 'order', ...num }, { name: 'active', ...chk }]),
  questions:    ['role_id', 'competency_id', 'type', 'question_set', 'difficulty', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'prompt', ...long }, { name: 'help_text', ...long }, { name: 'options', ...long },
                         { name: 'correct_option_ids', ...long }, { name: 'rubric', ...long },
                         { name: 'points', ...num }, { name: 'order', ...num },
                         { name: 'active', ...chk }, { name: 'pin_first', ...chk }, { name: 'audio_required', ...chk }]),
  bank_questions: ['module', 'family_id', 'family', 'type', 'band', 'mode', 'gap_tag', 'created_by', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'prompt', ...long }, { name: 'options', ...long }, { name: 'correct_option_ids', ...long },
                         { name: 'rationale', ...long }, { name: 'probes', ...long }, { name: 'rubric', ...long },
                         { name: 'tags', ...long }, { name: 'red_flags', ...long }, { name: 'enrichment', ...long },
                         { name: 'difficulty', ...num }, { name: 'minutes', ...num },
                         { name: 'active', ...chk }, { name: 'randomizable', ...chk }, { name: 'needs_option_review', ...chk }]),
  bank_question_overrides: ['question_id', 'created_by', 'created_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'active', ...chk }]),
  frameworks:   ['role_id', 'name', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'config', ...long }, { name: 'active', ...chk }]),
  assessments:  ['candidate_id', 'role_id', 'assessor_id', 'status', 'created_by', 'created_at', 'updated_at', 'started_at', 'submitted_at', 'scored_at', 'readiness_key', 'readiness_label'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'snapshot_json', ...long }, { name: 'report_json', ...long }, { name: 'quiz_state', ...long },
                         { name: 'overall_pct', ...num }, { name: 'question_count', ...num }]),
  responses:    ['assessment_id', 'question_id', 'created_at', 'updated_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'answer', ...long }, { name: 'assessor_comment', ...long },
                         { name: 'auto_score', ...num }, { name: 'assessor_score', ...num }, { name: 'final_score', ...num },
                         { name: 'locked', ...chk }]),
  audit_log:    ['actor_id', 'actor_name', 'action', 'entity', 'entity_id', 'created_at'].map((f) => ({ name: f, ...txt }))
                .concat([{ name: 'message', ...long }, { name: 'meta', ...long }]),
};

async function main() {
  if (!apiKey || !baseId) {
    console.error('Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID first.');
    process.exit(1);
  }
  let failures = 0;
  let skipped = 0;
  for (const [tableName, fields] of Object.entries(SCHEMA)) {
    const res = await fetch(`${apiUrl}/meta/bases/${baseId}/tables`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tableName, description: `ECOD platform table: ${tableName}`, fields }),
    });
    if (res.ok) { console.log(`[airtable] created table "${tableName}"`); continue; }
    const text = await res.text();
    if (res.status === 422 && /already exists|DUPLICATE/i.test(text)) { console.log(`[airtable] table "${tableName}" already exists - skipped`); skipped += 1; continue; }
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
  if (skipped) {
    // Existing tables are left untouched, so a base created by an older run
    // keeps its old columns: name the fields that must exist for the current
    // app to write to it.
    console.log('\n[airtable] existing tables were left untouched. If this base was created by an older');
    console.log('[airtable] run, add any missing columns manually: questions.question_set,');
    console.log('[airtable] questions.pin_first, questions.audio_required, assessments.question_count,');
    console.log('[airtable] responses.locked, and the bank_questions / bank_question_overrides tables.');
  }
  console.log('\n[airtable] schema ready. Next: STORAGE=airtable node scripts/seed.mjs');
}

if (isMain) await main();
