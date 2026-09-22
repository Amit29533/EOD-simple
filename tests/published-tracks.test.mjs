import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJsonStore } from '../src/storage/json-file.mjs';
import { createApp } from '../src/api/app.mjs';
import { hashPassword } from '../src/core/passwords.mjs';
import { DEFAULT_FRAMEWORK_CONFIG, MAX_ASSESSMENT_QUESTIONS } from '../src/core/constants.mjs';
import { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS } from '../src/content/rsa-catalogue.mjs';
import { AIBI_ROLE, AIBI_COMPETENCIES, AIBI_QUESTIONS } from '../src/content/ai-bi-genie-catalogue.mjs';
import { SC_ROLE, SC_COMPETENCIES } from '../src/content/senior-consultant-catalogue.mjs';
import { installCatalogue, listCatalogues, PUBLISHED_CATALOGUES } from '../src/api/catalogue-service.mjs';

/**
 * Published tracks that arrive after a workspace was seeded.
 *
 * The AI/BI & Genie and Senior Consultant catalogues are registered in code,
 * but a workspace seeded before they existed has no role for them: the
 * catalogue sync has nothing to attach to, `npm run seed` used to skip roles
 * it could not find, and the tracks never showed under Roles & frameworks —
 * while the static module bank still listed AI/BI on the Question Bank
 * screen. Installing a published track (API, seed migration and UI) closes
 * that gap.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A workspace seeded before the new tracks were published: RSA only. */
