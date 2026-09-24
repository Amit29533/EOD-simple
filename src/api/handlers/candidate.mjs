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

/** Submit-time migration for older response rows that still carry inline audio. */
async function persistAnswer(store, assessmentId, q, value) {
  const { answer, audio } = splitAnswer(q, value, { trusted: true });
  if (audio) answer.audio_ref = await saveRecording(store, assessmentId, q.id, audio);
  return answer;
}

/**
 * Change a response using the row currently in storage, not a list snapshot
 * taken before a concurrent draft/lock on a different function instance. The
 * JSON and Blobs adapters re-run `decide` under their shard lock / ETag CAS;
 * Airtable has no conditional-write primitive here, so it uses the same
 * decision contract with its existing per-process exam lock.
 * `decide` is pure: undefined = leave alone, null = delete, object = patch.
 */
async function changeResponse(store, assessmentId, questionId, decide) {
  const key = { assessment_id: assessmentId, question_id: questionId };
  if (typeof store.changeRow === 'function') return store.changeRow('responses', key, decide);
  const current = (await store.list('responses', key))[0] || null;
  const patch = decide(current);
  if (patch === undefined || (patch === null && !current)) return { row: current, changed: false };
  if (patch === null) {
    await store.remove('responses', current.id);
    return { row: null, changed: true };
  }
  const row = current
    ? await store.update('responses', current.id, patch)
    : await store.insert('responses', { ...key, ...patch });
  return { row, changed: true };
}

