import { ok, bad, notFound, conflict, unprocessable, audit, bulkInsert, bulkUpdate, bulkRemove, stableJson } from '../helpers.mjs';
import { questionForCandidate, competencyForCandidate, reportForCandidate } from '../projections.mjs';
import { autoScore, isAutoQuestion } from '../../core/scoring.mjs';
import { MAX_AUDIO_B64 } from '../../core/constants.mjs';
import {
  sortedQuestions, isOpenQuestion, budgetsFor, ensureQuizState, remainingMs, remainingTimeMs, integrityPatch,
  MAX_INTEGRITY_EVENTS,
} from '../quiz-session.mjs';
import {
  requiresSpokenAnswer, hasSpokenEvidence, openAnswerHasContent,
} from '../../core/spoken-answer.mjs';
import { withLock } from '../mutex.mjs';
import { paperFacts, paperSummary } from '../assessment-service.mjs';

const R = ['candidate'];

/**
 * How far past a question's budget the API still accepts the answer that was
 * on its way — network latency, the 250 ms ticker, a slow tab. Beyond it the
 * window is treated as closed: the advance records a blank, the review
 * hand-over is logged, and autosave stops taking drafts for the question.
 */
const EXAM_GRACE_MS = 5000;

// Every mutation below is a read-modify-write over one assessment, so each
// runs under that assessment's lock: without it, parallel autosaves,
// integrity beacons and advances interleave and lose each other's writes
// (duplicate response rows, dropped integrity increments). See mutex.mjs.
const locked = (fn) => async (ctx) => withLock(`assessment:${ctx.params.id}`, () => fn(ctx));

async function myCandidate(store, user) {
  return user.candidate_id ? store.get('candidates', user.candidate_id) : null;
}
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
  if (q.type === 'text') return !openAnswerHasContent(value);
  return false;
}

/**
 * Stored shape of an unanswered question, by type. The `source` on an open
 * blank tells the assessor (and the report) how the blank came about: the
 * clock ran out (`timed_out`) or the candidate moved on without answering
 * (`skipped`) — rather than an answer the candidate gave.
 */
function blankAnswerFor(q, source = 'timed_out') {
  if (q.type === 'mcq_multi') return [];
  if (q.type === 'text') return { text: '', transcript: '', source };
  return '';
}

/** Has this question already got a row on the paper? (keyed by question id) */
const responseIndex = (rows) => new Map(rows.map((r) => [r.question_id, r]));

/**
 * Normalise an open answer and separate the recording from it.
 *
 * Returns `{ answer, audio }`: `answer` is what the response row stores and
 * `audio` is `{ b64, mime }` when the submission carried a valid clip. The
 * clip never goes on the row. A two-minute answer is ~320,000 base64
 * characters and a whole-bank paper has 33 of them: kept on the rows, one
 * finished candidate added ~10 MB that every exam request re-read (the
 * responses table is listed per GET and lock, and rewritten per lock on the
 * file and blob adapters), every unrelated write of the file store
 * re-serialised (an admin login went from 5 ms to 210 ms), and the assessor's
 * detail payload carried whole (10 MB — past a serverless function's 6 MB
 * response cap). Recordings live in the `recordings` table (one object per
 * row on the file and blob adapters) and the answer keeps `audio_ref`.
 *
 * `trusted` marks a value that is already a stored row (the submit-time
 * re-normalisation): its `audio_ref` is kept. A client can never plant one —
 * an untrusted `audio_ref` is dropped, so it cannot fake spoken evidence.
 *
 * A bare string is a typed-only open answer. It used to be stored verbatim,
 * which skipped the spoken-answer contract: a client that posted
 * `answer: "..."` instead of the `{ text, transcript }` object was never
 * flagged `audio_missing`, so the integrity counter, the exam trail and the
 * assessor's "no recording" warning all stayed silent for it.
 *
 * `keep` is the answer already stored for this same (assessment, question) —
 * the draft the exam hall autosaved seconds earlier. A value that carries no
 * clip but `audio_keep: true` keeps THAT recording instead of dropping it, so
 * the hall can autosave note edits without re-uploading a two-minute clip
 * each time, and can lock a restored draft after a reload. It is still not a
 * way to plant evidence: the reference comes from the store, never from the
 * request, and with nothing stored the answer is flagged `audio_missing`
 * exactly as before. `kept` tells the caller not to drop the recording.
 */