async function legacyStore({ withRsa = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecod-published-tracks-'));
  const file = path.join(tmp, 'db.json');
  const store = createJsonStore(file);
  await store.insert('users', {
    username: 'admin', name: 'Admin', role: 'admin',
    password_hash: hashPassword('track-admin-pass'), active: true,
  });
  await store.insert('users', {
    username: 'assessor', name: 'Assessor', role: 'assessor',
    password_hash: hashPassword('track-assessor-pass'), active: true,
  });
  let rsa = null;
  if (withRsa) {
    rsa = await store.insert('roles', { ...RSA_ROLE, active: true });
    const compIds = {};
    for (const c of RSA_COMPETENCIES) {
      const r = await store.insert('competencies', { ...c, role_id: rsa.id, active: true });
      compIds[c.key] = r.id;
    }
    for (const q of RSA_QUESTIONS) {
      await store.insert('questions', {
        role_id: rsa.id, competency_id: compIds[q.competency], type: q.type, prompt: q.prompt,
        help_text: q.help_text || '', options: q.options || [], correct_option_ids: q.correct_option_ids || [],
        points: q.points, difficulty: q.difficulty, rubric: q.rubric || '', order: q.order, active: true,
        question_set: q.question_set || '', pin_first: q.pin_first === true, audio_required: q.type === 'text',
      });
    }
    await store.insert('frameworks', { role_id: rsa.id, name: 'ECOD Readiness Framework v1', config: DEFAULT_FRAMEWORK_CONFIG, active: true });
  }
  return { store, file, rsa };
}

async function client(app, username = 'admin', password = 'track-admin-pass') {
  const res = await app({ method: 'POST', path: '/auth/login', body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const token = res.body.token;
  return (method, reqPath, body, query) =>
    app({ method, path: reqPath, body, query, headers: { authorization: `Bearer ${token}` } });
}

test('every published track is listed with its install state', async () => {
  const { store, rsa } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);

  const res = await call('GET', '/admin/content/tracks');
  assert.equal(res.status, 200);
  const byKey = Object.fromEntries(res.body.tracks.map((t) => [t.role_key, t]));
  assert.deepEqual(Object.keys(byKey).sort(), Object.keys(PUBLISHED_CATALOGUES).sort(), 'one row per published catalogue');

  const rsaRow = byKey[RSA_ROLE.key];
  assert.equal(rsaRow.installed, true);
  assert.equal(rsaRow.active, true);
  assert.equal(rsaRow.role.id, rsa.id);
  assert.equal(rsaRow.bank_total, RSA_QUESTIONS.length);
  assert.equal(rsaRow.missing, 0);

  const aibi = byKey[AIBI_ROLE.key];
  assert.equal(aibi.installed, false);
  assert.equal(aibi.role, null);
  assert.equal(aibi.role_name, AIBI_ROLE.name);
  assert.equal(aibi.competency_total, AIBI_COMPETENCIES.length);
  assert.equal(aibi.catalogue_total, AIBI_QUESTIONS.length);
  assert.equal(aibi.missing, AIBI_QUESTIONS.length, 'the whole catalogue is missing until installed');
  assert.equal(aibi.authoring_only, false);

  const sc = byKey[SC_ROLE.key];
  assert.equal(sc.installed, false);
  assert.equal(sc.competency_total, SC_COMPETENCIES.length);
  assert.equal(sc.catalogue_total, 0);
  assert.equal(sc.authoring_only, true, 'the Senior Consultant bank is authored in-app');

  // The per-track status the Question Bank strip reads says the same thing.
  const status = await call('GET', '/admin/content/catalogue', undefined, { role_key: AIBI_ROLE.key });
  assert.equal(status.status, 200);
  assert.equal(status.body.available, false);
  assert.equal(status.body.installable, true);
  assert.equal(status.body.role_key, AIBI_ROLE.key);
  assert.equal(status.body.role_name, AIBI_ROLE.name);
  assert.equal(status.body.competency_total, AIBI_COMPETENCIES.length);
});

test('installing the AI/BI track creates the role, framework, competencies and the 100 published questions', async () => {
  const { store } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);

  const res = await call('POST', '/admin/content/tracks', { role_key: AIBI_ROLE.key });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.created, true);
  assert.equal(res.body.competencies_added, AIBI_COMPETENCIES.length);
  assert.equal(res.body.added, AIBI_QUESTIONS.length);
  assert.equal(res.body.bank_total, AIBI_QUESTIONS.length);
  assert.equal(res.body.role.key, AIBI_ROLE.key);

  // Visible under Roles & frameworks, configurable, with a scoring framework.
  const roles = await call('GET', '/admin/roles');
  const role = roles.body.roles.find((r) => r.key === AIBI_ROLE.key);
  assert.ok(role, 'the track is listed with the roles');
  assert.equal(role.name, AIBI_ROLE.name);
  assert.equal(role.technology, AIBI_ROLE.technology);
  assert.equal(role.active, true);
  assert.equal(role.competency_count, AIBI_COMPETENCIES.length);
  assert.equal(role.question_count, AIBI_QUESTIONS.length);

  const detail = await call('GET', `/admin/roles/${role.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.competencies.length, AIBI_COMPETENCIES.length);
  assert.equal(detail.body.competencies.reduce((n, c) => n + c.weight, 0), 100);
  const frameworks = await store.list('frameworks', { role_id: role.id });
  assert.equal(frameworks.length, 1, 'exactly one default framework');
  assert.deepEqual(frameworks[0].config, DEFAULT_FRAMEWORK_CONFIG);

  // The bank is the published one: 60 objective + 40 open, every open row a
  // recorded answer, every question attached to one of the track's competencies.
  const bank = await store.list('questions', { role_id: role.id });
  assert.equal(bank.filter((q) => q.type === 'mcq_single').length, 60);
  assert.equal(bank.filter((q) => q.type === 'text').length, 40);
  assert.ok(bank.filter((q) => q.type === 'text').every((q) => q.audio_required === true));
  const compIds = new Set(detail.body.competencies.map((c) => c.id));
  assert.ok(bank.every((q) => compIds.has(q.competency_id)));
  assert.ok(bank.every((q) => q.active === true));

  // Status flips to available/complete, and the audit trail records the install.
  const status = await call('GET', '/admin/content/catalogue', undefined, { role_key: AIBI_ROLE.key });
  assert.equal(status.body.available, true);
  assert.equal(status.body.missing, 0);
  const audit = await store.list('audit_log');
  assert.ok(audit.some((e) => e.action === 'track_installed' && e.entity_id === role.id), JSON.stringify(audit.map((e) => e.action)));

  // The RSA track was not touched.
  const rsaRow = roles.body.roles.find((r) => r.key === RSA_ROLE.key);
  assert.equal(rsaRow.question_count, RSA_QUESTIONS.length);
  assert.equal((await store.list('roles')).length, 2);
});

test('an installed track can be allocated straight away', async () => {
  const { store } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);
  const installed = await call('POST', '/admin/content/tracks', { role_key: AIBI_ROLE.key });
  assert.equal(installed.status, 201);

  const candidate = await store.insert('candidates', { name: 'Genie Candidate', stage: 'assessment' });
  const allocated = await call('POST', '/admin/assessments', {
    candidate_id: candidate.id, role_id: installed.body.role.id, question_count: MAX_ASSESSMENT_QUESTIONS,
  });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  assert.equal(allocated.body.snapshot_json.questions.length, MAX_ASSESSMENT_QUESTIONS);
  assert.equal(allocated.body.snapshot_json.bank_total, AIBI_QUESTIONS.length);
});

test('installing is idempotent: a second call tops up instead of duplicating the role', async () => {
  const { store } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);

  const first = await call('POST', '/admin/content/tracks', { role_key: AIBI_ROLE.key });
  assert.equal(first.status, 201);
  // An admin removes a published question; the second install puts it back
  // (the same top-up the catalogue sync performs) and creates nothing else.
  const victim = (await store.list('questions', { role_id: first.body.role.id }))[0];
  await store.remove('questions', victim.id);

  const second = await call('POST', '/admin/content/tracks', { role_key: AIBI_ROLE.key });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.created, false);
  assert.equal(second.body.added, 1);
  assert.equal(second.body.competencies_added, 0);
  assert.equal(second.body.bank_total, AIBI_QUESTIONS.length);
  assert.equal(second.body.role.id, first.body.role.id);

  const twins = (await store.list('roles')).filter((r) => r.key === AIBI_ROLE.key);
  assert.equal(twins.length, 1, 'still one AI/BI role');
  assert.equal((await store.list('frameworks', { role_id: first.body.role.id })).length, 1, 'still one framework');
  assert.equal((await store.list('competencies', { role_id: first.body.role.id })).length, AIBI_COMPETENCIES.length);
});

test('the Senior Consultant track installs with its competencies and an empty bank ready for authoring', async () => {
  const { store } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);

  const res = await call('POST', '/admin/content/tracks', { role_key: SC_ROLE.key });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.created, true);
  assert.equal(res.body.competencies_added, SC_COMPETENCIES.length);
  assert.equal(res.body.bank_total, 0);
  const roleId = res.body.role.id;

  const detail = await call('GET', `/admin/roles/${roleId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.role.name, SC_ROLE.name);
  assert.equal(detail.body.competencies.length, SC_COMPETENCIES.length);
  assert.equal(detail.body.competencies.reduce((n, c) => n + c.weight, 0), 100);
  assert.equal((await store.list('frameworks', { role_id: roleId })).length, 1);

  // Authoring works immediately: a question lands in the track's bank.
  const comp = detail.body.competencies[0];
  const authored = await call('POST', '/admin/questions', {
    role_id: roleId, competency_id: comp.id, type: 'mcq_single',
    prompt: 'Which engagement artefact should a senior consultant agree first?',
    options: [
      { id: 'a', label: 'A statement of work with outcomes and non-goals' },
      { id: 'b', label: 'A detailed cluster sizing sheet' },
      { id: 'c', label: 'The final report template' },
      { id: 'd', label: 'A list of every available connector' },
    ],
    correct_option_ids: ['a'], points: 4, difficulty: 'intermediate',
  });
  assert.equal(authored.status, 201, JSON.stringify(authored.body));
  const roles = await call('GET', '/admin/roles');
  assert.equal(roles.body.roles.find((r) => r.id === roleId).question_count, 1);

  // A published-question top-up for a track with no published questions is a
  // harmless no-op that leaves the authored question alone.
  const again = await call('POST', '/admin/content/tracks', { role_key: SC_ROLE.key });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.bank_total, 1);
});

