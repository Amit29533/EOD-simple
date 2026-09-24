/**
 * Seed the ECOD store with:
 *  - admin / assessor / candidate accounts (usernames only ever provisioned here or by admin UI)
 *  - every published track (role, competencies, question bank, scoring framework):
 *      * Databricks RSA (databricks-rsa)
 *      * Senior Databricks AI/BI & Genie Consultant (databricks-ai-bi-genie)
 *      * Technology Risk Consultant - SAMA (technology-risk-sama)
 *      * Senior Consultant (senior-consultant) — competencies only; its
 *        question bank is authored from the Admin UI
 *  - three demo candidates at different pipeline stages, one with a fully scored example report
 *
 * Usage:
 *   node scripts/seed.mjs          # seed if empty; otherwise add newly published
 *                                  # tracks and sync newly published seed questions
 *   SEED_FRESH=1 node scripts/seed.mjs   # wipe JSON store and reseed
 *   STORAGE=airtable AIRTABLE_API_KEY=.. AIRTABLE_BASE_ID=.. node scripts/seed.mjs
 */
import fs from 'node:fs';
import { createStore } from '../src/storage/index.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { buildSnapshot, finalizeScoring, paperSummary } from '../src/api/assessment-service.mjs';
import { installCatalogue, PUBLISHED_CATALOGUES } from '../src/api/catalogue-service.mjs';
import { bulkInsert } from '../src/api/helpers.mjs';
import { RSA_ROLE, DEMO_USERS, DEMO_CANDIDATES } from './seed-content.mjs';

const env = process.env;

if ((env.SEED_FRESH === '1') && (env.STORAGE || 'json') === 'json') {
  const file = env.DATA_FILE || 'data/ecod.json';
  if (fs.existsSync(file)) { fs.rmSync(file); console.log(`[seed] wiped ${file}`); }
  // Recordings live beside the file, one JSON per clip (see
  // src/storage/row-tables.mjs); a fresh store must not inherit the old ones.
  const rows = `${file.replace(/\.json$/i, '')}.rows`;
  if (fs.existsSync(rows)) { fs.rmSync(rows, { recursive: true, force: true }); console.log(`[seed] wiped ${rows}`); }
}

const store = await createStore();
console.log(`[seed] storage backend: ${store.kind}`);

// `seed` is also safe to run against an existing demo/MVP store. This matters
// when new seed content is published: do not recreate users or assessments;
// add the published tracks the workspace does not have yet (role, default
// framework, competencies, published questions), add the new question records
// that are not already present and repair the spoken-question contract flags
// on existing copies (see installCatalogue / synchronizeBank — shared with the
// in-app "Add to workspace" / "Add published questions" actions). A track an
// admin deactivated is left alone, never re-created.
const existingAdmin = await store.list('users', { username: 'admin' });
if (existingAdmin.length) {
  for (const catalogue of Object.values(PUBLISHED_CATALOGUES)) {
    const result = await installCatalogue(store, catalogue.role.key);
    if (result.error) {
      console.log(`[seed] ${catalogue.role.key}: ${result.code === 'inactive' ? 'deactivated in this workspace, left as is' : result.error}`);
      continue;
    }
    if (result.created) {
      console.log(`[seed] published track "${result.role.name}" added: ${result.competencies_added} competencies, ${result.bank_total} questions, default framework`);
    } else {
      console.log(`[seed] existing ${catalogue.role.key} bank synchronized: added ${result.added} question(s), repaired ${result.repaired} question flag(s), ${result.bank_total} total`);
    }
  }
  process.exit(0);
}

// ---- role tracks -------------------------------------------------------
// Every published catalogue (see src/api/catalogue-service.mjs) gets its
// role, competencies, question bank and default framework — through the same
// installCatalogue the migration path and the admin UI use, so a fresh seed
// and a later "Add to workspace" produce identical tracks (batched writes
// per table; per-row writes rewrote the whole JSON store 350+ times).
// `role` below keeps pointing at the RSA track, which the demo
// candidates/assessments use.
const roleById = {};
for (const catalogue of Object.values(PUBLISHED_CATALOGUES)) {
  const result = await installCatalogue(store, catalogue.role.key);
  if (result.error) throw new Error(`[seed] ${catalogue.role.key}: ${result.error}`);
  const rec = await store.get('roles', result.role.id);
  console.log(`[seed] role track "${rec.name}": ${catalogue.competencies.length} competencies, ${catalogue.questions.length} questions`);
  roleById[catalogue.role.key] = rec;
}
const role = roleById[RSA_ROLE.key];
const rsaCompIds = Object.fromEntries(
  (await store.list('competencies', { role_id: role.id })).map((c) => [c.key, c.id]));

