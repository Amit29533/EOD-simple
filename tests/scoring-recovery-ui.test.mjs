import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP } from './helpers/jsdom.mjs';
import { bootSpa, flush } from './helpers/spa.mjs';
import { makeWorld } from './helpers/world.mjs';

test('assessor sees failed save, cannot finalize, and can retry without retyping', { skip: SKIP }, async (t) => {
  const w = await makeWorld({ t });
  const assessor = await w.assessorUser('recovery.assessor');
  const candidate = await w.candidateUser('recovery.candidate');
  await w.walkAndSubmit(candidate.token, candidate.assessmentId);
  await w.assign(candidate.assessmentId, assessor.user.id);
  let fail = true;
  const app = (req) => req.method === 'PUT' && req.path.endsWith('/scores') && fail
    ? { status: 503, body: { error: 'offline' } } : w.app(req);
  const spa = await bootSpa({ backend: { app, token: assessor.token } });
  try {
    const { assessmentView } = await import('../public/js/views/assessor.js');
    await assessmentView(spa.view, { id: candidate.assessmentId });
    const input = spa.view.querySelector('input[id^="score-"]');
    input.value = '3';
    input.onchange();
    await flush(30);
    assert.match(spa.view.querySelector('#score-save-status').textContent, /not saved/);
    assert.equal(spa.view.querySelector('#finalize-btn').disabled, true);
    fail = false;
    await spa.view.querySelector('#retry-scores').onclick();
    assert.match(spa.view.querySelector('#score-save-status').textContent, /All changes saved/);
    const rows = await w.store.list('responses', { assessment_id: candidate.assessmentId });
    assert.equal(rows.find((r) => `score-${r.question_id}` === input.id).assessor_score, 3);
  } finally { spa.teardown(); }
});

test('API deadline remains active while reading the response body', { skip: SKIP }, async () => {
  const spa = await bootSpa();
  try {
    globalThis.fetch = async (_url, { signal }) => ({ ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const { api } = await import('../public/js/api.js');
    await assert.rejects(api('/slow-body', { timeoutMs: 15 }), /did not respond/);
  } finally { spa.teardown(); }
});