test('a deactivated track is never re-created as a second role', async () => {
  const { store } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);
  const first = await call('POST', '/admin/content/tracks', { role_key: SC_ROLE.key });
  assert.equal(first.status, 201);
  await call('PATCH', `/admin/roles/${first.body.role.id}`, { active: false });

  const res = await call('POST', '/admin/content/tracks', { role_key: SC_ROLE.key });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /deactivated/i);
  assert.match(res.body.error, /Reactivate/);
  assert.equal((await store.list('roles')).filter((r) => r.key === SC_ROLE.key).length, 1);

  // Both status views point the admin at the existing, deactivated role.
  const listed = (await call('GET', '/admin/content/tracks')).body.tracks.find((t) => t.role_key === SC_ROLE.key);
  assert.equal(listed.installed, true);
  assert.equal(listed.active, false);
  assert.equal(listed.role.id, first.body.role.id);
  const status = await call('GET', '/admin/content/catalogue', undefined, { role_key: SC_ROLE.key });
  assert.equal(status.body.available, false);
  assert.equal(status.body.installable, false);
  assert.equal(status.body.inactive_role.id, first.body.role.id);
});

test('install rejects unknown keys and non-admins, and the plain sync still does not create roles', async () => {
  const { store } = await legacyStore();
  const app = await createApp(store);
  const call = await client(app);

  assert.equal((await call('POST', '/admin/content/tracks', {})).status, 400);
  assert.equal((await call('POST', '/admin/content/tracks', { role_key: 'snowflake-rsa' })).status, 400);
  assert.match((await call('POST', '/admin/content/tracks', { role_key: 'snowflake-rsa' })).body.error, /No published track/);

  const asAssessor = await client(app, 'assessor', 'track-assessor-pass');
  assert.equal((await asAssessor('GET', '/admin/content/tracks')).status, 403);
  assert.equal((await asAssessor('POST', '/admin/content/tracks', { role_key: AIBI_ROLE.key })).status, 403);
  assert.equal((await app({ method: 'POST', path: '/admin/content/tracks', body: { role_key: AIBI_ROLE.key } })).status, 401);

  // `sync` keeps its contract — top up an existing track, never create one.
  const synced = await call('POST', '/admin/content/sync', { role_key: AIBI_ROLE.key });
  assert.equal(synced.status, 400);
  assert.match(synced.body.error, /No active track matches/);
  assert.equal((await store.list('roles')).length, 1);
});

