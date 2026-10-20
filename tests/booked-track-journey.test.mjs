import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers/world.mjs';
import { EXAM_SESSION_MS } from '../src/api/exam-expiry.mjs';

const PASSWORD = 'Booked-journey-password-2026';
for (const [roleKey, count, openCount] of [
  ['technology-risk-sama', 30, 5],
  ['databricks-rsa', 50, 20],
  ['databricks-ai-bi-genie', 50, 20],
]) {
  test(`${roleKey}: public booking through scheduled exam, recordings, scoring and released report`, async (t) => {
    const w = await makeWorld({ t });
    const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
    const track = ok(await w.call('POST', '/admin/content/tracks', { token: w.tok, body: { role_key: roleKey } }));
    const link = ok(await w.call('POST', '/admin/test-bookings/links', { token: w.tok, body: {} }));
    const rawToken = link.path.split('/').at(-1);
    const lookup = ok(await w.call('POST', '/public/test-bookings/lookup', { body: { token: rawToken } }));
    assert.equal(lookup.exams.find((r) => r.id === track.role.id).question_count, count);
    const email = `journey-${roleKey}@example.com`;
    const receipt = ok(await w.call('POST', '/public/test-bookings', { body: {
      token: rawToken, request_id: 'booked-track-journey-1234', name: 'Booked Track Journey', email,
      phone: '+91 9876543210', role_id: track.role.id,
      date: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), time: '14:30',
      password: PASSWORD, confirm_password: PASSWORD,
    } }));
    const booking = await w.store.get('test_bookings', link.invitation.id);
    const id = booking.assessment_id, base = `/candidate/assessments/${id}`;
    assert.equal(receipt.exam_path, `#/assessments/${id}/quiz`);
    const dashboard = ok(await w.call('GET', '/admin/dashboard', { token: w.tok }));
    assert.equal(dashboard.counts.upcoming_tests, 1);
    assert.equal(dashboard.upcoming_tests[0].candidate_id, booking.candidate_id);
    let token = await w.login(email, PASSWORD);
    assert.equal((await w.call('GET', base, { token })).status, 409);
    assert.equal((await w.store.get('assessments', id)).started_at, undefined);
    assert.equal((await w.call('GET', base, { token: w.tok })).status, 403);
    const stranger = await w.candidateUser('journey.stranger', { allocate: false });
    assert.equal((await w.call('GET', base, { token: stranger.token })).status, 404);
    const assessor = await w.assessorUser('booked.journey.assessor');
    await w.assign(id, assessor.user.id);

    // Advance the test clock to the booked opening; no real two-hour wait.
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(receipt.scheduled_at) });
    // The original login session has aged with the clock, just as in real use.
    token = await w.login(email, PASSWORD);
    assessor.token = await w.login('booked.journey.assessor');
    assert.equal((await w.call('GET', '/candidate/assessments', { token })).body.assessments[0].access_state, 'available');
    assert.equal((await w.call('GET', `/candidate/reports/${id}`, { token })).status, 409);
    const frozenPaper = (await w.store.get('assessments', id)).snapshot_json;
    assert.equal(frozenPaper.questions.length, count);
    const seen = new Set(), clips = new Map();
    let firstStartedAt;
    for (let index = 0; index < count; index++) {
      const detail = ok(await w.call('GET', base, { token }));
      const q = detail.current_question;
      assert.ok(q); assert.equal(seen.has(q.id), false); seen.add(q.id);
      assert.equal(detail.exam.index, index);
      assert.equal(detail.assessment.expires_at, receipt.scheduled_end_at);
      assert.equal(detail.exam.session_remaining_ms, EXAM_SESSION_MS);
      firstStartedAt ||= detail.assessment.started_at;
      assert.equal(detail.assessment.started_at, firstStartedAt);
      assert.ok(!JSON.stringify(detail).includes('correct_option_ids'));
      let answer = q.options?.[0]?.id;
      if (q.type === 'text') {
        assert.deepEqual(detail.exam.budgets, { review_ms: 30_000, answer_ms: 60_000 });
        assert.equal(detail.exam.phase, 'review');
        const phase = ok(await w.call('POST', `${base}/phase`, { token, body: { phase: 'answer', question_id: q.id } }));
        assert.equal(phase.remaining_ms, 60_000);
        assert.equal((await w.call('POST', `${base}/phase`, { token, body: { phase: 'answer', question_id: q.id } })).status, 409);
        const audio_b64 = Buffer.from(`booked-${roleKey}-${q.id}`).toString('base64');
        clips.set(q.id, audio_b64);
        answer = { text: '', transcript: '', source: 'audio', audio_b64, audio_mime: 'audio/webm' };
        ok(await w.call('PUT', `${base}/answers`, { token, body: { answers: { [q.id]: answer } } }));
        assert.ok(ok(await w.call('GET', base, { token })).current_answer.audio_ref);
        answer = { text: '', transcript: '', source: 'audio', audio_keep: true };
      } else {
        assert.deepEqual(detail.exam.budgets, { review_ms: 0, answer_ms: 30_000 });
      }
      const advanced = ok(await w.call('POST', `${base}/next`, { token, body: { question_id: q.id, answer } }));
      assert.equal(advanced.index, index + 1);
      if (index < count - 1) {
        const duplicate = ok(await w.call('POST', `${base}/next`, { token, body: { question_id: q.id, answer } }));
        assert.equal(duplicate.duplicate, true); assert.equal(duplicate.index, index + 1);
      }
      if (index === Math.floor(count / 2)) {
        ok(await w.call('POST', '/auth/logout', { token }));
        assert.equal((await w.call('GET', base, { token })).status, 401);
        token = await w.login(receipt.username, PASSWORD);
        assert.equal(ok(await w.call('GET', base, { token })).exam.index, index + 1);
      }
    }
    assert.equal(clips.size, openCount);
    ok(await w.call('POST', `${base}/submit`, { token, body: { answers: {} } }));
    assert.equal((await w.call('POST', `${base}/submit`, { token, body: { answers: {} } })).status, 409);
    assert.equal((await w.store.list('responses', { assessment_id: id })).length, count);
    const review = ok(await w.call('GET', `/assessor/assessments/${id}`, { token: assessor.token }));
    for (const [qid, bytes] of clips) {
      assert.equal(review.responses.find((r) => r.question_id === qid).answer.has_recording, true);
      const clip = ok(await w.call('GET', `/assessor/assessments/${id}/recordings/${qid}`, { token: assessor.token }));
      assert.equal(clip.audio_b64, bytes);
    }
    await w.scoreAndFinalize(assessor.token, id);
    // Released reports remain accessible after the exam's entry link closes.
    t.mock.timers.tick(EXAM_SESSION_MS + 1);
    token = await w.login(email, PASSWORD);
    const released = ok(await w.call('GET', `/candidate/reports/${id}`, { token }));
    assert.equal(released.candidate.id, booking.candidate_id);
    assert.equal(typeof released.report.overall_pct, 'number');
    assert.ok(released.report.competencies.length > 0);
    assert.equal((await w.call('GET', `/candidate/reports/${id}`, { token: stranger.token })).status, 401, 'the stranger session also aged out');
    assert.deepEqual((await w.store.get('assessments', id)).snapshot_json, frozenPaper);
    assert.equal((await w.store.list('users', { booking_id: booking.id })).length, 1);
    assert.equal((await w.store.list('assessments', { booking_id: booking.id })).length, 1);
    const freshAdmin = await w.login('admin', 'Admin-pass-123');
    assert.equal(ok(await w.call('GET', '/admin/dashboard', { token: freshAdmin })).counts.upcoming_tests, 0);
  });
}