/** Move the exam cursor only if the question being locked is still current. */
async function changeAssessment(store, assessmentId, decide) {
  if (typeof store.changeRow === 'function') return store.changeRow('assessments', { id: assessmentId }, decide);
  const current = await store.get('assessments', assessmentId);
  const patch = decide(current);
  if (!current || patch === undefined) return { row: current, changed: false };
  return { row: await store.update('assessments', assessmentId, patch), changed: true };
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
    const accepted = [];
    const ignored = [];
    // A malformed value is a client bug whichever question it names, even if
    // it is not the live question. Validate the whole request before writing.
    for (const [qid, value] of Object.entries(answers)) {
      const q = qById.get(qid);
      if (!q) continue;
      const clearing = value === null || value === '' || (Array.isArray(value) && !value.length);
      if (!clearing && !validateAnswerShape(q, value)) return unprocessable(`Invalid answer for question "${q.prompt.slice(0, 60)}".`);
    }
    for (const [qid, value] of Object.entries(answers)) {
      const q = qById.get(qid);
      if (!q) continue;
      if (!live || q.id !== live.id || !inTime) {
        ignored.push(qid);
        continue;
      }
      const clearing = value === null || value === '' || (Array.isArray(value) && !value.length);
      // The clip lives outside the response shard. Its reference is attached
      // to the answer only if the row is still writable. `audio_keep` resolves
      // against the row inside the CAS loop, not an earlier list snapshot.
      const audio = !clearing && q.type === 'text' ? splitAnswer(q, value).audio : null;
      // A stale exam snapshot may still call this after /next locked the row.
      // Do not replace its recording before the CAS can reject the draft.
      if (audio && (await store.list('responses', { assessment_id: a.id, question_id: qid }))[0]?.locked) {
        ignored.push(qid);
        continue;
      }
      const audioRef = audio ? await saveRecording(store, a.id, qid, audio) : null;
      const result = await changeResponse(store, a.id, qid, (current) => {
        if (current?.locked) return undefined;
        if (clearing || (q.type === 'text' && !openAnswerHasContent(value) && !keepsRecording(q, value, current)))
          return current ? null : undefined;
        const stored = q.type === 'text' ? splitAnswer(q, value, { keep: current?.answer }).answer : value;
        if (audioRef) stored.audio_ref = audioRef;
        if (stableJson(current?.answer) === stableJson(stored)) return undefined;
        return { answer: stored };
      });
      if (result.row?.locked) ignored.push(qid);
      else {
        accepted.push(qid);
        // Deleting the old recording before the CAS could delete a clip that
        // a concurrent /next just locked; only remove it after our change.
        if (result.changed && q.type === 'text' && !result.row?.answer?.audio_ref)
          await dropRecordings(store, a.id, qid);
      }
    }
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
    // LOCKED response row: the posted answer, an in-time draft, or a blank.
    // Read the draft here for the usual fast path (and to avoid re-uploading a
    // clip already locked), but choose the final answer under the response
    // shard's CAS: another Netlify instance may save a draft between this read
    // and the lock. A stale insert must neither throw DUPLICATE_ID nor let a
    // late autosave change the locked answer.
    const existing = await store.list('responses', { assessment_id: a.id });
    const r = existing.find((x) => x.question_id === q.id);

    // Answer flow: allow answering in review or answer phase (review is UI
    // guidance, not a hard gate). Past the grace window, only a draft saved in
    // time may be locked; the newly posted answer is ignored.
    const answerToLock = hardExpired ? null : body?.answer;

    // The spoken-answer contract leaves the same trail however the answer got
    // locked. It used to fire only for an answer posted with the advance: a
    // typed-only answer that arrived as an autosave draft and was locked by a
    // blank or expired advance carried `audio_missing` on the row (so the
    // assessor saw the warning) while the integrity counter, the exam event
    // trail and the audit log all stayed silent for it.
    const pendingEvents = [];
    const noteMissingSpoken = async (stored, logAudit = true) => {
      if (!stored || typeof stored !== 'object' || stored.audio_missing !== true) return;
      pendingEvents.push({
        event: 'spoken_answer_missing',
        detail: `Q${quiz.index + 1} required a recorded answer; only typed notes were submitted.`,
      });
      // A previous /next may have locked the row and still be writing its
      // cursor/audit (or may have died mid-request). The CAS below lets only
      // one advance add the integrity event. Do not duplicate its audit row.
      if (!logAudit) return;
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

    // A recording-only answer with audio_keep is usable if the *latest* draft
    // holds the clip, even if the initial list saw no draft yet.
    const posted = answerToLock !== undefined && answerToLock !== null && !isBlank(q, answerToLock);
    const keepRequest = q.type === 'text' && answerToLock && typeof answerToLock === 'object'
      && answerToLock.audio_keep === true;
    if ((posted || keepRequest) && !validateAnswerShape(q, answerToLock))
      return unprocessable('Invalid answer for the current question.');
    const audio = posted && q.type === 'text' && !r?.locked ? splitAnswer(q, answerToLock).audio : null;
    const audioRef = audio ? await saveRecording(store, a.id, q.id, audio) : null;
    const locked = await changeResponse(store, a.id, q.id, (current) => {
      if (current?.locked) return undefined; // another /next already took this answer
      const usable = posted || (answerToLock !== null && answerToLock !== undefined
        && keepsRecording(q, answerToLock, current));
      let answer;
      if (usable) {
        answer = q.type === 'text' ? splitAnswer(q, answerToLock, { keep: current?.answer }).answer : answerToLock;
        if (audioRef) answer.audio_ref = audioRef;
      } else {
        // An unlocked draft was saved while this question was live; it wins
        // over a late or blank POST. A previously locked row is never changed.
        answer = current && !isBlank(q, current.answer)
          ? current.answer : blankAnswerFor(q, timeExpired ? 'timed_out' : 'skipped');
      }
      return { answer, locked: true };
    });
    if (locked.changed) {
      const stored = locked.row.answer;
      const draftUsed = !posted && !isBlank(q, stored);
      if (q.type === 'text' && !stored?.audio_ref) await dropRecordings(store, a.id, q.id);
      await noteMissingSpoken(stored);
      if (hardExpired) {
        pendingEvents.unshift({
          event: 'time_expired',
          detail: `Q${quiz.index + 1} time expired - auto-advanced ${draftUsed ? 'with the answer saved in time' : 'as blank'}.`,
        });
      } else if (timeExpired && !draftUsed && isBlank(q, stored)) {
        pendingEvents.push({ event: 'time_expired', detail: `Q${quiz.index + 1} time expired - recorded as blank.` });
      }
    } else {
      // Recover a partially completed lock: the response was committed but
      // the first instance has not yet advanced the cursor. If this request
      // wins that advance, the missing-recording counter must still be kept.
      await noteMissingSpoken(locked.row?.answer, false);
    }

    const nextIndex = quiz.index + 1;
    const nextQ = questions[nextIndex];
    // The row lock and the cursor live in different objects. Another /next
    // may have locked the row first but not yet advanced the cursor, so a
    // second call may help it finish. If it already advanced, do NOT restart
    // the next question's clock or erase the first call's integrity events.
    // Apply our events to the latest quiz state *inside* the table CAS, so an
    // integrity beacon that arrived meanwhile is kept too.
    const moved = await changeAssessment(store, a.id, (current) => {
      if (!current || !['assigned', 'in_progress'].includes(current.status)) return undefined;
      const latest = ensureQuizState(current, questions);
      if (latest.index !== quiz.index) return undefined;
      let state = latest;
      for (const { event, detail } of pendingEvents) {
        state = integrityPatch(state, event, detail,
          { question_index: quiz.index, question_id: q.id, question_prompt: q.prompt });
      }
      return { quiz_state: {
        ...state, index: nextIndex, question_started_at: new Date().toISOString(),
        phase: nextQ && isOpenQuestion(nextQ) ? 'review' : 'answer',
      } };
    });
    if (!moved.row) return notFound('Assessment not found.');
    const index = moved.row.quiz_state?.index ?? quiz.index;
    return ok({ complete: index >= questions.length, index, total: questions.length,
      ...(!moved.changed ? { duplicate: true } : {}) });
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
      const value = blank ? (r?.answer ?? blankAnswerFor(q)) : await persistAnswer(store, a.id, q, raw);
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