test('the service installs into an empty workspace too', async () => {
  const { store } = await legacyStore({ withRsa: false });
  const before = await listCatalogues(store);
  assert.ok(before.every((t) => t.installed === false));

  for (const key of Object.keys(PUBLISHED_CATALOGUES)) {
    const result = await installCatalogue(store, key);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.created, true);
  }
  const after = await listCatalogues(store);
  assert.ok(after.every((t) => t.installed && t.active && t.missing === 0), JSON.stringify(after));
  assert.equal(after.find((t) => t.role_key === RSA_ROLE.key).bank_total, RSA_QUESTIONS.length);
  assert.equal(after.find((t) => t.role_key === AIBI_ROLE.key).bank_total, AIBI_QUESTIONS.length);
  assert.equal(after.find((t) => t.role_key === SC_ROLE.key).bank_total, 0);
  assert.equal(await installCatalogue(store, 'nope').then((r) => r.error && true), true);
});

test('`npm run seed` on an existing workspace adds the published tracks it is missing', async () => {
  const { store, file, rsa } = await legacyStore();
  // A deactivated Senior Consultant track: the seed must leave it alone.
  const sc = await store.insert('roles', { ...SC_ROLE, active: false });

  const run = () => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.mjs')], {
    cwd: ROOT, env: { ...process.env, STORAGE: 'json', DATA_FILE: file }, encoding: 'utf8',
  });
  const out = run();
  assert.match(out, /existing databricks-rsa bank synchronized/);
  assert.match(out, /published track "Senior Databricks AI\/BI & Genie Consultant" added: 10 competencies, 100 questions/);
  assert.match(out, /senior-consultant: deactivated in this workspace, left as is/);

  // Re-read from disk: the seed process wrote the file.
  const reread = createJsonStore(file);
  const roles = await reread.list('roles');
  assert.deepEqual(roles.map((r) => r.key).sort(), [AIBI_ROLE.key, RSA_ROLE.key, SC_ROLE.key]);
  const aibi = roles.find((r) => r.key === AIBI_ROLE.key);
  assert.equal(aibi.active, true);
  assert.equal((await reread.list('questions', { role_id: aibi.id })).length, AIBI_QUESTIONS.length);
  assert.equal((await reread.list('competencies', { role_id: aibi.id })).length, AIBI_COMPETENCIES.length);
  assert.equal((await reread.list('frameworks', { role_id: aibi.id })).length, 1);
  assert.equal((await reread.get('roles', sc.id)).active, false, 'the deactivated track is untouched');
  assert.equal((await reread.list('questions', { role_id: rsa.id })).length, RSA_QUESTIONS.length);
  // Users and the rest of the workspace were not re-seeded.
  assert.equal((await reread.list('users')).length, 2);
  assert.equal((await reread.list('candidates')).length, 0);

  // Second run: nothing new, nothing duplicated.
  const again = run();
  assert.match(again, /existing databricks-ai-bi-genie bank synchronized: added 0 question\(s\)/);
  const rereadAgain = createJsonStore(file);
  assert.equal((await rereadAgain.list('roles')).length, 3);
  assert.equal((await rereadAgain.list('questions', { role_id: aibi.id })).length, AIBI_QUESTIONS.length);
});

