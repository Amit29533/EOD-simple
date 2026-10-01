import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { sortedQuestions } from '../src/api/quiz-session.mjs';

test('a draft losing to a concurrent lock cannot replace the committed recording', async (t) => {
  const w = await makeWorld({ t });
  const c = await w.candidateUser('immutable.audio.candidate');
  const assessor = await w.assessorUser('immutable.audio.assessor');
  await w.assign(c.assessmentId, assessor.user.id);
  const path = `/candidate/assessments/${c.assessmentId}`;
  await w.call('GET', path, { token: c.token });
  const assessment = await w.store.get('assessments', c.assessmentId);
  const qs = sortedQuestions(assessment.snapshot_json);
  const index = qs.findIndex((q) => q.type === 'text');
  const q = qs[index];
  await w.store.update('assessments', c.assessmentId, { quiz_state: { ...assessment.quiz_state, index, phase: 'answer', question_started_at: new Date().toISOString() } });
  const draft = (audio) => w.call('PUT', `${path}/answers`, { token: c.token, body: { answers: {
    [q.id]: { text: '', transcript: 'spoken answer', source: 'audio', audio_b64: audio, audio_mime: 'audio/webm' },
  } } });
  const originalAudio = Buffer.from('original audio').toString('base64');
  assert.equal((await draft(originalAudio)).status, 200);
  const response = (await w.store.list('responses', { assessment_id: c.assessmentId, question_id: q.id }))[0];
  const originalRef = response.answer.audio_ref;
  const insert = w.store.insert.bind(w.store);
  w.store.insert = async (table, value) => {
    const out = await insert(table, value);
    if (table === 'recordings') await w.store.update('responses', response.id, { locked: true });
    return out;
  };
  const losing = await draft(Buffer.from('losing audio').toString('base64'));
  assert.equal(losing.status, 200);
  assert.deepEqual(losing.body.ignored_question_ids, [q.id]);
  assert.equal((await w.store.get('responses', response.id)).answer.audio_ref, originalRef);
  await w.store.update('assessments', c.assessmentId, { status: 'submitted' });
  const playback = await w.call('GET', `/assessor/assessments/${c.assessmentId}/recordings/${q.id}`, { token: assessor.token });
  assert.equal(playback.body.audio_b64, originalAudio);
});
