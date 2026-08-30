/**
 * Seed the ECOD store with:
 *  - admin / assessor / candidate accounts (usernames only ever provisioned here or by admin UI)
 *  - the Databricks RSA track: role, competencies (weights), question bank, scoring framework
 *  - three demo candidates at different pipeline stages, one with a fully scored example report
 *
 * Usage:
 *   node scripts/seed.mjs          # seed if empty; sync newly published seed questions otherwise
 *   SEED_FRESH=1 node scripts/seed.mjs   # wipe JSON store and reseed
 *   STORAGE=airtable AIRTABLE_API_KEY=.. AIRTABLE_BASE_ID=.. node scripts/seed.mjs
 */
import fs from 'node:fs';
import { createStore } from '../src/storage/index.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG } from '../src/core/constants.mjs';
import { requiresSpokenAnswer } from '../src/core/spoken-answer.mjs';
import { buildSnapshot, finalizeScoring } from '../src/api/assessment-service.mjs';
import { synchronizeBank } from '../src/api/catalogue-service.mjs';
import { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS, DEMO_USERS, DEMO_CANDIDATES } from './seed-content.mjs';

const env = process.env;

if ((env.SEED_FRESH === '1') && (env.STORAGE || 'json') === 'json') {
  const file = env.DATA_FILE || 'data/ecod.json';
  if (fs.existsSync(file)) { fs.rmSync(file); console.log(`[seed] wiped ${file}`); }
}

const store = await createStore();
console.log(`[seed] storage backend: ${store.kind}`);

const questionRecord = (q, roleId, compIds) => ({
  role_id: roleId, competency_id: compIds[q.competency],
  type: q.type, prompt: q.prompt, help_text: q.help_text || '',
  options: q.options || [], correct_option_ids: q.correct_option_ids || [],
  points: q.points, difficulty: q.difficulty, rubric: q.rubric || '', order: q.order, active: true,
  question_set: q.question_set || '',
  pin_first: q.pin_first === true,
  // Mirrors the published-catalogue service: an open question is stored as a
  // recorded-answer question (core/spoken-answer.mjs), not by opt-in.
  audio_required: requiresSpokenAnswer(q),
});

// `seed` is also safe to run against an existing demo/MVP store. This matters
// when new seed content is published: do not recreate users or assessments,
// just add the new question records that are not already present and repair
// the spoken-question contract flags on existing copies (see
// synchronizeBank — shared with the in-app published-catalogue sync).
const existingAdmin = await store.list('users', { username: 'admin' });
if (existingAdmin.length) {
  const existingRole = (await store.list('roles', { key: RSA_ROLE.key }))[0];
  if (!existingRole) {
    console.log('[seed] admin user already exists; no RSA role found, so no seed migration was applied.');
    process.exit(0);
  }
  const result = await synchronizeBank(store, existingRole);
  console.log(`[seed] existing RSA bank synchronized: added ${result.added} question(s), repaired ${result.repaired} question flag(s), ${result.bank_total} total`);
  process.exit(0);
}

// ---- role track ------------------------------------------------------
const role = await store.insert('roles', { ...RSA_ROLE, active: true });
const compIds = {};
for (const c of RSA_COMPETENCIES) {
  const rec = await store.insert('competencies', { ...c, role_id: role.id, active: true });
  compIds[c.key] = rec.id;
}
for (const q of RSA_QUESTIONS) await store.insert('questions', questionRecord(q, role.id, compIds));
await store.insert('frameworks', { role_id: role.id, name: 'ECOD Readiness Framework v1', config: DEFAULT_FRAMEWORK_CONFIG, active: true });
console.log(`[seed] role track "${role.name}": ${RSA_COMPETENCIES.length} competencies, ${RSA_QUESTIONS.length} questions`);

// ---- users -----------------------------------------------------------
const userIds = {};
for (const u of DEMO_USERS) {
  const rec = await store.insert('users', {
    username: u.username, name: u.name, email: u.email, role: u.role,
    password_hash: hashPassword(u.password), active: true,
  });
  userIds[u.username] = rec.id;
}
console.log('[seed] users created:', DEMO_USERS.map((u) => `${u.username} (${u.role})`).join(', '));

// ---- candidates ------------------------------------------------------
const candIds = {};
for (const c of DEMO_CANDIDATES) {
  const { key, ...fields } = c;
  const rec = await store.insert('candidates', { ...fields, target_role_id: key === 'sana' ? null : role.id });
  candIds[key] = rec.id;
}
// candidate login for Rohit
await store.update('users', userIds['rohit.verma'], { candidate_id: candIds.rohit });
console.log('[seed] demo candidates created; rohit.verma linked to candidate record');

