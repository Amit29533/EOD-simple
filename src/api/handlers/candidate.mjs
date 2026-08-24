import { ok, bad, notFound, conflict, unprocessable, audit } from '../helpers.mjs';
import { questionForCandidate, competencyForCandidate, reportForCandidate } from '../projections.mjs';
import { autoScore, isAutoQuestion } from '../../core/scoring.mjs';

const R = ['candidate'];

async function myCandidate(store, user) {
  return user.candidate_id ? store.get('candidates', user.candidate_id) : null;
}
/** Owned-or-404: never reveal that an assessment belongs to someone else. */
async function ownAssessment(store, user, id) {
  const a = await store.get('assessments', id);
  return a && a.candidate_id === user.candidate_id ? a : null;
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
      return typeof value === 'string' && value.trim().length > 0;
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
      })),
    });
  });

  route('GET', '/candidate/assessments/:id', R, async ({ store, auth, params }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    // first open starts the clock
    if (a.status === 'assigned') {
      await store.update('assessments', a.id, { status: 'in_progress', started_at: new Date().toISOString() });
      a.status = 'in_progress';
    }
    const responses = await store.list('responses', { assessment_id: a.id });
    const answers = Object.fromEntries(responses.map((r) => [r.question_id, r.answer]));
    const snap = a.snapshot_json;
    return ok({
      assessment: {
        id: a.id, status: a.status, started_at: a.started_at, submitted_at: a.submitted_at,
        role: snap.role ? { name: snap.role.name, description: snap.role.description } : null,
      },
      // sanitized: no correct answers, no rubrics, no assessor identity
      competencies: snap.competencies.map(competencyForCandidate),
      questions: snap.questions.map(questionForCandidate),
      answers,
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
      if (!q) continue; // ignore unknown ids
      if (value === null || value === '' || (Array.isArray(value) && !value.length)) {
        const r = byQid.get(qid);
        if (r) await store.remove('responses', r.id);
        continue;
      }
      if (!validateAnswerShape(q, value)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
      const r = byQid.get(qid);
      if (r) await store.update('responses', r.id, { answer: value });
      else await store.insert('responses', { assessment_id: a.id, question_id: qid, answer: value });
    }
    if (a.status === 'assigned')
      await store.update('assessments', a.id, { status: 'in_progress', started_at: new Date().toISOString() });
    return ok({ ok: true, saved_at: new Date().toISOString() });
  });

  route('POST', '/candidate/assessments/:id/submit', R, async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (a.status === 'submitted') return conflict('This assessment has already been submitted.');
    if (['scored', 'validated'].includes(a.status)) return conflict('This assessment is already scored.');
    const answers = body.answers;
    if (!answers || typeof answers !== 'object') return bad('answers must be an object keyed by question id.');

    const questions = a.snapshot_json.questions;
    const missingQ = [];
    for (const q of questions) {
      const v = answers[q.id];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) missingQ.push(q.id);
      else if (!validateAnswerShape(q, v)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
    }
    if (missingQ.length) return unprocessable(`${missingQ.length} question(s) are unanswered.`, { missing_question_ids: missingQ });

    // replace the full answer set (idempotent re-save) and auto-score now
    const existing = await store.list('responses', { assessment_id: a.id });
    const byQid = new Map(existing.map((r) => [r.question_id, r]));
    for (const q of questions) {
      const value = answers[q.id];
      const auto = isAutoQuestion(q) ? (autoScore(q, value) ?? 0) : null;
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