const AUDIO_MIME = /^audio\/[\w.+-]{1,40}(;\s?codecs=[\w.,+-]{1,60})?$/i;

function splitAnswer(q, value, { trusted = false, keep = null } = {}) {
  const open = q.type === 'text' && typeof value === 'string'
    ? { text: value, transcript: '', source: 'typed' }
    : value;
  if (q.type !== 'text' || !open || typeof open !== 'object') return { answer: value, audio: null, kept: false };
  const out = {
    text: String(open.text || ''),
    transcript: String(open.transcript || ''),
    source: open.source === 'audio' ? 'audio' : 'typed',
  };
  // The mime type ends up in a `data:` URL on the assessor's screen: keep it
  // to a media type MediaRecorder would actually report (`audio/webm`,
  // `audio/webm;codecs=opus`, Firefox's `audio/ogg; codecs=opus`).
  const rawMime = String(open.audio_mime || '').trim();
  const mime = AUDIO_MIME.test(rawMime) ? rawMime : 'audio/webm';
  const b64 = String(open.audio_b64 || '').replace(/\s/g, '');
  let audio = null;
  let kept = false;
  if (b64 && b64.length <= MAX_AUDIO_B64 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
    audio = { b64, mime };
    out.audio_mime = mime;
  } else if (trusted && typeof open.audio_ref === 'string' && open.audio_ref) {
    out.audio_ref = open.audio_ref;
    out.audio_mime = mime;
  } else if (open.audio_keep === true && keep && typeof keep === 'object'
    && typeof keep.audio_ref === 'string' && keep.audio_ref) {
    out.audio_ref = keep.audio_ref;
    out.audio_mime = AUDIO_MIME.test(String(keep.audio_mime || '')) ? keep.audio_mime : mime;
    kept = true;
  }
  if (requiresSpokenAnswer(q) && !audio && !hasSpokenEvidence(out)) out.audio_missing = true;
  return { answer: out, audio, kept };
}

/** The one recording row for (assessment, question): replaced in place. */
async function saveRecording(store, assessmentId, questionId, audio) {
  const rows = await store.list('recordings', { assessment_id: assessmentId, question_id: questionId });
  if (rows.length) {
    const [keep, ...extra] = rows;
    await store.update('recordings', keep.id, { audio });
    if (extra.length) await bulkRemove(store, 'recordings', extra.map((r) => r.id));
    return keep.id;
  }
  const rec = await store.insert('recordings', { assessment_id: assessmentId, question_id: questionId, audio });
  return rec.id;
}

async function dropRecordings(store, assessmentId, questionId) {
  const rows = await store.list('recordings', { assessment_id: assessmentId, question_id: questionId });
  if (rows.length) await bulkRemove(store, 'recordings', rows.map((r) => r.id));
}

/**
 * The stored form of an answer, its recording saved to the recordings table
 * and referenced from the row. An open answer that arrives from the client
 * without a clip drops whatever recording a draft left for the question —
 * the posted answer is the answer, exactly as when the clip rode on the row —
 * unless it asked to keep it (`audio_keep`, see splitAnswer).
 */
async function persistAnswer(store, assessmentId, q, value, opts = {}) {
  const { answer, audio, kept } = splitAnswer(q, value, opts);
  if (audio) answer.audio_ref = await saveRecording(store, assessmentId, q.id, audio);
  else if (q.type === 'text' && !opts.trusted && !kept) await dropRecordings(store, assessmentId, q.id);
  return answer;
}

/** Does this open answer ask to keep a recording that `prior` actually holds? */
const keepsRecording = (q, value, prior) => q.type === 'text' && value && typeof value === 'object'
  && value.audio_keep === true && typeof prior?.answer?.audio_ref === 'string' && Boolean(prior.answer.audio_ref);

