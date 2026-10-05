import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, USER_PASSWORD } from './helpers/world.mjs';

for (const [roleKey, count, openCount] of [
  ['technology-risk-sama', 30, 5],
  ['databricks-rsa', 50, 20],
  ['databricks-ai-bi-genie', 50, 20],
]) {
test(`${roleKey} retains every recording through draft, reload, lock, submission and assessor retrieval`, async (t) => {
  const w = await makeWorld({ t });
  const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
  const installed = ok(await w.call('POST', '/admin/content/tracks', {
    token: w.tok, body: { role_key: roleKey },
  }));
  const person = ok(await w.call('POST', '/admin/candidates', {
    token: w.tok, body: { name: 'SAMA Recording Candidate', target_role_id: installed.role.id },
  }));
  const user = ok(await w.call('POST', '/admin/users', {
    token: w.tok, body: { username: 'sama.recording', name: person.name, role: 'candidate',
      candidate_id: person.id, password: USER_PASSWORD, auto_allocate: true },
  }));
  const id = user.auto_allocation.assessment_id;
  const token = await w.login('sama.recording');
  const assessor = await w.assessorUser('sama.assessor');
  await w.assign(id, assessor.user.id);
  const paper = (await w.store.get('assessments', id)).snapshot_json;
  assert.equal(paper.questions.length, count);
  assert.equal(paper.questions.filter((q) => q.type === 'text').length, openCount);
  const clips = new Map();
  const base = `/candidate/assessments/${id}`;
  for (let i = 0; i < count; i++) {
    const detail = ok(await w.call('GET', base, { token }));
    const q = detail.current_question;
    assert.ok(q, `question ${i + 1} exists`);
    if (detail.exam.phase === 'review') {
      ok(await w.call('POST', `${base}/phase`, { token, body: { phase: 'answer' } }));
    }
    let answer = q.options?.[0]?.id;
    if (q.type === 'text') {
      assert.equal(q.audio_required, true);
      const audio_b64 = Buffer.from(`recorded-answer-${q.id}`).toString('base64');
      clips.set(q.id, audio_b64);
      // No transcript: recording must work even without speech recognition.
      answer = { text: '', transcript: '', source: 'audio', audio_b64, audio_mime: 'audio/webm' };
      ok(await w.call('PUT', `${base}/answers`, { token, body: { answers: { [q.id]: answer } } }));
      const restored = ok(await w.call('GET', base, { token }));
      assert.ok(restored.current_answer.audio_ref, 'reload restores the saved recording reference');
      answer = { text: '', transcript: '', source: 'audio', audio_keep: true };
    }
    ok(await w.call('POST', `${base}/next`, { token, body: { question_id: q.id, answer } }));
  }
  assert.equal(clips.size, openCount);
  ok(await w.call('POST', `${base}/submit`, { token, body: { answers: {} } }));
  const detail = ok(await w.call('GET', `/assessor/assessments/${id}`, { token: assessor.token }));
  for (const [qid, bytes] of clips) {
    const response = detail.responses.find((r) => r.question_id === qid);
    assert.equal(response.answer.has_recording, true);
    assert.ok(!response.answer.audio_missing);
    const clip = ok(await w.call('GET', `/assessor/assessments/${id}/recordings/${qid}`, { token: assessor.token }));
    assert.equal(clip.audio_b64, bytes, 'assessor receives exactly the saved recording');
  }
  await w.scoreAndFinalize(assessor.token, id);
});
}
