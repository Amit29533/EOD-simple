/**
 * Admin point of view, through the real app (in-process, JSON store).
 *
 * Onboarding (single and bulk), allocation, assignment, the listings an admin
 * works from, and the audit trail those actions leave. Each world is fresh
 * (tests/helpers/world.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';

const FACTS = ['question_count', 'total_points', 'question_limit', 'bank_total', 'role_name'];
const factsOf = (row) => Object.fromEntries(FACTS.map((k) => [k, row[k]]));

/* ------------------------------------------------------------ bulk onboarding */

test('bulk-imported papers carry the same listing facts as a single allocation, so listings never fetch papers', async (t) => {
  const w = await makeWorld({ t });
  const single = await w.candidateUser('single.cand');

  const csv = [
    'Name,Email,Target role',
    'Imported One,imp1@example.com,POV Track',
    'Imported Two,imp2@example.com,POV Track',
    'Imported Three,imp3@example.com,POV Track',
  ].join('\n');
  const imp = await w.call('POST', '/admin/candidates/import', {
    token: w.tok, body: { csv, filename: 'cohort.csv', create_users: true, dry_run: false },
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.auto_allocated, 3);
  const ids = imp.body.auto_allocations.filter((x) => x.allocated).map((x) => x.assessment_id);
  assert.equal(ids.length, 3);

  // The stored rows, as a listing reads them (paper not attached).
  const rows = await w.store.list('assessments', {}, { detached: false });
  const reference = factsOf(rows.find((r) => r.id === single.assessmentId));
  assert.equal(reference.role_name, 'POV Track');
  assert.equal(reference.total_points, 3 * 4 + 2 * 5);
  for (const id of ids) {
    assert.deepEqual(factsOf(rows.find((r) => r.id === id)), reference, `imported paper ${id} carries the facts`);
  }

  // The listing is served from the rows alone: no paper fetch, no row rewrite.
  let paperReads = 0; let rowWrites = 0;
  const get = w.store.get.bind(w.store);
  const update = w.store.update.bind(w.store);
  w.store.get = async (table, ...rest) => { if (table === 'assessments') paperReads += 1; return get(table, ...rest); };
  w.store.update = async (table, ...rest) => { if (table === 'assessments') rowWrites += 1; return update(table, ...rest); };
  const listing = await w.call('GET', '/admin/assessments', { token: w.tok });
  assert.equal(listing.status, 200);
  assert.equal(paperReads, 0, 'no imported paper is fetched whole to print its row');
  assert.equal(rowWrites, 0, 'no row is rewritten by a read-only listing');
  const listed = listing.body.assessments.filter((a) => ids.includes(a.id));
  assert.equal(listed.length, 3);
  for (const a of listed) {
    assert.equal(a.question_count, 5);
    assert.equal(a.bank_total, 5);
    assert.equal(a.role_name, 'POV Track');
  }
});

/* ------------------------------------------------------------ candidate record */

test('a candidate record\'s timeline carries their papers\' milestones, not their integrity beacons', async (t) => {
  const w = await makeWorld({ t });
  const { cand, token, assessmentId } = await w.candidateUser('journey.cand', { name: 'Journey Person' });
  const { user: assessor, token: aTok } = await w.assessorUser('journey.assessor');
  await w.call('GET', `/candidate/assessments/${assessmentId}`, { token });
  for (let i = 0; i < 40; i += 1) {
    await w.call('POST', `/candidate/assessments/${assessmentId}/integrity`, { token, body: { event: 'window_blur' } });
  }
  await w.walkAndSubmit(token, assessmentId);
  await w.assign(assessmentId, assessor.id);
  await w.scoreAndFinalize(aTok, assessmentId);

  const d = w.expectOk(await w.call('GET', `/admin/candidates/${cand.id}`, { token: w.tok }), 'candidate record');
  const actions = d.timeline.map((e) => e.action);
  for (const milestone of ['candidate_created', 'assessment_allocated', 'assessment_submitted', 'assessment_reassigned', 'assessment_scored']) {
    assert.ok(actions.includes(milestone), `${milestone} is on the timeline: ${actions}`);
  }
  assert.ok(!actions.some((a) => a.startsWith('integrity_')), 'no integrity beacons on the timeline');
  assert.ok(d.timeline.length <= 30, 'still capped');
  const times = d.timeline.map((e) => e.created_at);
  assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
  // Another candidate's paper never leaks into this timeline.
  const other = await w.candidateUser('other.cand', { name: 'Other Person' });
  const again = w.expectOk(await w.call('GET', `/admin/candidates/${cand.id}`, { token: w.tok }), 'candidate record');
  assert.ok(!again.timeline.some((e) => e.entity_id === other.assessmentId));
});

test('a candidate created by a spreadsheet import has a timeline, not "No events yet"', async (t) => {
  const w = await makeWorld({ t });
  const csv = 'Name,Email,Target role\nSheet Person,sheet@example.com,POV Track\n';
  const imp = w.expectOk(await w.call('POST', '/admin/candidates/import', {
    token: w.tok, body: { csv, filename: 's.csv', create_users: true },
  }), 'import');
  const [row] = imp.auto_allocations;
  const cands = w.expectOk(await w.call('GET', '/admin/candidates', { token: w.tok }), 'list').candidates;
  const cand = cands.find((c) => c.name === 'Sheet Person');
  const d = w.expectOk(await w.call('GET', `/admin/candidates/${cand.id}`, { token: w.tok }), 'record');
  assert.ok(d.timeline.length >= 1, 'the imported candidate has a history');
  const alloc = d.timeline.find((e) => e.action === 'assessment_allocated');
  assert.ok(alloc, 'the auto-allocation is on the timeline');
  assert.equal(alloc.entity_id, row.assessment_id);
  assert.match(alloc.message, /Sheet Person/);
});

test('the audit trail can be narrowed server-side by action, entity and entity_id', async (t) => {
  const w = await makeWorld({ t });
  const csv = 'Name,Email,Target role\nAudit Person,audit@example.com,POV Track\n';
  const imp = w.expectOk(await w.call('POST', '/admin/candidates/import', {
    token: w.tok, body: { csv, filename: 'a.csv', create_users: true },
  }), 'import');
  const [row] = imp.auto_allocations;

  const all = w.expectOk(await w.call('GET', '/admin/audit', { token: w.tok }), 'all');
  assert.ok(new Set(all.events.map((e) => e.action)).size > 1, 'unfiltered trail mixes actions');

  const byAction = w.expectOk(await w.call('GET', '/admin/audit', { token: w.tok, query: { action: 'assessment_allocated' } }), 'action');
  assert.ok(byAction.events.length >= 1);
  assert.ok(byAction.events.every((e) => e.action === 'assessment_allocated'));
  assert.equal(byAction.total, byAction.events.length, 'total reflects the filtered set');

  const byEntity = w.expectOk(await w.call('GET', '/admin/audit', { token: w.tok, query: { entity: 'assessments', entity_id: row.assessment_id } }), 'entity');
  assert.ok(byEntity.events.length >= 1);
  assert.ok(byEntity.events.every((e) => e.entity === 'assessments' && e.entity_id === row.assessment_id));

  const none = w.expectOk(await w.call('GET', '/admin/audit', { token: w.tok, query: { action: 'no_such_action' } }), 'none');
  assert.deepEqual(none.events, []);
  assert.equal(none.total, 0);
});