function validateAnswerShape(q, value) {
  switch (q.type) {
    case 'mcq_single': {
      const ids = new Set((q.options || []).map((o) => String(o.id)));
      return (typeof value === 'string' || typeof value === 'number') && ids.has(String(value));
    }
    case 'mcq_multi': {
      const ids = new Set((q.options || []).map((o) => String(o.id)));
      return Array.isArray(value) && value.every((v) => ids.has(String(v)));
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
    const rows = await store.list('assessments', { candidate_id: candidate.id }, { detached: false });
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const facts = await paperFacts(store, rows);
    return ok({
      candidate: { id: candidate.id, name: candidate.name, stage: candidate.stage },
      assessments: rows.map((a, i) => ({
        id: a.id, status: a.status, created_at: a.created_at, started_at: a.started_at,
        submitted_at: a.submitted_at, scored_at: a.scored_at,
        overall_pct: ['scored', 'validated'].includes(a.status) ? a.overall_pct : null,
        readiness_label: ['scored', 'validated'].includes(a.status) ? a.readiness_label : null,
        readiness_key: ['scored', 'validated'].includes(a.status) ? a.readiness_key : null,
        role_name: facts[i].role_name || 'Assessment',
        question_count: facts[i].question_count,
        total_points: facts[i].total_points,
      })),
    });
  });

  // Under the assessment lock like every mutation: opening the exam is a
  // read-modify-write too (it starts the paper and seeds the quiz state), so
  // an unlocked GET racing a /next could persist a stale cursor over the
  // advance's write.
  route('GET', '/candidate/assessments/:id', R, locked(async ({ store, auth, params }) => {
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
    // Persist the state whenever ensureQuizState had to create or heal it. A
    // legacy/corrupt state whose clock was backfilled used to be returned but
    // never written, so every reload minted a fresh `question_started_at` and
    // the server-side budget for that question could never run out.
    if (!a.quiz_state || quiz.question_started_at !== a.quiz_state.question_started_at) patch.quiz_state = quiz;
    // A row allocated before the listing facts existed gains them on its
    // first open (this write also moves its inline paper out of the table).
    if (a.role_name === undefined || a.total_points === undefined) Object.assign(patch, paperSummary(snap));
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
  }));

  route('PUT', '/candidate/assessments/:id/answers', R, locked(async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status))
      return conflict('This assessment has already been submitted.');
    const answers = body.answers;
    if (!answers || typeof answers !== 'object') return bad('answers must be an object keyed by question id.');
    // Validate against the SERVED paper (de-duplicated, spoken-contract
    // healed), exactly as /next and /submit do — the raw snapshot can still
    // hold a legacy twin or a flag-less open row, and a draft checked against
    // that copy would be stored under a contract the exam never served.
    const questions = sortedQuestions(a.snapshot_json);
    const qById = new Map(questions.map((q) => [q.id, q]));
    // The exam is one question at a time, so a draft can only be for the
    // question on screen, and only while its clock is running. Autosave used
    // to take a draft for ANY question on the paper — a passed one, a future
    // one, the live one long after its window closed — and the final submit
    // then graded those drafts as answers. That let a scripted client walk the
    // paper blank (reading every prompt), answer offline and post the lot at
    // the end. Anything but the live, in-time question is ignored the way an
    // unknown id is: the browser's exam hall never sends such a draft.
    // (Nothing is on screen before the exam hall has been opened — the GET
    // that seeds `quiz_state` — so until then there is no live question.)
    const quiz = ensureQuizState(a, questions);
    const live = a.quiz_state ? questions[quiz.index] || null : null;
    const inTime = live ? remainingTimeMs(live, quiz, Date.now()) >= -EXAM_GRACE_MS : false;
    const existing = await store.list('responses', { assessment_id: a.id });
    const byQid = responseIndex(existing);
    // One write for the whole autosave instead of one per answer. The file and
    // blob adapters rewrite the entire table on every single-row write, so a
    // per-answer loop over a full paper is hundreds of whole-table rewrites —
    // and this route is the chatty one (recording stop, note edits).
    const updates = [];
    const inserts = [];
    const removals = [];
    const accepted = [];
    const ignored = [];
    for (const [qid, value] of Object.entries(answers)) {
      const q = qById.get(qid);
      if (!q) continue;
      const clearing = value === null || value === '' || (Array.isArray(value) && !value.length);
      // A malformed value is a client bug whichever question it names, so it
      // is still refused; only the *storing* is limited to the live question.
      if (!clearing && !validateAnswerShape(q, value)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
      const prior = byQid.get(qid);
      if (!live || q.id !== live.id || !inTime || prior?.locked) {
        ignored.push(qid);
        continue;
      }
      accepted.push(qid);
      // Notes cleared while a recording stays on the server is still an
      // answer (the recording), not a request to wipe the question.
      if (clearing || (q.type === 'text' && !openAnswerHasContent(value) && !keepsRecording(q, value, prior))) {
        if (prior) removals.push(prior.id);
        if (q.type === 'text') await dropRecordings(store, a.id, q.id);
        continue;
      }
      const stored = await persistAnswer(store, a.id, q, value, { keep: prior?.answer });
      if (!prior) inserts.push({ assessment_id: a.id, question_id: qid, answer: stored });
      else if (stableJson(prior.answer) !== stableJson(stored)) updates.push({ id: prior.id, patch: { answer: stored } });
    }
    await bulkUpdate(store, 'responses', updates);
    await bulkInsert(store, 'responses', inserts);
    await bulkRemove(store, 'responses', removals);
    if (a.status === 'assigned')
      await store.update('assessments', a.id, { status: 'in_progress', started_at: new Date().toISOString() });
    return ok({ ok: true, saved_at: new Date().toISOString(), accepted_question_ids: accepted, ignored_question_ids: ignored });
  }));

  route('POST', '/candidate/assessments/:id/integrity', R, locked(async ({ store, auth, params, body }) => {
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
    // The exam's own trail keeps every counter and the last MAX_INTEGRITY_EVENTS
    // events; the audit log mirrors those events one row each. That mirror is
    // capped at the same ring size per assessment: the audit table rotates at
    // 2,000 rows, so an unbounded mirror let a candidate — the one actor whose
    // beacons are self-reported — push every admin action out of the audit
    // log with a few thousand `blur` posts. Past the cap the exam trail still
    // records the event (counters, `events_dropped`); only the audit copy stops.
    const totalEvents = (quiz.events || []).length + (Number(quiz.events_dropped) || 0);
    if (totalEvents > MAX_INTEGRITY_EVENTS) return ok({ integrity: quiz.integrity, events: quiz.events });
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
  }));

  route('POST', '/candidate/assessments/:id/phase', R, locked(async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status)) return conflict('This assessment is no longer in progress.');
    const questions = sortedQuestions(a.snapshot_json);
    const quiz = ensureQuizState(a, questions);
    const q = questions[quiz.index];
    if (!q || !isOpenQuestion(q)) return unprocessable('This question has no review phase.');
    if (body?.phase !== 'answer') return bad('phase must be "answer".');
    if ((quiz.phase || 'answer') !== 'review')
      return conflict('The answer phase for this question has already started; its timer cannot be reset.');
    // The transition itself grants a fresh answer budget, so a candidate who
    // sleeps through review (a backgrounded tab, a dead network) must not get
    // that window silently: past the same grace the /next path allows, the
    // overrun is recorded in the integrity trail — mirroring the automatic
    // review-expiry advance, which logs before transitioning.
    let base = quiz;
    if (remainingTimeMs(q, quiz, Date.now()) < -EXAM_GRACE_MS) {
      base = integrityPatch(
        base,
        'time_expired',
        `Q${quiz.index + 1} review window expired before the candidate started answering.`,
        { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt },
      );
    }
    const next = { ...base, phase: 'answer', question_started_at: new Date().toISOString() };
    await store.update('assessments', a.id, { quiz_state: next });
    return ok({ phase: 'answer', remaining_ms: budgetsFor(q).answer_ms });
  }));

  route('POST', '/candidate/assessments/:id/next', R, locked(async ({ store, auth, params, body }) => {
    const a = await ownAssessment(store, auth.user, params.id);
    if (!a) return notFound('Assessment not found.');
    if (!['assigned', 'in_progress'].includes(a.status))
      return conflict('This assessment has already been submitted.');
    const questions = sortedQuestions(a.snapshot_json);
    const quiz = ensureQuizState(a, questions);
    const q = questions[quiz.index];
    if (!q) return ok({ complete: true, index: quiz.index, total: questions.length });

    // Idempotent advances: the exam hall sends the question it is answering,
    // so a duplicated advance — a double click, an auto-retry after a dropped
    // response — is a no-op once the cursor has moved on, instead of skipping
    // the live question the candidate has not seen yet. (Older callers that
    // send no question_id keep the legacy always-advance behavior.)
    if (body?.question_id !== undefined && body.question_id !== q.id) {
      return ok({ complete: false, index: quiz.index, total: questions.length, duplicate: true });
    }

    const now = Date.now();
    const raw = remainingTimeMs(q, quiz, now);
    const timeExpired = raw <= 0;
    const hardExpired = raw < -EXAM_GRACE_MS;

    let base = quiz;

    // Review timer expired: auto-advance to answer phase (soft expiry returns phase_advanced)
    if (isOpenQuestion(q) && (quiz.phase || 'answer') === 'review' && timeExpired) {
      if (hardExpired) {
        base = integrityPatch(
          base,
          'time_expired',
          `Q${quiz.index + 1} review expired - auto-advanced to answer.`,
          { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt },
        );
      }
      const nextQuiz = { ...base, phase: 'answer', question_started_at: new Date().toISOString() };
      await store.update('assessments', a.id, { quiz_state: nextQuiz });
      return ok({
        complete: false,
        index: quiz.index,
        total: questions.length,
        phase_advanced: true,
        remaining_ms: budgetsFor(q).answer_ms,
      });
    }

    // Whatever happens below, the question being left behind ends up with a
    // LOCKED response row: the answer that was posted, the draft autosave took
    // while the clock was running, or a blank. A blank advance used to store
    // nothing at all, which left the question open to be answered later — by a
    // draft PUT or by the final submit — long after its window had closed.
    const existing = await store.list('responses', { assessment_id: a.id });
    const r = existing.find((x) => x.question_id === q.id);
    // An unlocked draft can only have been written inside the question's
    // window (the autosave route refuses anything else), so it is an answer
    // given in time even when the lock itself arrives late.
    const draft = r && !r.locked && !isBlank(q, r.answer) ? r.answer : null;
    const lockRow = (answer) => (r
      ? store.update('responses', r.id, { answer, locked: true })
      : store.insert('responses', { assessment_id: a.id, question_id: q.id, answer, locked: true }));

    // Answer flow: allow answering in review or answer phase (review is UI guidance, not hard gate)
    let answerToLock = body?.answer;
    if (hardExpired) {
      answerToLock = null; // a late answer is not accepted
      base = integrityPatch(
        base,
        'time_expired',
        `Q${quiz.index + 1} time expired - auto-advanced ${draft ? 'with the answer saved in time' : 'as blank'}.`,
        { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt },
      );
    }

    // The spoken-answer contract leaves the same trail however the answer got
    // locked. It used to fire only for an answer posted with the advance: a
    // typed-only answer that arrived as an autosave draft and was locked by a
    // blank or expired advance carried `audio_missing` on the row (so the
    // assessor saw the warning) while the integrity counter, the exam event
    // trail and the audit log all stayed silent for it.
    const noteMissingSpoken = async (stored) => {
      if (!stored || typeof stored !== 'object' || stored.audio_missing !== true) return;
      base = integrityPatch(
        base,
        'spoken_answer_missing',
        `Q${quiz.index + 1} required a recorded answer; only typed notes were submitted.`,
        { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt },
      );
      const candidate = await myCandidate(store, auth.user);
      await audit(
        store,
        auth.user,
        'exam_spoken_answer_missing',
        'assessments',
        a.id,
        `"${candidate?.name || 'Candidate'}" locked Q${quiz.index + 1} without a recording - "${String(q.prompt).slice(0, 80)}"`,
        { question_index: quiz.index, question_id: q.id },
      );
    };

    // An open answer whose only content is the recording it asks to keep is
    // not blank: it locks that recording (with whatever notes came with it).
    const usable = answerToLock !== undefined && answerToLock !== null
      && (!isBlank(q, answerToLock) || keepsRecording(q, answerToLock, r));
    if (usable) {
      if (!validateAnswerShape(q, answerToLock))
        return unprocessable('Invalid answer for the current question.');
      const stored = await persistAnswer(store, a.id, q, answerToLock, { keep: r?.answer });
      await lockRow(stored);
      await noteMissingSpoken(stored);
    } else {
      // No usable answer arrived with the advance: lock the in-time draft if
      // there is one, otherwise record the question as a blank — exactly what
      // the rules on the gate page promise for a question that is left behind.
      // (A row that is already locked — a cursor wound back over it — keeps
      // the answer it holds rather than being blanked.)
      if (!r?.locked) {
        await lockRow(draft ?? blankAnswerFor(q, timeExpired ? 'timed_out' : 'skipped'));
        await noteMissingSpoken(draft);
      }
      if (timeExpired && !hardExpired && !draft) {
        base = integrityPatch(
          base,
          'time_expired',
          `Q${quiz.index + 1} time expired - recorded as blank.`,
          { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt },
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
  }));

  route('POST', '/candidate/assessments/:id/submit', R, locked(async ({ store, auth, params, body }) => {
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
    // The paper is what the exam hall locked, question by question, inside
    // each question's window. The submit body used to be merged over every
    // row that was not locked — so a client that walked the paper blank could
    // hand in a full answer sheet at the end, outside every timer. Answers in
    // the body are now validated (a malformed sheet is still refused) but
    // never graded: a question the walk left blank submits as a blank.
    const answers = Object.fromEntries(existing.map((r) => [r.question_id, r.answer]));
    const missingQ = [];
    for (const q of questions) {
      const posted = incoming[q.id];
      if (posted !== undefined && posted !== null && !isBlank(q, posted) && !validateAnswerShape(q, posted))
        return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
      const v = answers[q.id];
      if (isBlank(q, v)) missingQ.push(q.id);
      else if (!validateAnswerShape(q, v)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
    }
    if (missingQ.length && !examDone)
      return unprocessable(`${missingQ.length} question(s) are unanswered.`, { missing_question_ids: missingQ });

    const byQid = responseIndex(existing);
    // The final whistle used to rewrite every response row — 110 whole-store
    // rewrites for a 110-question paper (~1 GB of JSON through the file
    // adapter, or 110 read-modify-write round trips of the whole responses
    // table on a blob/Airtable backend). That is the "Submitting your
    // assessment…" screen that never finishes: on a serverless function the
    // submit is killed by the invocation timeout, the browser's POST never
    // answers, and the candidate is left on a spinner forever.
    //
    // Every answer was already persisted when it was locked, so there is
    // nothing to write for a completed paper. Collect only what actually
    // changed (a recovered/legacy row, an auto-score that moved, a blank for a
    // question that timed out) and persist it as one batch per table.
    const updates = [];
    const inserts = [];
    for (const q of questions) {
      const raw = answers[q.id];
      const blank = isBlank(q, raw);
      const r = byQid.get(q.id);
      // A blank the walk already stored keeps the source the advance gave it
      // (skipped / timed_out); only a question with no row at all — a cursor
      // pushed past it — is written here, as a timed-out blank.
      // `raw` is a stored row (or a legacy one still carrying its clip inline,
      // which moves to the recordings table here): trusted.
      const value = blank ? (r?.answer ?? blankAnswerFor(q)) : await persistAnswer(store, a.id, q, raw, { trusted: true });
      const scoreInput = q.type === 'text' ? textValue(value) : value;
      const auto = isAutoQuestion(q) ? (blank ? 0 : (autoScore(q, scoreInput) ?? 0)) : null;
      if (!r) {
        inserts.push({ assessment_id: a.id, question_id: q.id, answer: value, auto_score: auto });
        continue;
      }
      const patch = {};
      if (stableJson(r.answer) !== stableJson(value)) patch.answer = value;
      if ((r.auto_score ?? null) !== auto) patch.auto_score = auto;
      if (Object.keys(patch).length) updates.push({ id: r.id, patch });
    }
    await bulkUpdate(store, 'responses', updates);
    await bulkInsert(store, 'responses', inserts);
    await store.update('assessments', a.id, { status: 'submitted', submitted_at: new Date().toISOString() });
    const candidate = await myCandidate(store, auth.user);
    await audit(store, auth.user, 'assessment_submitted', 'assessments', a.id, `"${candidate?.name}" submitted their assessment`);
    return ok({ status: 'submitted' });
  }));

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
