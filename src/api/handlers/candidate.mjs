import { ok, bad, notFound, conflict, unprocessable, audit } from '../helpers.mjs';
import { questionForCandidate, competencyForCandidate, reportForCandidate } from '../projections.mjs';
import { autoScore, isAutoQuestion } from '../../core/scoring.mjs';
import { MAX_AUDIO_B64 } from '../../core/constants.mjs';
import {
  sortedQuestions, isOpenQuestion, budgetsFor, ensureQuizState, remainingMs, integrityPatch,
} from '../quiz-session.mjs';
import {
  requiresSpokenAnswer, hasSpokenEvidence, openAnswerHasContent,
} from '../../core/spoken-answer.mjs';

const R = ['candidate'];

async function myCandidate(store, user) {
  return user.candidate_id ? store.get('candidates', user.candidate_id) : null;
}
/** Owned-or-404: never reveal that an assessment belongs to someone else. */
async function ownAssessment(store, user, id) {
  const a = await store.get('assessments', id);
  return a && a.candidate_id === user.candidate_id ? a : null;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return String(value.text || value.transcript || '');
  return '';
}

function isBlank(q, value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && !value.length) return true;
  // An open answer counts when it carries typed notes, a transcript *or* a
  // recording: a candidate who answered out loud without typing must not have
  // that answer treated as blank and dropped.
  if (q.type === 'text') return !openAnswerHasContent(value);
  return false;
}

function persistableAnswer(q, value) {
  if (q.type === 'text' && value && typeof value === 'object') {
    const out = {
      text: String(value.text || ''),
      transcript: String(value.transcript || ''),
      source: value.source === 'audio' ? 'audio' : 'typed',
    };
    const b64 = String(value.audio_b64 || '').replace(/\s/g, '');
    if (b64 && b64.length <= MAX_AUDIO_B64 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
      out.audio_b64 = b64;
      out.audio_mime = String(value.audio_mime || 'audio/webm').slice(0, 80);
    }
    // Contract bookkeeping: an open answer is supposed to be spoken. The exam UI
    // refuses to advance without a recording, but a submission that still
    // arrives with typed notes only (mic denied, no MediaRecorder, a clip too
    // large to store) is kept rather than discarded — silently throwing away a
    // candidate's work inside a timed exam is worse than the gap — and flagged
    // so the assessor and the integrity trail can see it.
    if (requiresSpokenAnswer(q) && !hasSpokenEvidence(out)) out.audio_missing = true;
    return out;
  }
  return value;
}

function validateAnswerShape(q, value) {
  switch (q.type) {
    case 'mcq_single': {
      const ids = new Set((q.options || []).map((o) => o.id));
      return typeof value === 'string' && ids.has(value);
    }
    case 'mcq_multi': {
      const ids = new Set((q.options || []).map((o) => o.id));
      return Array.isArray(value) && value.every((v) => ids.has(v));
    }
    case 'scale': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 5;
    }
    case 'text':
      if (typeof value === 'string') return true;
      if (value && typeof value === 'object') {
        if (value.audio_b64 != null && String(value.audio_b64).replace(/\s/g, '').length > MAX_AUDIO_B64)
          return false;
        return typeof (value.text || '') === 'string' && typeof (value.transcript || '') === 'string';
      }
      return false;
    default:
      return false;
  }
}

