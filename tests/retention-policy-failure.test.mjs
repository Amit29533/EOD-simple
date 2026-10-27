import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { runRetentionSweep } from '../src/api/retention-service.mjs';

test('a failed retention-policy read cannot authorize deletion under default settings', async (t) => {
  const w = await makeWorld({ t, mcq: 1, open: 0 });
  await w.store.insert('settings', { key: 'retention', days: 365, auto_delete_answer_sheets: false, auto_delete_recordings: false });
  const paper = await w.store.insert('assessments', { status: 'scored', scored_at: '2026-01-01T00:00:00Z',
    snapshot_json: { questions: [{ id: 'q1', type: 'text' }] }, report_json: { overall_pct: 80 } });
  await w.store.insert('responses', { assessment_id: paper.id, question_id: 'q1', answer: { text: 'Preserve this evidence' } });
  const broken = new Proxy(w.store, { get(target, key) { return key === 'list' ? async (table, ...args) => {
    if (table === 'settings') throw new Error('Temporary settings outage'); return target.list(table, ...args);
  } : target[key]; } });
  await assert.rejects(runRetentionSweep(broken), (err) => err.code === 'RETENTION_POLICY_UNAVAILABLE');
  assert.equal((await w.store.list('responses', { assessment_id: paper.id }))[0].answer.text, 'Preserve this evidence');
  assert.equal((await w.store.get('assessments', paper.id)).retention_json, undefined);
});