// ---- users -----------------------------------------------------------
const userIds = {};
const userRecs = await bulkInsert(store, 'users', DEMO_USERS.map((u) => ({
  username: u.username, name: u.name, email: u.email, role: u.role,
  password_hash: hashPassword(u.password), active: true,
})));
userRecs.forEach((rec) => { userIds[rec.username] = rec.id; });
console.log('[seed] users created:', DEMO_USERS.map((u) => `${u.username} (${u.role})`).join(', '));

// ---- candidates ------------------------------------------------------
const candIds = {};
const candRecs = await bulkInsert(store, 'candidates', DEMO_CANDIDATES.map(({ key, ...fields }) => ({
  ...fields, target_role_id: key === 'sana' ? null : role.id,
})));
DEMO_CANDIDATES.forEach(({ key }, i) => { candIds[key] = candRecs[i].id; });
// candidate login for Rohit
await store.update('users', userIds['rohit.verma'], { candidate_id: candIds.rohit });
console.log('[seed] demo candidates created; rohit.verma linked to candidate record');

// ---- assessment for Rohit (allocated to Priya, awaiting the candidate) --
const snapshot = await buildSnapshot(store, role.id);
await store.insert('assessments', {
  candidate_id: candIds.rohit, role_id: role.id, assessor_id: userIds['priya.nair'],
  status: 'assigned', snapshot_json: snapshot, report_json: null, ...paperSummary(snapshot),
  overall_pct: null, readiness_key: '', readiness_label: '', created_by: userIds.admin,
});
console.log('[seed] assessment allocated: Rohit Verma -> assessor Priya Nair (status: assigned)');

// ---- fully worked example: Neha scored by Arjun ------------------------
// Realistic-but-imperfect answers so the example report shows real gaps.
// Deep-cloned: the two demo assessments must not share one snapshot object in
// memory (a later in-place edit to either paper would otherwise rewrite both).
const nehaSnapshot = JSON.parse(JSON.stringify(snapshot));
const nehaAssessment = await store.insert('assessments', {
  candidate_id: candIds.neha, role_id: role.id, assessor_id: userIds['arjun.mehta'],
  status: 'submitted', snapshot_json: nehaSnapshot, report_json: null, ...paperSummary(nehaSnapshot),
  started_at: new Date(Date.now() - 4 * 864e5).toISOString(),
  submitted_at: new Date(Date.now() - 3 * 864e5).toISOString(),
  overall_pct: null, readiness_key: '', readiness_label: '', created_by: userIds.admin,
});

const qByComp = {};
for (const q of snapshot.questions) (qByComp[q.competency_id] ||= []).push(q);
const correctOrFirst = (q) => q.type === 'mcq_single' ? q.correct_option_ids[0] : q.correct_option_ids;
const wrongSingle = (q) => q.options.find((o) => o.id !== q.correct_option_ids[0])?.id;
// Every other question gets an answer of the RIGHT SHAPE for its type: the
// exam stores an option id for a single choice, an id list for a multi-select,
// a 1-5 number for a scale, and a { text, transcript, source } object for an
// open question (a bare string is the legacy typed-only form the assessor
// screen still renders).
const fallbackAnswer = (q) => {
  if (q.type === 'mcq_single' || q.type === 'mcq_multi') return correctOrFirst(q);
  if (q.type === 'scale') return 4;
  return 'A considered answer covering the architecture, trade-offs and rollout plan.';
};