// ---- assessment for Rohit (allocated to Priya, awaiting the candidate) --
const snapshot = await buildSnapshot(store, role.id);
const rohitAssessment = await store.insert('assessments', {
  candidate_id: candIds.rohit, role_id: role.id, assessor_id: userIds['priya.nair'],
  status: 'assigned', snapshot_json: snapshot, report_json: null,
  overall_pct: null, readiness_key: '', readiness_label: '', created_by: userIds.admin,
});
console.log('[seed] assessment allocated: Rohit Verma -> assessor Priya Nair (status: assigned)');

// ---- fully worked example: Neha scored by Arjun ------------------------
// Realistic-but-imperfect answers so the example report shows real gaps.
const nehaAssessment = await store.insert('assessments', {
  candidate_id: candIds.neha, role_id: role.id, assessor_id: userIds['arjun.mehta'],
  status: 'submitted', snapshot_json: snapshot, report_json: null,
  started_at: new Date(Date.now() - 4 * 864e5).toISOString(),
  submitted_at: new Date(Date.now() - 3 * 864e5).toISOString(),
  overall_pct: null, readiness_key: '', readiness_label: '', created_by: userIds.admin,
});

const qByComp = {};
for (const q of snapshot.questions) (qByComp[q.competency_id] ||= []).push(q);
const correctOrFirst = (q) => q.type === 'mcq_single' ? q.correct_option_ids[0] : q.correct_option_ids;
const wrongSingle = (q) => q.options.find((o) => o.id !== q.correct_option_ids[0])?.id;
const fallbackAnswer = (q) => {
  if (q.type === 'mcq_single' || q.type === 'mcq_multi') return correctOrFirst(q);
  if (q.type === 'scale') return 4;
  return 'A considered answer covering the architecture, trade-offs and rollout plan.';
};

const answers = new Map();
const scores = new Map();   // manual assessor scores per question id
for (const [compKey, compId] of Object.entries(compIds)) {
  const [q1, q2, q3] = qByComp[compId];
  if (compKey === 'devops-production' || compKey === 'performance-cost') {
    // deliberately weak areas for the example -> they surface as gaps
    if (q1.type === 'mcq_single') answers.set(q1.id, wrongSingle(q1));
    if (q2.type === 'mcq_multi') answers.set(q2.id, [q2.correct_option_ids[0]]); // partial set => 0 (strict)
    answers.set(q3.id, 'I would mainly restart the cluster and re-run the job, then keep an eye on it for a few days.');
    scores.set(q3.id, 2);
  } else if (q2?.type === 'scale') {
    answers.set(q1.id, correctOrFirst(q1));
    answers.set(q2.id, 4);
    answers.set(q3.id,
      'I would first acknowledge the failed POC openly and separate the platform question from the project question. I would bring a usage analysis showing which teams get daily value, then propose three quick wins tied to revenue or risk (e.g. fraud alerting SLA, regulatory report automation), each with an owner and a business metric. 30 days: cost guardrails + first quick win live. 60: second win + exec dashboard of platform value. 90: third win and a steering cadence.');
    scores.set(q3.id, 5);
  } else {
    answers.set(q1.id, correctOrFirst(q1));
    answers.set(q2.id, correctOrFirst(q2));
    const textAnswers = {
      'lakehouse-architecture': 'Workspaces per environment with a shared governance layer; bronze/silver/gold zones per domain; catalog-per-environment naming (prod_retail.core.orders); start with the three highest-value marts; migrate incrementally with dual-run reconciliation.',
      'data-engineering': 'Check whether input rate exceeds processing rate from streaming metrics, inspect state store size and spill, and check 02:00 cluster contention from ganglia/system tables. Move heavy batch off the streaming window or isolate compute, enable RocksDB state backend, tune maxOffsetsPerTrigger, and make the sink MERGE idempotent with checkpoints for exactly-once.',
      'governance-security': 'Catalog per BU per environment (prod_retail, prod_lending ...), IdP-synced account groups per BU role, catalog owners from each BU with a central metastore admin, analysts get SELECT via dynamic views and row filters/column masks on PII columns, plus tags and ownership in Catalog Explorer.',
      'ml-genai': 'Chunk policies via a DLT pipeline into a UC table, sync to Vector Search, serve an LLM via Model Serving behind AI Gateway guardrails, evaluate against a curated QA set (answer correctness, faithfulness, toxicity) logged in MLflow, monitor latency/cost/quality and keep human sign-off before launch.',
      'customer-advisory': undefined, // handled by scale branch
    };
    answers.set(q3.id, textAnswers[compKey] || 'Detailed answer provided.');
    scores.set(q3.id, compKey === 'ml-genai' ? 4 : 5);
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
  entity: 'roles', entity_id: role.id, message: 'ECOD seeded with Databricks RSA track and demo data',
});

console.log('\n[seed] done. Sign in with:');
console.log('  admin        / ECOD-admin-2026      (admin dashboard)');
console.log('  priya.nair   / ECOD-assessor-2026   (assessor workspace)');
console.log('  arjun.mehta  / ECOD-assessor-2026   (assessor workspace)');
console.log('  rohit.verma  / ECOD-candidate-2026  (candidate portal)');
