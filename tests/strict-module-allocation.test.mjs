import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, USER_PASSWORD } from './helpers/world.mjs';
import { roleBank, automaticSnapshotFromBank } from '../src/api/assessment-service.mjs';
import { REQUIRED_TEST_MODULES } from '../src/core/module-allocation-policy.mjs';
import { effectiveBank, toStoredRecord } from '../src/api/bank-service.mjs';

function check(paper) {
  assert.equal(paper.questions.length, 50);
  assert.equal(new Set(paper.questions.map((q) => q.id)).size, 50);
  assert.equal(paper.questions.filter((q) => q.type === 'mcq_single').length, 30);
  assert.equal(paper.questions.filter((q) => q.type === 'text').length, 20);
  for (const key of REQUIRED_TEST_MODULES) {
    const rows = paper.questions.filter((q) => q.module === key);
    assert.equal(rows.length, key.startsWith('T') ? 4 : 1, key);
    assert.equal(rows.filter((q) => q.type === 'text').length, 1, key);
    assert.equal(rows.filter((q) => q.type === 'mcq_single').length, key.startsWith('T') ? 3 : 0, key);
  }
}
async function setup(t) {
  const w = await makeWorld({ t });
  const roles = [];
  for (const key of ['databricks-rsa', 'databricks-ai-bi-genie']) {
    const installed = await w.call('POST', '/admin/content/tracks', { token: w.tok, body: { role_key: key } });
    assert.equal(installed.status, 201, JSON.stringify(installed.body));
    roles.push(installed.body.role);
  }
  return { w, roles };
}
test('200 allocations per role maintain exact quotas while varying selections', async (t) => {
  const { w, roles } = await setup(t);
  for (const role of roles) {
    const bank = await roleBank(w.store, role.id);
    const variants = new Set();
    for (let i = 0; i < 200; i++) {
      const paper = automaticSnapshotFromBank(bank);
      check(paper);
      variants.add(paper.questions.map((q) => q.id).sort().join(','));
    }
    assert.ok(variants.size > 1, `${role.key} samples more than one question set`);
  }
});
test('manual, account onboarding, CSV and previews enforce the same blueprint; existing attempts remain frozen', async (t) => {
  const { w, roles } = await setup(t);
  for (const [i, role] of roles.entries()) {
    const person = await w.store.insert('candidates', { name: `Manual ${i}`, target_role_id: role.id, stage: 'intake' });
    const manual = await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: person.id, role_id: role.id } });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    check(manual.body.snapshot_json);
    const onboard = await w.store.insert('candidates', { name: `Onboard ${i}`, target_role_id: role.id, stage: 'intake' });
    const user = await w.call('POST', '/admin/users', { token: w.tok, body: { username: `module.onboard.${i}`, name: onboard.name, candidate_id: onboard.id, role: 'candidate', password: USER_PASSWORD } });
    assert.equal(user.status, 201);
    assert.equal(user.body.auto_allocation.allocated, true, JSON.stringify(user.body));
    check((await w.store.get('assessments', user.body.auto_allocation.assessment_id)).snapshot_json);
    const candidateToken = await w.login(`module.onboard.${i}`);
    const firstQuestion = await w.call('GET', `/candidate/assessments/${user.body.auto_allocation.assessment_id}`, { token: candidateToken });
    assert.equal(firstQuestion.status, 200);
    for (const privateField of ['correct_option_ids', 'rubric', 'rationale', 'probes', 'red_flags'])
      assert.ok(!(privateField in firstQuestion.body.current_question), `${privateField} is withheld from the candidate`);
    await w.walkAndSubmit(candidateToken, user.body.auto_allocation.assessment_id);
    const assessor = await w.assessorUser(`module.assessor.${i}`);
    await w.assign(user.body.auto_allocation.assessment_id, assessor.user.id);
    const finalized = await w.scoreAndFinalize(assessor.token, user.body.auto_allocation.assessment_id);
    assert.equal(finalized.report.competencies.reduce((n, c) => n + c.breakdown.length, 0), 50);
    assert.ok(Number.isFinite(finalized.report.overall_pct));
    const csv = `Name,Email,Target role,Username,Password\nCSV ${i},csv${i}@example.com,${role.name},module.csv.${i},${USER_PASSWORD}`;
    const imported = await w.call('POST', '/admin/candidates/import', { token: w.tok, body: { csv, filename: 'module.csv', dry_run: false, create_users: true, auto_allocate: true } });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const csvCandidate = (await w.store.list('candidates', { email: `csv${i}@example.com` }))[0];
    assert.ok(csvCandidate);
    check((await w.store.list('assessments', { candidate_id: csvCandidate.id }))[0].snapshot_json);
    const preview = await w.call('GET', `/admin/roles/${role.id}/question-plan`, { token: w.tok, query: { limit: '10' } });
    assert.equal(preview.body.total, 50);
    assert.equal(preview.body.required_question_count, 50);
    assert.equal(preview.body.per_module.length, 20);
    const candidate = await w.store.insert('candidates', { name: `Bad size ${i}`, target_role_id: role.id });
    assert.equal((await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: candidate.id, role_id: role.id, question_count: 30 } })).status, 400);
    assert.equal((await w.call('PATCH', `/admin/roles/${role.id}`, { token: w.tok, body: { default_question_count: 30 } })).status, 400);
    const oldPaper = manual.body.snapshot_json;
    for (const q of (await effectiveBank(w.store, role.key)).filter((q) => q.module === 'T01'))
      await w.store.insert('bank_question_overrides', { role_key: role.key, question_id: q.id, active: false });
    const before = (await w.store.list('assessments')).length;
    assert.equal((await w.call('POST', '/admin/assessments', { token: w.tok, body: { candidate_id: candidate.id, role_id: role.id } })).status, 400);
    assert.equal((await w.store.list('assessments')).length, before, 'insufficient module cannot create a malformed paper');
    assert.deepEqual((await w.store.get('assessments', manual.body.id)).snapshot_json, oldPaper);
  }
});
test('legacy AI/BI authored IDs and new F01 custom families are mapped without rewriting records', async (t) => {
  const { w } = await setup(t);
  await w.store.insert('bank_questions', { id: 'AIBI-G01-A900', role_key: 'databricks-ai-bi-genie', module: 'G01', family_id: 'G01:custom', family: 'Custom', type: 'open', prompt: 'Legacy authored scenario', rubric: 'Evidence', active: true });
  await w.store.insert('bank_questions', toStoredRecord({ module: 'F01', family_id: 'F01:custom', family: 'New family', type: 'open', prompt: 'New authored scenario', rubric: 'Evidence' }, { id: 'AIBI-F01-A900', roleKey: 'databricks-ai-bi-genie' }));
  const bank = await effectiveBank(w.store, 'databricks-ai-bi-genie');
  assert.equal(bank.find((q) => q.id === 'AIBI-G01-A900').module, 'T01');
  assert.equal(bank.find((q) => q.id === 'AIBI-F01-A900').module, 'F01');
  assert.equal((await w.store.get('bank_questions', 'AIBI-G01-A900')).module, 'G01');
});