const answers = new Map();
const scores = new Map();   // manual assessor scores per question id
// Strong written answers per competency, for the first OPEN question in each.
const textAnswers = {
  'lakehouse-architecture': 'Workspaces per environment with a shared governance layer; bronze/silver/gold zones per domain; catalog-per-environment naming (prod_retail.core.orders); start with the three highest-value marts; migrate incrementally with dual-run reconciliation.',
  'data-engineering': 'Check whether input rate exceeds processing rate from streaming metrics, inspect state store size and spill, and check 02:00 cluster contention from ganglia/system tables. Move heavy batch off the streaming window or isolate compute, enable RocksDB state backend, tune maxOffsetsPerTrigger, and make the sink MERGE idempotent with checkpoints for exactly-once.',
  'governance-security': 'Catalog per BU per environment (prod_retail, prod_lending ...), IdP-synced account groups per BU role, catalog owners from each BU with a central metastore admin, analysts get SELECT via dynamic views and row filters/column masks on PII columns, plus tags and ownership in Catalog Explorer.',
  'ml-genai': 'Chunk policies via a DLT pipeline into a UC table, sync to Vector Search, serve an LLM via Model Serving behind AI Gateway guardrails, evaluate against a curated QA set (answer correctness, faithfulness, toxicity) logged in MLflow, monitor latency/cost/quality and keep human sign-off before launch.',
  'customer-advisory': 'I would first acknowledge the failed POC openly and separate the platform question from the project question. I would bring a usage analysis showing which teams get daily value, then propose three quick wins tied to revenue or risk (e.g. fraud alerting SLA, regulatory report automation), each with an owner and a business metric. 30 days: cost guardrails + first quick win live. 60: second win + exec dashboard of platform value. 90: third win and a steering cadence.',
};
// The worked example is written BY QUESTION TYPE, not by position. The served
// paper is interleaved (open questions spread through the objective ones), so
// "the first three questions of a competency" are not [mcq, mcq, open]: the
// old positional script put a prose answer on a multi-select (auto-scored 0)
// and an empty option list on an open question, and the example report then
// showed gaps in competencies the candidate had answered well.
//
// The two deliberately weak areas are answered from the CATALOGUE order, never
// from the paper's: the paper is shuffled afresh at every allocation, so a
// right/wrong pattern keyed on paper position made the example's readiness
// label and gap count change from one seed run to the next. Each area is
// pitched one level under its target so both surface as gaps: about half the
// objective picks right (a multi-select with a partial set scores 0 — strict),
// middling or low self-ratings, thin open answers scored accordingly.
const WEAK_AREAS = {
  // Level 3 against a level-4 target (~45%).
  'performance-cost': {
    startRight: false, scale: 3, firstScore: 3, otherScore: 2,
    firstText: 'I would move the job to a larger cluster and switch on Photon, then compare run times. I have not profiled query plans or file layout in detail; I usually rely on autoscaling to absorb the cost.',
    otherText: 'I would ask the account team for a cost review and follow their recommendations.',
  },
  // Level 2 against a level-3 target (~33%).
  'devops-production': {
    startRight: false, scale: 2, firstScore: 2, otherScore: 1,
    firstText: 'I would mainly restart the cluster and re-run the job, then keep an eye on it for a few days.',
    otherText: 'I have not had to do this myself; I would ask the platform team and follow whatever they usually do.',
  },
};
const byCatalogueOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const isChoice = (q) => q.type === 'mcq_single' || q.type === 'mcq_multi';
const wrongChoice = (q) => (q.type === 'mcq_single' ? wrongSingle(q) : [q.correct_option_ids[0]]);
for (const [compKey, compId] of Object.entries(rsaCompIds)) {
  const list = [...(qByComp[compId] || [])].sort(byCatalogueOrder);
  const weak = WEAK_AREAS[compKey];
  const firstOpen = list.find((q) => q.type === 'text');
  if (weak) {
    let nth = 0;
    for (const q of list) {
      if (isChoice(q)) {
        const right = (nth % 2 === 0) === weak.startRight;
        nth += 1;
        answers.set(q.id, right ? correctOrFirst(q) : wrongChoice(q));
      } else if (q.type === 'scale') {
        answers.set(q.id, weak.scale);
      } else if (q.type === 'text') {
        answers.set(q.id, q === firstOpen ? weak.firstText : weak.otherText);
        scores.set(q.id, q === firstOpen ? weak.firstScore : weak.otherScore);
      }
    }
  } else if (firstOpen) {
    answers.set(firstOpen.id, textAnswers[compKey] || 'Detailed answer provided.');
    scores.set(firstOpen.id, compKey === 'ml-genai' ? 4 : 5);
  }
}

for (const q of snapshot.questions) {
  const manual = q.type === 'text';
  const answer = answers.get(q.id) ?? fallbackAnswer(q);
  // The worked example predates the expanded bank, so give newly added manual
  // questions a plausible passing score instead of leaving the seed unable to
  // finalize. The deliberately weak original examples above still keep their
  // lower scores and continue to surface useful gaps.
  const assessorScore = manual ? (scores.get(q.id) ?? Math.max(0, Math.ceil(q.points * 0.8))) : undefined;
  await store.insert('responses', {
    assessment_id: nehaAssessment.id, question_id: q.id,
    answer,
    auto_score: manual ? null : undefined,
    assessor_score: assessorScore,
    assessor_comment: manual
      ? (assessorScore >= 4
          ? 'Solid, structured answer with the expected evidence.'
          : 'Superficial - missing observability-driven diagnosis and durable controls.')
      : '',
  });
}

const { report, missing } = await finalizeScoring(store, nehaAssessment);
if (missing) throw new Error('seed example failed to finalize');
console.log(`[seed] example report for Neha Kulkarni: ${report.band.label} @ ${report.overall_pct}% (${report.areas_to_improve.length} improvement areas)`);

await store.insert('audit_log', {
  actor_id: userIds.admin, actor_name: 'Platform Admin', action: 'platform_seeded',
  entity: 'roles', entity_id: role.id,
  message: `ECOD seeded with ${Object.values(PUBLISHED_CATALOGUES).map((c) => c.role.name).join(', ')} and demo data`,
});

console.log('\n[seed] done. Sign in with:');
console.log('  admin        / ECOD-admin-2026      (admin dashboard)');
console.log('  priya.nair   / ECOD-assessor-2026   (assessor workspace)');
console.log('  arjun.mehta  / ECOD-assessor-2026   (assessor workspace)');
console.log('  rohit.verma  / ECOD-candidate-2026  (candidate portal)');