test('an install that dies part-way leaves no orphan role, and the retry installs cleanly', async () => {
  const { store } = await legacyStore({ withRsa: false });
  // A store whose first competencies batch write fails (a blob-store timeout
  // mid-install). The role row had already been written by then.
  let failOnce = true;
  const flaky = new Proxy(store, {
    get(target, key) {
      if (key === 'insertMany') {
        return async (table, rows) => {
          if (table === 'competencies' && failOnce) { failOnce = false; throw new Error('blob store timeout'); }
          return target.insertMany(table, rows);
        };
      }
      return target[key];
    },
  });
  await assert.rejects(() => installCatalogue(flaky, AIBI_ROLE.key), /blob store timeout/);
  assert.equal((await store.list('roles', { key: AIBI_ROLE.key })).length, 0,
    'the half-installed role must be rolled back, not left looking installed');
  assert.equal((await store.list('competencies')).length, 0);
  assert.equal((await store.list('frameworks')).length, 0);

  const retry = await installCatalogue(flaky, AIBI_ROLE.key);
  assert.equal(retry.error, undefined, JSON.stringify(retry));
  assert.equal(retry.created, true, 'the retry is a fresh install, not a top-up of an orphan');
  const roles = await store.list('roles', { key: AIBI_ROLE.key });
  assert.equal(roles.length, 1);
  assert.equal((await store.list('frameworks', { role_id: roles[0].id })).length, 1);
  assert.equal((await store.list('competencies', { role_id: roles[0].id })).length, AIBI_COMPETENCIES.length);
  assert.equal((await store.list('questions', { role_id: roles[0].id })).length, AIBI_QUESTIONS.length);
});

test('a legacy orphan role (installed before the rollback existed) gets its framework on the next install/sync', async () => {
  const { store } = await legacyStore({ withRsa: false });
  const orphan = await store.insert('roles', { ...AIBI_ROLE, active: true });
  const healed = await installCatalogue(store, AIBI_ROLE.key);
  assert.equal(healed.error, undefined, JSON.stringify(healed));
  assert.equal(healed.created, false);
  assert.equal(healed.role.id, orphan.id, 'the existing role is topped up, never duplicated');
  assert.equal((await store.list('frameworks', { role_id: orphan.id })).length, 1,
    'the missing default framework is added so the track can be allocated');
  assert.equal((await store.list('questions', { role_id: orphan.id })).length, AIBI_QUESTIONS.length);
});