export function candidateHandlers(route) {
  route('GET', '/candidate/assessments', R, async ({ store, auth }) => {
    const candidate = await myCandidate(store, auth.user);
    if (!candidate) return conflict('No candidate record is linked to your login. Contact your administrator.');
    const rows = await store.list('assessments', { candidate_id: candidate.id });
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ok({
      candidate: { id: candidate.id, name: candidate.name, stage: candidate.stage },
      assessments: rows.map((a) => ({
        id: a.id, status: a.status, created_at: a.created_at, started_at: a.started_at,
        submitted_at: a.submitted_at, scored_at: a.scored_at,
        overall_pct: ['scored', 'validated'].includes(a.status) ? a.overall_pct : null,
        readiness_label: ['scored', 'validated'].includes(a.status) ? a.readiness_label : null,
        readiness_key: ['scored', 'validated'].includes(a.status) ? a.readiness_key : null,
        role_name: a.snapshot_json?.role?.name || 'Assessment',
        question_count: (a.snapshot_json?.questions || []).length,
        total_points: (a.snapshot_json?.questions || []).reduce((s2, q) => s2 + Number(q.points ?? 1), 0),
      })),
    });
  });

  route('GET', '/candidate/assessments/:id', R, async ({ store, auth, params }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    const snap = a.snapshot_json;
    const questions = sortedQuestions(snap);
    const patch = {};
    if (a.status === 'assigned') {
      patch.status = 'in_progress';
      patch.started_at = new Date().toISOString();
      a.status = 'in_progress';
      a.started_at = patch.started_at;
    }
    const quiz = ensureQuizState(a, questions);
    if (!a.quiz_state) patch.quiz_state = quiz;
    if (Object.keys(patch).length) await store.update('assessments', a.id, patch);

    const responses = await store.list('responses', { assessment_id: a.id });
    const answers = Object.fromEntries(responses.map((r) => [r.question_id, r.answer]));
    const idx = Math.min(quiz.index, questions.length);
    const current = questions[idx] || null;
    const now = Date.now();
    const remaining = current ? remainingMs(current, quiz, now) : 0;
    const budgets = current ? budgetsFor(current) : null;
    const competency = current
      ? (snap.competencies || []).find((c) => c.id === current.competency_id)
      : null;

    return ok({
      assessment: {
        id: a.id, status: a.status, started_at: a.started_at, submitted_at: a.submitted_at,
        role: snap.role ? { name: snap.role.name, description: snap.role.description } : null,
      },
      exam: {
        index: idx,
        total: questions.length,
        phase: quiz.phase || 'answer',
        remaining_ms: remaining,
        server_now: new Date(now).toISOString(),
        budgets,
        integrity: quiz.integrity || {},
        complete: idx >= questions.length,
      },
      current_question: current ? questionForCandidate(current) : null,
      current_answer: current ? (answers[current.id] ?? null) : null,
      competency: competency ? competencyForCandidate(competency) : null,
      questions: current ? [questionForCandidate(current)] : [],
      competencies: competency ? [competencyForCandidate(competency)] : [],
      answers: current && answers[current.id] !== undefined ? { [current.id]: answers[current.id] } : {},
    });
  });

  route('PUT', '/candidate/assessments/:id/answers', R, async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status))
      return conflict('This assessment has already been submitted.');
    const answers = body.answers;
    if (!answers || typeof answers !== 'object') return bad('answers must be an object keyed by question id.');
    const qById = new Map(a.snapshot_json.questions.map((q) => [q.id, q]));
    const existing = await store.list('responses', { assessment_id: a.id });
    const byQid = new Map(existing.map((r) => [r.question_id, r]));
    for (const [qid, value] of Object.entries(answers)) {
      const q = qById.get(qid);
      if (!q) continue;
      const prior = byQid.get(qid);
      if (prior?.locked) continue;
      if (value === null || value === '' || (Array.isArray(value) && !value.length)) {
        const r = byQid.get(qid);
        if (r) await store.remove('responses', r.id);
        continue;
      }
      if (!validateAnswerShape(q, value)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
      if (q.type === 'text' && !openAnswerHasContent(value)) {
        const r = byQid.get(qid);
        if (r) await store.remove('responses', r.id);
        continue;
      }
      const stored = persistableAnswer(q, value);
      const r = byQid.get(qid);
      if (r) await store.update('responses', r.id, { answer: stored });
      else await store.insert('responses', { assessment_id: a.id, question_id: qid, answer: stored });
    }
    if (a.status === 'assigned')
      await store.update('assessments', a.id, { status: 'in_progress', started_at: new Date().toISOString() });
    return ok({ ok: true, saved_at: new Date().toISOString() });
  });

  route('POST', '/candidate/assessments/:id/integrity', R, async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status)) return conflict('This assessment is no longer in progress.');
    const questions = sortedQuestions(a.snapshot_json);
    const base = ensureQuizState(a, questions);
    const q = questions[base.index];
    const detail = typeof body?.detail === 'string'
      ? body.detail.slice(0, 500)
      : body?.detail && typeof body.detail === 'object'
        ? JSON.stringify(body.detail).slice(0, 500)
        : '';
    const quiz = integrityPatch(base, body?.event, detail, {
      question_index: base.index,
      question_id: q?.id || '',
      question_prompt: q?.prompt || '',
    });
    await store.update('assessments', a.id, { quiz_state: quiz });
    const candidate = await myCandidate(store, auth.user);
    const event = String(body?.event || 'integrity').slice(0, 80);
    await audit(
      store,
      auth.user,
      `integrity_${event.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
      'assessments',
      a.id,
      `"${candidate?.name || 'Candidate'}" · ${event}${detail ? ` — ${detail}` : ''} · Q${base.index + 1}`,
      { event, detail, question_index: base.index, question_id: q?.id || '', question_prompt: q?.prompt || '' },
    );
    return ok({ integrity: quiz.integrity, events: quiz.events });
  });

  route('POST', '/candidate/assessments/:id/phase', R, async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status)) return conflict('This assessment is no longer in progress.');
    const questions = sortedQuestions(a.snapshot_json);
    const quiz = ensureQuizState(a, questions);
    const q = questions[quiz.index];
    if (!q || !isOpenQuestion(q)) return unprocessable('This question has no review phase.');
    if (body?.phase !== 'answer') return bad('phase must be "answer".');
    // The review -> answer transition is one-way: re-calling it must not
    // restart the answer countdown (an exam integrity requirement — the
    // two-minute answer window cannot be extended by repeating the call).
    if ((quiz.phase || 'answer') !== 'review')
      return conflict('The answer phase for this question has already started; its timer cannot be reset.');
    const next = { ...quiz, phase: 'answer', question_started_at: new Date().toISOString() };
    await store.update('assessments', a.id, { quiz_state: next });
    return ok({ phase: 'answer', remaining_ms: budgetsFor(q).answer_ms });
  });

  route('POST', '/candidate/assessments/:id/next', R, async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status))
      return conflict('This assessment has already been submitted.');
    const questions = sortedQuestions(a.snapshot_json);
    const quiz = ensureQuizState(a, questions);
    const q = questions[quiz.index];
    if (!q) return ok({ complete: true, index: quiz.index, total: questions.length });

    let base = quiz;
    if (body?.answer !== undefined && body.answer !== null && !isBlank(q, body.answer)) {
      if (!validateAnswerShape(q, body.answer)) return unprocessable('Invalid answer for the current question.');
      const existing = await store.list('responses', { assessment_id: a.id });
      const r = existing.find((x) => x.question_id === q.id);
      const stored = persistableAnswer(q, body.answer);
      if (r) await store.update('responses', r.id, { answer: stored, locked: true });
      else await store.insert('responses', { assessment_id: a.id, question_id: q.id, answer: stored, locked: true });
      if (stored.audio_missing) {
        // Locking a mic-required answer with no recording is a proctoring
        // event: it lands in the exam's integrity trail and the audit log so
        // the gap is reviewed instead of silently scored.
        base = integrityPatch(base, 'spoken_answer_missing',
          `Q${quiz.index + 1} required a recorded answer; only typed notes were submitted.`,
          { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt });
        const candidate = await myCandidate(store, auth.user);
        await audit(
          store, auth.user, 'exam_spoken_answer_missing', 'assessments', a.id,
          `"${candidate?.name || 'Candidate'}" locked Q${quiz.index + 1} without a recording — "${String(q.prompt).slice(0, 80)}"`,
          { question_index: quiz.index, question_id: q.id },
        );
      }
    }

    const nextIndex = quiz.index + 1;
    const nextQ = questions[nextIndex];
    const nextState = {
      ...base,
      index: nextIndex,
      question_started_at: new Date().toISOString(),
      phase: nextQ && isOpenQuestion(nextQ) ? 'review' : 'answer',
    };
    await store.update('assessments', a.id, { quiz_state: nextState });
    return ok({ complete: nextIndex >= questions.length, index: nextIndex, total: questions.length });
  });

  route('POST', '/candidate/assessments/:id/submit', R, async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (a.status === 'submitted') return conflict('This assessment has already been submitted.');
    if (['scored', 'validated'].includes(a.status)) return conflict('This assessment is already scored.');
    const incoming = body.answers;
    if (!incoming || typeof incoming !== 'object') return bad('answers must be an object keyed by question id.');

    const questions = sortedQuestions(a.snapshot_json);
    const quiz = a.quiz_state || null;
    const examDone = quiz && Number(quiz.index) >= questions.length;
    const existing = await store.list('responses', { assessment_id: a.id });
    const answers = {
      ...Object.fromEntries(existing.map((r) => [r.question_id, r.answer])),
      ...incoming,
      ...Object.fromEntries(existing.filter((r) => r.locked).map((r) => [r.question_id, r.answer])),
    };
    const missingQ = [];
    for (const q of questions) {
      const v = answers[q.id];
      if (isBlank(q, v)) missingQ.push(q.id);
      else if (!validateAnswerShape(q, v)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
    }
    if (missingQ.length && !examDone)
      return unprocessable(`${missingQ.length} question(s) are unanswered.`, { missing_question_ids: missingQ });

    const byQid = new Map(existing.map((r) => [r.question_id, r]));
    for (const q of questions) {
      const raw = answers[q.id];
      const blank = isBlank(q, raw);
      const value = blank
        ? (q.type === 'mcq_multi' ? [] : (q.type === 'text' ? { text: '', transcript: '', source: 'timed_out' } : ''))
        : persistableAnswer(q, raw);
      const scoreInput = q.type === 'text' ? textValue(value) : value;
      const auto = isAutoQuestion(q) ? (blank ? 0 : (autoScore(q, scoreInput) ?? 0)) : null;
      const r = byQid.get(q.id);
      const patch = { answer: value, auto_score: auto };
      if (r) await store.update('responses', r.id, patch);
      else await store.insert('responses', { assessment_id: a.id, question_id: q.id, ...patch });
    }
    await store.update('assessments', a.id, { status: 'submitted', submitted_at: new Date().toISOString() });
    const candidate = await myCandidate(store, auth.user);
    await audit(store, auth.user, 'assessment_submitted', 'assessments', a.id, `"${candidate?.name}" submitted their assessment`);
    return ok({ status: 'submitted' });
  });

  route('GET', '/candidate/reports/:id', R, async ({ store, auth, params }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['scored', 'validated'].includes(a.status) || !a.report_json)
      return conflict('Your report will be available once scoring is complete.');
    const candidate = await myCandidate(store, auth.user);
    return ok({
      candidate: { id: candidate.id, name: candidate.name, current_title: candidate.current_title || '' },
      report: reportForCandidate(a.report_json, a),
    });
  });
}
