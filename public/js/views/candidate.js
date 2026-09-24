import { api, session } from '../api.js';
import { state, VIEW_UNMOUNT_EVENT } from '../app.js';
import {
  esc, fmtDate, loading, emptyState, toast, attempt,
  pipelineStepper, assessmentStatusBadge, readinessBadge,
} from '../ui.js';
import { renderReport } from './report.js';
import {
  speechRecognitionCtor, buildTextAnswer, blobToStoredAudio, transcriptFromSpeechEvent,
  micCapability, startAudioRecorder,
} from '../exam-audio.js';

/* ================================ Portal (My Journey) ================================ */
export async function portalView(view) {
  document.body.classList.remove('exam-lock');
  view.innerHTML = loading();
  const d = await api('/candidate/assessments');
  const stages = state.meta.pipelineStages;
  view.innerHTML = `
    <div class="page-heading candidate-heading">
      <div><h1>${esc(d.candidate.name.split(' ')[0])}</h1><p class="muted">Your assessments and pipeline status.</p></div>
    </div>
    <div class="card journey-card">
      <div class="panel-head"><div><h2>Pipeline</h2></div></div>
      ${pipelineStepper(stages, d.candidate.stage)}
    </div>
    <div class="card assessment-list-card">
      <div class="panel-head"><div><h2>Assessments</h2></div></div>
      ${d.assessments.length ? d.assessments.map((a) => `
        <div class="q-card row between" style="margin-bottom:12px">
          <div>
            <b>${esc(a.role_name)}</b>
            <div class="small muted" style="margin-top:3px">
              ${assessmentStatusBadge(state.meta.assessmentStatuses, a.status)}
              ${a.readiness_label ? readinessBadge(a.readiness_key, a.readiness_label) : ''}
              · ${a.question_count} questions · allocated ${esc(fmtDate(a.created_at))}
            </div>
          </div>
          <div class="row">
            ${['assigned', 'in_progress'].includes(a.status) ? `<a class="btn" href="#/assessments/${a.id}/quiz">${a.status === 'in_progress' ? 'Continue secure exam' : 'Enter exam hall'} →</a>` : ''}
            ${a.status === 'submitted' ? `<span class="chip">Under assessor review — report arrives after scoring</span>` : ''}
            ${['scored', 'validated'].includes(a.status) ? `<a class="btn" href="#/assessments/${a.id}/report">View report card</a>` : ''}
          </div>
        </div>`).join('')
      : emptyState('No assessments yet', 'Your administrator will allocate one when you are ready.')}
    </div>`;
}

/* ================================ Secure exam ================================ */
function renderSubmitted(view) {
  document.body.classList.remove('exam-lock');
  view.innerHTML = `<div class="card">${emptyState('Assessment submitted', 'An assessor is reviewing your answers. Your report card appears here once scoring is complete.', '✅')}<div class="row" style="justify-content:center"><a class="btn secondary" href="#/journey">Back to My Journey</a></div></div>`;
}

export async function quizView(view, { id }) {
  view.innerHTML = loading();
  const gateKey = `ecod.exam.ack.${id}`;

  if (!sessionStorage.getItem(gateKey)) {
    // The rules gate must render BEFORE the exam starts: the first question's
    // clock begins the moment the server is asked for the exam, so the gate
    // reads the non-mutating assessments list (status, role and question count)
    // instead of GETting the assessment. The candidate reads and acknowledges
    // the rules on their own time — nothing ticks until they press enter.
    const list = await api('/candidate/assessments');
    const a = (list.assessments || []).find((x) => x.id === id);
    if (a && a.status === 'submitted') { renderSubmitted(view); return; }
    if (a && ['scored', 'validated'].includes(a.status)) { location.hash = `#/assessments/${id}/report`; return; }
    if (!a) {
      document.body.classList.remove('exam-lock');
      view.innerHTML = emptyState('Assessment not found', 'Ask your administrator to allocate an assessment for you.');
      return;
    }
    renderExamGate(view, {
      assessment: { role: { name: a.role_name || 'this role' } },
      exam: { total: a.question_count || 0 },
    }, () => {
      sessionStorage.setItem(gateKey, '1');
      quizView(view, { id });
    });
    return;
  }

  // Rules acknowledged: this GET is the moment the exam — and its first
  // question's clock — actually starts. It carries a deadline so a server that
  // never answers ends on the router's error page (with a retry) instead of a
  // "Loading workspace" spinner that never resolves.
  const d = await api(`/candidate/assessments/${id}`, { timeoutMs: EXAM_REQUEST_TIMEOUT_MS });

  if (d.assessment.status === 'submitted') { renderSubmitted(view); return; }
  if (['scored', 'validated'].includes(d.assessment.status)) { location.hash = `#/assessments/${id}/report`; return; }

  // An exam whose cursor is already complete (the last lock landed, then the
  // tab died) finalises here — the same handover panel and retry screen as the
  // in-exam path.
  if (d.exam?.complete) {
    await finalizeExam(id);
    return;
  }

  await runExamSession(view, id, d);
}

function renderExamGate(view, d, onStart) {
  document.body.classList.add('exam-lock');
  const total = d.exam?.total || 0;
  view.innerHTML = `
    <div class="exam-hall">
      <div class="exam-seal card">
        <h1>Assessment rules</h1>
        <p class="muted">You are about to start a timed, proctored-style assessment for <b>${esc(d.assessment.role?.name || 'this role')}</b>. ${total} question${total === 1 ? '' : 's'} will be presented one at a time. You cannot return to a question once it has passed.</p>
        <ul class="exam-rules">
          <li><b>One question at a time.</b> Navigation back is disabled. Leaving a question locks it.</li>
          <li><b>Multiple-choice &amp; scale:</b> 30 seconds to answer. Multi-select items score only on an exact match — any incorrect choice scores the question at zero, with no partial credit.</li>
          <li><b>Open / scenario:</b> 60 seconds to review the scenario, then 2 minutes to <b>record your answer with the microphone</b>. Every open question is answered out loud; the text box beside the recorder is optional space for supporting notes. Speech is transcribed when the browser allows it.</li>
          <li><b>Microphone.</b> An open question cannot be locked without a recording, so allow the browser's microphone prompt. Granting access on the review screen keeps the dialog from eating your answer time.</li>
          <li><b>Integrity.</b> Copying the question is blocked. Switching tabs, pasting, or leaving fullscreen is logged.</li>
          <li><b>Time expiry</b> auto-submits the current item (blank if unanswered) and advances.</li>
        </ul>
        <label class="check exam-ack"><input type="checkbox" id="exam-ack"/> <span>I understand these conditions and will complete the exam independently.</span></label>
        <div class="row" style="margin-top:18px">
          <button class="btn" id="exam-enter" disabled>Enter exam hall →</button>
        </div>
      </div>
    </div>`;
  const ack = view.querySelector('#exam-ack');
  const btn = view.querySelector('#exam-enter');
  ack.onchange = () => { btn.disabled = !ack.checked; };
  btn.onclick = async () => {
    try { await document.documentElement.requestFullscreen?.(); } catch { /* optional */ }
    onStart();
  };
}

/**
 * Deadline for the exam's own round trips (the paper fetch, a lock, a phase
 * change). Generous enough for a two-minute recording to upload over a slow
 * link, short enough that a stalled connection — or a serverless invocation
 * the platform killed mid-write — cannot leave the candidate on a disabled
 * button or a spinner with no way forward. Every one of these calls has a
 * local recovery path (re-armed button, refetch, retry screen); without a
 * deadline none of them is ever reached.
 */
const EXAM_REQUEST_TIMEOUT_MS = 20_000;

async function runExamSession(view, id, payload) {
  document.body.classList.add('exam-lock');
  let d = payload;
  // The server is the authority on the clock: `remaining_ms` is computed from
  // `question_started_at` and the budget for the current question and phase
  // (30s MCQ / 60s review / 2min answer), and the gate entry above re-fetches a
  // fresh value right before this runs. Overriding it here re-granted a full
  // 30s budget to every question — open questions included — and masked the
  // server's "urgent / expired" state, so the countdown never went red and the
  // auto-advance never fired. `paint()` re-bases the deadline to `Date.now()`,
  // so the candidate still receives the full remaining budget from the moment
  // the question is painted.
  let currentAnswer = d.current_answer;
  let ticking = null;
  let advancing = false;
  let finished = false;
  // The painted question's deadline and the clock starter for that paint, so
  // a failed lock can put the countdown back (see resumeClock).
  let deadlineAt = 0;
  let restartClock = null;
  // Released whenever the exam view is torn down or repainted, so a recording
  // never outlives the question it belongs to (the browser tab keeps showing
  // the "microphone in use" indicator otherwise).
  let stopLiveCapture = null;
  let pageHideLogged = false;
  const tabId = `${id}-${Math.random().toString(36).slice(2, 9)}`;
  const cleanup = [];
  // Set once the session has released everything it pinned. A late timer or
  // an in-flight round trip that resolves afterwards must not paint the exam
  // over whatever view owns #view now (the sign-in form after a 401, the
  // journey page after Back).
  let unmounted = false;
  const teardown = () => {
    unmounted = true;
    const fns = cleanup.splice(0);
    fns.forEach((fn) => { try { fn(); } catch { /* releasing */ } });
  };
  const lastIntegrityAt = new Map();

  const typeLabel = (t) => (state.meta.questionTypes.find((x) => x.key === t) || {}).label || t;

  const logIntegrity = (event, detail = '', { force = false, keepalive = false } = {}) => {
    const now = Date.now();
    const last = lastIntegrityAt.get(event) || 0;
    if (!force && now - last < 1200) return; // throttle routine blur/resize noise
    lastIntegrityAt.set(event, now);
    const body = { event, detail: String(detail || '').slice(0, 500) };
    if (keepalive) {
      try {
        fetch(`/api/candidate/assessments/${id}/integrity`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.token || ''}`,
          },
          body: JSON.stringify(body),
          keepalive: true,
          credentials: 'same-origin',
        });
      } catch { /* page is leaving */ }
      return;
    }
    attempt(() => api(`/candidate/assessments/${id}/integrity`, { method: 'POST', body }));
  };

  if (Number(d.exam?.index || 0) <= 0 && !sessionStorage.getItem(`ecod.exam.started.${id}`)) {
    sessionStorage.setItem(`ecod.exam.started.${id}`, '1');
    logIntegrity('exam_start', 'Candidate entered the secure exam', { force: true });
  } else if (Number(d.exam?.index || 0) > 0) {
    const resumed = sessionStorage.getItem(`ecod.exam.left.${id}`) ? 'after leaving' : 'after refresh';
    sessionStorage.removeItem(`ecod.exam.left.${id}`);
    logIntegrity('exam_reopen', `Exam resumed ${resumed} at question ${d.exam.index + 1}`, { force: true });
  }

  const onCopy = (e) => {
    const t = e.target;
    const insideField = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
    e.preventDefault();
    logIntegrity(insideField ? 'copy_attempt' : 'copy', insideField ? 'Copy attempted inside an answer field' : 'Copying exam content is not permitted.');
    toast('Copying exam content is not permitted.', 'error', 2200);
  };
  const onCut = (e) => {
    const t = e.target;
    e.preventDefault();
    logIntegrity('cut_attempt', t && t.tagName === 'TEXTAREA' ? 'Cut attempted in the answer field' : 'Cutting exam content is not permitted.');
    toast('Copying exam content is not permitted.', 'error', 2200);
  };
  const onPaste = (e) => {
    const t = e.target;
    e.preventDefault();
    logIntegrity('paste_attempt', t && t.tagName === 'TEXTAREA' ? 'Paste attempted in the answer field' : 'Paste attempted');
    toast('Pasting into the secure exam is not permitted.', 'error', 2200);
  };
  const onContext = (e) => {
    e.preventDefault();
    logIntegrity('contextmenu', 'Right-click / context menu blocked');
  };
  const originalWindowOpen = window.open;
  const onWindowOpen = (...args) => {
    logIntegrity('multi_window', 'window.open() called; multi-window attempts are flagged', { force: true });
    toast('Opening another window during the exam is not permitted.', 'error', 2600);
    return null;
  };
  const onResize = () => {
    const gapX = window.outerWidth - (window.innerWidth || document.documentElement.clientWidth || 0);
    const gapY = window.outerHeight - (window.innerHeight || document.documentElement.clientHeight || 0);
    if (gapX > 160 || gapY > 160) {
      logIntegrity('devtools_resize', `DevTools-sized viewport change detected (outer-inner ${Math.max(gapX, 0)}x${Math.max(gapY, 0)})`);
    }
  };
  const onSelectStart = (e) => {
    if (e.target?.closest?.('textarea, input, .exam-answer')) return;
    e.preventDefault();
  };
  const onKey = (e) => {
    const combo = (e.ctrlKey || e.metaKey);
    const inField = e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT';
    if (e.key === 'F12') {
      e.preventDefault();
      logIntegrity('devtools_key', 'F12 (browser developer tools) blocked', { force: true });
      return;
    }
    if (combo && e.shiftKey && ['I', 'J', 'C'].includes(e.key?.toUpperCase?.())) {
      e.preventDefault();
      logIntegrity('devtools_key', `Developer tools shortcut blocked (Ctrl+Shift+${e.key})`, { force: true });
      return;
    }
    if (combo && ['u', 'U'].includes(e.key)) {
      e.preventDefault();
      logIntegrity('devtools_key', 'View-source shortcut blocked (Ctrl+U)', { force: true });
      return;
    }
    if (combo && ['c', 'C', 'x', 'X'].includes(e.key)) {
      e.preventDefault();
      logIntegrity(e.key.toLowerCase() === 'c' ? 'copy_attempt' : 'cut_attempt', inField ? 'Clipboard shortcut attempted in an answer field' : 'Copy/cut shortcut blocked');
      return;
    }
    if (combo && ['v', 'V'].includes(e.key)) {
      e.preventDefault();
      logIntegrity('paste_attempt', 'Clipboard paste shortcut blocked');
      return;
    }
    if (combo && ['a', 'A'].includes(e.key)) {
      e.preventDefault();
      logIntegrity('select_all', 'Select-all shortcut blocked');
      return;
    }
    if (e.key === 'PrintScreen') {
      e.preventDefault?.();
      logIntegrity('screenshot', 'PrintScreen / screenshot key pressed', { force: true });
    }
  };
  const onVis = () => {
    if (document.hidden) {
      logIntegrity('tab_switch', 'Browser tab switched / window hidden', { force: true });
      toast('Tab switch recorded. Stay in the exam window.', 'error', 2800);
    } else {
      logIntegrity('tab_return', 'Browser tab / window became visible again');
    }
  };
  const onBlur = () => {
    if (document.hidden) return;
    logIntegrity('window_blur', 'Exam window lost focus');
  };
  const onFs = () => {
    if (!document.fullscreenElement) logIntegrity('fullscreen_exit', 'Fullscreen was exited during the exam');
  };
  const onPageHide = (e) => {
    if (finished || pageHideLogged) return;
    pageHideLogged = true;
    sessionStorage.setItem(`ecod.exam.left.${id}`, '1');
    const detail = e?.persisted ? 'Browser page restored from cache / bfcache' : 'Browser tab closed, reloaded, or navigated away';
    logIntegrity('browser_close', detail, { force: true, keepalive: true });
  };
  const onRouteChange = () => {
    if (finished) return;
    if (!location.hash.includes(`/assessments/${id}/quiz`)) {
      sessionStorage.setItem(`ecod.exam.left.${id}`, '1');
      logIntegrity('exam_exit', 'Left the secure exam window', { force: true });
    }
  };
  const onStorage = (e) => {
    if (e.key !== 'ecod.exam.tab' || !e.newValue) return;
    let other = null;
    try { other = JSON.parse(e.newValue); } catch { return; }
    if (other?.assessment_id !== id || other?.tab_id === tabId) return;
    logIntegrity('multi_window', 'Another tab or window is running the same exam', { force: true });
    toast('Another exam window was detected. This action is logged.', 'error', 3200);
  };

  try {
    localStorage.setItem('ecod.exam.tab', JSON.stringify({ tab_id: tabId, assessment_id: id, at: Date.now() }));
  } catch { /* storage unavailable */ }
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('cut', onCut, true);
  document.addEventListener('paste', onPaste, true);
  document.addEventListener('contextmenu', onContext, true);
  document.addEventListener('selectstart', onSelectStart, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  document.addEventListener('fullscreenchange', onFs);
  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('storage', onStorage);
  window.open = onWindowOpen;
  /**
   * The app is about to hand #view to another view. Everything above is
   * document- or window-level, so it survives the swap unless released here:
   * a session drop mid-exam (the 401 handler mounts the sign-in form) left
   * the login screen with paste, right-click, text selection and Ctrl+V
   * blocked — "Pasting into the secure exam is not permitted" over the
   * password field — and every attempt fired a token-less integrity beacon;
   * Back to the journey page kept the same blockers there, and Forward
   * mounted a second session on top of the first, so one copy attempt was
   * logged twice and two clocks raced the same lock. The route-change log
   * runs first: the swap fires before the exam's own hashchange listener
   * would, and leaving the hall is still an integrity event.
   */
  const onUnmount = () => { onRouteChange(); teardown(); };
  document.addEventListener(VIEW_UNMOUNT_EVENT, onUnmount);
  cleanup.push(() => {
    document.removeEventListener(VIEW_UNMOUNT_EVENT, onUnmount);
    document.removeEventListener('copy', onCopy, true);
    document.removeEventListener('cut', onCut, true);
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('contextmenu', onContext, true);
    document.removeEventListener('selectstart', onSelectStart, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('fullscreenchange', onFs);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('hashchange', onRouteChange);
    window.removeEventListener('storage', onStorage);
    window.open = originalWindowOpen;
    try {
      const current = JSON.parse(localStorage.getItem('ecod.exam.tab') || 'null');
      if (current?.tab_id === tabId) localStorage.removeItem('ecod.exam.tab');
    } catch { /* ignore */ }
    stopLiveCapture?.();
    document.body.classList.remove('exam-lock');
    if (ticking) clearInterval(ticking);
  });

  const stillHere = () => !unmounted && location.hash.includes(`/assessments/${id}/quiz`);

  /* ------------------------------ draft autosave ------------------------------ */
  /**
   * Every change to the answer on screen goes to the API as a draft
   * (`PUT …/answers`) while the question's clock runs: a short debounce for a
   * choice, a longer one for typed notes, at once when a recording stops. The
   * lock (`/next`) is still the answer; the draft is the safety net the
   * server already honours — a lock that lands after the window (the request
   * timed out on a cold function, got a 503, or the connection dropped, and
   * the retry came late) locks the draft saved in time instead of a blank.
   * The exam hall never sent one before, so a lost lock near the end of a
   * 30-second MCQ window cost the candidate the answer AND flagged them for
   * it. A failed save is silent (it is a net, not the answer): the next change,
   * or the flush that rides with the lock, re-sends whatever was not
   * acknowledged. A recording is uploaded once — after the server has taken
   * it, later drafts (and the lock) carry `audio_keep` instead of the clip.
   */
  const DRAFT_DELAY_MS = { choice: 400, text: 1500, now: 0 };
  // How long a lock may be in flight before its answer also goes out as a
  // draft (see advance()).
  const DRAFT_NET_DELAY_MS = 1500;
  // `sentJson` is the last value the server has seen (taken or ignored — an
  // ignored draft is not re-sent on its own, only a changed one); `savedClip`
  // is the recording the server has taken for this question.
  const draft = { qid: null, timer: null, latest: undefined, sentJson: '', inflight: null, savedClip: '' };
  const draftJson = (v) => { try { return JSON.stringify(v) ?? ''; } catch { return String(v); } };
  const clearDraftTimer = () => { if (draft.timer) { clearTimeout(draft.timer); draft.timer = null; } };
  function resetDraft(qid) {
    clearDraftTimer();
    Object.assign(draft, { qid, latest: undefined, sentJson: '', savedClip: '' });
  }
  function sendDraft(qid, value) {
    if (unmounted || finished || draft.inflight) return;
    const json = draftJson(value);
    draft.inflight = api(`/candidate/assessments/${id}/answers`, {
      method: 'PUT', body: { answers: { [qid]: value } }, timeoutMs: EXAM_REQUEST_TIMEOUT_MS,
    }).then((out) => {
      draft.sentJson = json;
      const accepted = Array.isArray(out?.accepted_question_ids) && out.accepted_question_ids.includes(qid);
      if (accepted && value && typeof value === 'object' && value.audio_b64) draft.savedClip = value.audio_b64;
    }, () => { /* the next change, or the lock's flush, re-sends it */ }).then(() => {
      draft.inflight = null;
      // A change made while this save was in flight goes out now — after a
      // success only, so an unreachable server is not hammered.
      if (draft.sentJson === json && draft.qid === qid && !draft.timer
        && draft.latest !== undefined && draftJson(draft.latest) !== json) sendDraft(qid, draft.latest);
    });
  }
  function queueDraft(qid, value, delayMs) {
    if (unmounted || finished) return;
    if (draft.qid !== qid) resetDraft(qid);
    draft.latest = value;
    clearDraftTimer();
    if (draftJson(value) === draft.sentJson) return; // the server already has this one
    draft.timer = setTimeout(() => { draft.timer = null; sendDraft(qid, draft.latest); }, delayMs);
  }
  /** Sends the value the server has not seen yet, if there is one, right now. */
  function flushDraft() {
    clearDraftTimer();
    if (draft.qid && draft.latest !== undefined && draftJson(draft.latest) !== draft.sentJson) sendDraft(draft.qid, draft.latest);
  }
  cleanup.push(clearDraftTimer);

  /**
   * After a failed lock the question is still live and its server-side clock
   * never stopped. The countdown used to be cleared for the lock and never
   * restarted, so it froze at the moment of the press and the candidate had
   * no idea the window was closing under them. Put it back; and once the
   * window is over, keep re-sending the lock on a backoff instead of leaving
   * a dead button — the server locks the draft saved in time (or the blank)
   * and the paper moves on.
   */
  const LOCK_RETRY_MS = 4000;
  function resumeClock(btn) {
    if (unmounted || finished) return;
    if (Date.now() < deadlineAt) { restartClock?.(); return; }
    if (btn) btn.dataset.force = '1';
    ticking = setTimeout(() => {
      ticking = null;
      if (unmounted || finished || advancing) return;
      const b = view.querySelector('#exam-next');
      if (b) { b.dataset.force = '1'; b.disabled = false; b.click(); }
    }, LOCK_RETRY_MS);
  }

  async function advance(answer) {
    if (advancing) return;
    advancing = true;
    if (ticking) { clearInterval(ticking); ticking = null; }
    // Whatever the lock carries also goes out as an in-time draft if the
    // server has not acknowledged one yet: should the lock itself be lost,
    // the late retry locks this draft rather than a blank. It used to be
    // fired together with the lock — and the server serialises both behind
    // the same per-assessment lock, so on a remote store the draft's own
    // storage round trips ran *ahead* of the lock and made every "Lock &
    // continue" a second slower. A lock that answers promptly needs no net;
    // one that is still out after this delay (cold function, flaky link) is
    // exactly the case the net exists for, and the draft is still in time.
    const net = setTimeout(flushDraft, DRAFT_NET_DELAY_MS);
    const btn = view.querySelector('#exam-next');
    // Show what the click is doing (the button used to look inert while the
    // lock was in flight) but keep the question on screen: if the lock fails,
    // everything the candidate typed or recorded is still in this tab and one
    // press re-sends it. The end-of-exam handover panel is rendered only once
    // the server has actually taken the final lock, so a timeout there lands
    // back on the question rather than on a spinner with nothing behind it.
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Locking…'; }
    const sendLock = () => api(`/candidate/assessments/${id}/next`, {
      method: 'POST',
      // The question this advance answers: if a retried/duplicated request
      // arrives after the cursor moved on, the server no-ops it instead of
      // skipping the live question (see the /next idempotency guard).
      body: { answer: answer === undefined ? null : answer, question_id: d?.current_question?.id },
      timeoutMs: EXAM_REQUEST_TIMEOUT_MS,
    });
    const out = await attempt(async () => {
      try { return await sendLock(); }
      catch (err) {
        // Older function instances can still see the draft/lock insert race
        // during a rolling deploy. Retry that specific 409 once, silently:
        // the same question_id is idempotent and a refresh would burn exam
        // time. Other conflicts (submitted/scored, invalid input) are real.
        if (!unmounted && err?.status === 409 && /record was created by another request/i.test(err.message || ''))
          return sendLock();
        throw err;
      }
    });
    clearTimeout(net);
    if (unmounted) return; // the view was swapped while the lock was in flight
    if (!out) {
      // The lock failed (fast or slow): the answer goes out as a draft now so
      // the eventual retry — possibly after the window — locks it, not a blank.
      flushDraft();
      // Offline, timed out or 5xx: re-arm the button and let them send it
      // again (a lock that actually committed self-heals — the retry /next
      // returns complete again via the idempotency guard, and a stale
      // question_id is a no-op). The clock keeps running meanwhile.
      advancing = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
      resumeClock(btn);
      return;
    }
    if (out.complete) {
      // The paper is locked. Everything from here on — the submit POST and the
      // journey reload — happens behind the handover panel.
      finished = true;
      teardown();
      renderSubmitHandover(view);
      await finalizeExam(id);
      return;
    }
    try {
      // A successful advance carries the next screen; only an older server
      // (or a no-op duplicate) makes the browser fetch it separately.
      d = out.screen || await api(`/candidate/assessments/${id}`, { timeoutMs: EXAM_REQUEST_TIMEOUT_MS });
    } catch {
      if (unmounted) return;
      // The advance landed but the next question did not load. Keep the
      // candidate where they are — the retry press no-ops the stale question
      // and this fetch then paints the live question.
      toast('Could not load the next question. Check your connection and press the button again.', 'error', 4200);
      advancing = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
      return;
    }
    currentAnswer = d.current_answer;
    advancing = false;
    paint();
  }

  function fmtMs(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${s}s`;
  }

  /**
   * A window's length for the chips ("60s", "2 min", "1 min 30s"), read from
   * the server's per-question `budgets` so the hall never advertises a
   * different budget than the one the clock is actually running — the chips
   * used to hard-code 60s / 2 min / 30s regardless of what the API served.
   */
  function fmtWindow(ms, fallback) {
    const total = Number(ms);
    if (!Number.isFinite(total) || total <= 0) return fallback;
    const s = Math.round(total / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r}s` : `${m} min`;
  }

  function fmtStopwatch(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function paint() {
    if (!stillHere()) { teardown(); return; }
    const q = d.current_question;
    const exam = d.exam;
    if (!q || exam.complete) {
      finished = true;
      teardown();
      finalizeExam(id);
      return;
    }
    const phase = exam.phase || 'answer';
    const open = q.type === 'text';
    // The microphone is mandatory for every open question — the projection
    // derives `audio_required` from the open-question contract
    // (src/core/spoken-answer.mjs) — and any other type an author explicitly
    // flagged is answered the same way. `micCapable` is the browser check: a
    // browser that cannot capture audio at all never hard-locks a candidate.
    const needsMic = open || q.audio_required === true;
    const micCapable = micCapability(window).canRecord;
    const n = exam.index + 1;
    const pctFill = exam.total ? Math.round((exam.index / exam.total) * 100) : 0;
    const deadline = Date.now() + (exam.remaining_ms || 0);
    deadlineAt = deadline;
    // A fresh question (or a repaint of this one) starts with nothing to save;
    // `currentAnswer` below is whatever draft the server already holds.
    resetDraft(q.id);

    view.innerHTML = `
      <div class="exam-hall">
        <div class="exam-chrome card">
          <div class="exam-brand">
            <span class="exam-lock-pip"></span>
            <div>
              <div class="section-kicker">Secure exam in progress</div>
              <h2>${esc(d.assessment.role?.name || 'Assessment')}</h2>
            </div>
          </div>
          <div class="exam-meter">
            <div class="quiz-progress-label"><span>Question <b>${n}</b> of ${exam.total}</span></div>
            <div class="quiz-track"><span style="width:${pctFill}%"></span></div>
          </div>
          <div class="exam-clock ${exam.remaining_ms < 8000 ? 'urgent' : ''}" id="exam-clock" role="timer" aria-label="Time remaining">
            <span class="exam-clock-label">Time left</span>
            <strong class="exam-timer" id="exam-timer">${fmtMs(exam.remaining_ms)}</strong>
          </div>
        </div>
        ${d.competency ? `<div class="exam-comp">${esc(d.competency.name)}</div>` : ''}
        <div class="q-card exam-item" data-q="${esc(q.id)}">
          <div class="q-head">
            <span class="q-num">${n}</span>
            <div>
              <div class="q-prompt exam-prompt">${esc(q.prompt)}</div>
              ${q.help_text ? `<div class="small muted" style="margin-top:6px">${esc(q.help_text)}</div>` : ''}
              <div class="small muted" style="margin-top:8px">
                <span class="chip">${esc(typeLabel(q.type))}</span>
                <span class="chip">${esc(q.difficulty)}</span>
                <span class="chip">${esc(q.points)} pts</span>
                ${open ? `<span class="chip">${phase === 'review' ? `Review window · ${fmtWindow(exam.budgets?.review_ms, '60s')}` : `Recording window · ${fmtWindow(exam.budgets?.answer_ms, '2 min')}`}</span><span class="chip chip-mic">🎙 Recorded answer required</span>` : `<span class="chip">${fmtWindow(exam.budgets?.answer_ms, '30s')}</span>`}
              </div>
            </div>
          </div>
          <div class="exam-body" id="exam-body"></div>
        </div>
        <div class="exam-actions row between">
          <span class="small muted">Answers lock when time expires. You cannot return.</span>
          <button class="btn" id="exam-next">${open && phase === 'review' ? 'Start answering →' : (n >= exam.total ? 'Lock & submit' : 'Lock & continue →')}</button>
        </div>
      </div>`;

    const body = view.querySelector('#exam-body');
    const nextBtn = view.querySelector('#exam-next');
    // Extra work the 250 ms exam ticker performs for the current answer screen
    // (recording clock + unlock), set by the open-question branch below.
    let onTick = null;
    let rec = { stream: null, recorder: null, chunks: [], recognition: null, startedAt: 0 };
    // Live "recording for 0:42" readout, driven by the exam's existing 250 ms
    // ticker, so the candidate can see how long they have been speaking.
    const recElapsed = () => (rec.startedAt ? fmtStopwatch(Date.now() - rec.startedAt) : '');

    if (open && phase === 'review') {
      body.innerHTML = `<div class="exam-review">
        <p>Read the scenario carefully. When this review window ends you have 2 minutes to <b>record your spoken answer</b> — the microphone is required. The text box on the answer screen is optional space for supporting notes.</p>
        <div class="mic-check-row">
          <button type="button" class="btn secondary sm" id="mic-check" ${micCapable ? '' : 'disabled'}>Check microphone access</button>
          <span class="small muted" id="mic-check-state">${micCapable
            ? 'Allow the browser prompt now so no dialog interrupts your 2-minute answer window.'
            : 'This browser cannot capture audio (no microphone support). Tell your administrator — a typed answer will be accepted and flagged for the assessor.'}</span>
        </div>
      </div>`;
      const micCheck = body.querySelector('#mic-check');
      const micCheckState = body.querySelector('#mic-check-state');
      if (micCheck) {
        micCheck.onclick = async () => {
          micCheck.disabled = true;
          micCheckState.textContent = 'Waiting for the browser permission prompt…';
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            micCheckState.textContent = '✓ Microphone ready. Recording will now start without a prompt.';
            micCheckState.classList.add('ok');
          } catch {
            micCheckState.textContent = 'Microphone blocked — open the browser’s site permissions, allow the microphone, then check again.';
            micCheckState.classList.add('warn');
          } finally {
            micCheck.disabled = false;
            micCheck.textContent = 'Check again';
          }
        };
      }
      nextBtn.onclick = async () => {
        // A double-click (or a click racing the expired-review auto-advance)
        // 409s on the second transition; that is benign — the server state
        // wins via the refetch — so only a failed refetch is worth a toast.
        nextBtn.disabled = true;
        const switched = await api(`/candidate/assessments/${id}/phase`, {
          method: 'POST', body: { phase: 'answer' }, timeoutMs: EXAM_REQUEST_TIMEOUT_MS,
        }).catch(() => null);
        try {
          // The transition carries the answer screen; a refetch is only for
          // the benign 409 / an older server.
          d = switched?.screen || await api(`/candidate/assessments/${id}`, { timeoutMs: EXAM_REQUEST_TIMEOUT_MS });
          currentAnswer = d.current_answer;
        } catch {
          toast('Could not reach the server — your place is saved; try again.', 'error');
          nextBtn.disabled = false;
          return;
        }
        paint();
      };
    } else if (q.type === 'mcq_single' || q.type === 'mcq_multi') {
      const multi = q.type === 'mcq_multi';
      let val = multi
        ? (Array.isArray(currentAnswer) ? [...currentAnswer] : (currentAnswer ? [String(currentAnswer)] : []))
        : (typeof currentAnswer === 'string' ? currentAnswer : null);
      body.innerHTML = ((q.options || []).map((o) => {
        const selected = multi ? val.includes(o.id) : val === o.id;
        return `<label class="opt ${selected ? 'selected' : ''}">
          <input type="${multi ? 'checkbox' : 'radio'}" name="q-cur" value="${esc(o.id)}" ${selected ? 'checked' : ''}/>
          <span>${esc(o.label)}</span></label>`;
      }).join('') || '<div class="muted small">No options configured.</div>')
        + (multi
          ? '<div class="small muted" style="margin-top:8px">Select every correct option. Any incorrect choice scores this question at zero — there is no partial credit.</div>'
          : '');
      body.querySelectorAll('input').forEach((inp) => {
        inp.onchange = () => {
          if (multi) val = [...body.querySelectorAll('input:checked')].map((x) => x.value);
          else val = inp.value;
          body.querySelectorAll('.opt').forEach((o) => o.classList.toggle('selected', o.querySelector('input').checked));
          currentAnswer = val;
          queueDraft(q.id, val, DRAFT_DELAY_MS.choice);
        };
      });
      nextBtn.onclick = () => advance(val);
    } else if (q.type === 'scale') {
      let val = Number(currentAnswer) || null;
      body.innerHTML = `<div class="scale-row">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-v="${i}" class="${val >= i && val ? 'selected' : ''}">${i}</button>`).join('')}</div>
        <div class="small muted" style="margin-top:6px">1 = no exposure yet · 5 = deep hands-on expertise</div>`;
      body.querySelectorAll('button').forEach((b) => {
        b.onclick = (e) => {
          e.preventDefault();
          val = Number(b.dataset.v);
          currentAnswer = val;
          body.querySelectorAll('button').forEach((x) => x.classList.toggle('selected', Number(x.dataset.v) <= val));
          queueDraft(q.id, val, DRAFT_DELAY_MS.choice);
        };
      });
      nextBtn.onclick = () => advance(val);
    } else {
      // Open / scenario answer: the recording IS the answer, the text box is
      // optional supporting notes. The lock button stays disabled until the
      // candidate has actually spoken (recorded audio or a live transcript), so
      // the requirement is enforced before the answer reaches the API.
      const existing = currentAnswer && typeof currentAnswer === 'object' ? currentAnswer : { text: currentAnswer || '', transcript: '' };
      let text = existing.text || '';
      let transcript = existing.transcript || '';
      // The notes box maxlength must stay equal to MAX_ANSWER_TEXT on the server
      // (src/core/constants.mjs): the API refuses an oversized draft/lock, so the
      // browser caps typing at the same limit and a candidate can never compose
      // an answer the lock would then reject. tests/exam-mic-ui.test.mjs pins it.
      body.innerHTML = `
        <div class="exam-answer${needsMic ? ' has-audio' : ''}">
          <textarea id="exam-ta" rows="8" maxlength="20000" placeholder="${needsMic ? 'Optional notes — the recording below is your answer' : 'Type your answer here'}">${esc(text)}</textarea>
          ${needsMic ? `
          <div class="exam-audio-side">
            <button type="button" class="btn rec-btn" id="rec-btn" aria-pressed="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"></path></svg>
              <span id="rec-label">Record answer</span>
            </button>
            <span class="small rec-timer" id="rec-timer" hidden>0:00</span>
            <span class="small muted rec-state" id="rec-state" role="status">Required · press record and speak your answer</span>
          </div>` : ''}
          ${needsMic && !micCapable ? `<div class="small exam-mic-note warn">This browser cannot capture microphone audio, so a recording cannot be required here. Type your answer instead — it is stored and flagged for the assessor as “no recording”.</div>` : ''}
          <div class="small muted transcript-block" id="transcript-preview" ${transcript ? '' : 'hidden'}></div>
        </div>`;
      const ta = body.querySelector('#exam-ta');
      // The answer as it stands, for a draft or the lock. The clip travels
      // once: after the server has taken it (an acknowledged draft, or the
      // recording restored with this question after a reload) the answer says
      // `audio_keep` instead of carrying it again.
      const clipKept = () => (rec.audioB64 ? draft.savedClip === rec.audioB64 : Boolean(rec.keptRef));
      const currentOpenAnswer = () => {
        const kept = clipKept();
        return buildTextAnswer({
          text: ta.value || text,
          transcript,
          audioB64: kept ? '' : rec.audioB64,
          audioMime: rec.audioMime,
          audioKept: kept,
        });
      };
      ta.oninput = () => { text = ta.value; syncNext(); queueDraft(q.id, currentOpenAnswer(), DRAFT_DELAY_MS.text); };
      // No paste handler of its own: the session's document-level listener
      // blocks the paste and logs it once as `paste_attempt`. A second
      // `paste` beacon from here used to count each blocked paste twice.
      const recBtn = body.querySelector('#rec-btn');
      const recLabel = body.querySelector('#rec-label');
      const recState = body.querySelector('#rec-state');
      const recTimer = body.querySelector('#rec-timer');
      const preview = body.querySelector('#transcript-preview');
      if (transcript) { preview.hidden = false; preview.textContent = `Transcript: ${transcript}`; }
      const hasAnswer = () => Boolean((ta?.value || text).trim() || transcript.trim() || rec.audioB64 || rec.keptRef);
      // Spoken evidence = a stored recording or a transcript. Either alone is
      // enough: Safari/Firefox have no speech recognition, and a clip can be
      // dropped for size, so both paths count as "answered out loud". While the
      // recorder is live the answer also counts — browsers only flush chunks on
      // stop(), and "Lock & continue" stops the recording first, so the button
      // must not deadlock a candidate mid-sentence.
      const hasSpoken = () => Boolean(rec.audioB64 || rec.keptRef || transcript.trim()
        || (rec.startedAt && Date.now() - rec.startedAt >= 400));
      const enforceMic = needsMic && micCapable;
      const hasEnough = () => (enforceMic ? hasSpoken() : hasAnswer());
      const setRecState = (message, tone = 'muted') => {
        if (!recState) return;
        recState.textContent = message;
        recState.classList.toggle('muted', tone === 'muted');
        recState.classList.toggle('ok', tone === 'ok');
        recState.classList.toggle('warn', tone === 'warn');
      };
      const syncNext = () => {
        nextBtn.disabled = !hasEnough();
        nextBtn.title = nextBtn.disabled
          ? (enforceMic ? 'Record your spoken answer to continue — typed notes alone are not an answer' : 'Add an answer before continuing')
          : '';
      };
      if (existing.audio_b64) rec.audioB64 = existing.audio_b64;
      if (existing.audio_mime) rec.audioMime = existing.audio_mime;
      // A recording the server already holds for this question (the draft
      // autosaved before a reload) counts as the spoken answer; the lock
      // keeps it rather than asking the candidate to record again.
      if (!existing.audio_b64 && existing.audio_ref) rec.keptRef = true;
      if (existing.audio_b64 || rec.keptRef) setRecState('Recorded answer restored · you can continue', 'ok');
      else if (existing.transcript) setRecState('Spoken answer captured · you can continue', 'ok');
      syncNext();

      const SpeechRec = needsMic ? speechRecognitionCtor(window) : null;
      const releaseMic = () => {
        rec.stream?.getTracks().forEach((t) => t.stop());
        rec.stream = null;
        rec.startedAt = 0;
        if (recTimer) recTimer.hidden = true;
      };
      stopLiveCapture = releaseMic;
      onTick = () => {
        if (recTimer && !recTimer.hidden) recTimer.textContent = recElapsed();
        if (rec.startedAt) syncNext();
      };
      const stopCapture = async () => {
        try { rec.recognition?.stop(); } catch { /* */ }
        rec.recognition = null;
        if (rec.recorder && rec.recorder.state !== 'inactive') {
          await new Promise((resolve) => {
            rec.recorder.onstop = () => resolve();
            try { rec.recorder.stop(); } catch { resolve(); }
            setTimeout(resolve, 800);
          });
        }
        rec.recorder = null;
        releaseMic();
        if (rec.chunks?.length) {
          const blob = new Blob(rec.chunks, { type: rec.mime || 'audio/webm' });
          const stored = await blobToStoredAudio(blob, rec.mime || 'audio/webm');
          rec.audioB64 = stored.audioB64;
          rec.audioMime = stored.audioMime;
          rec.chunks = [];
          if (stored.dropped) {
            setRecState('That recording was too large to store — record a shorter answer or add your notes in the text box.', 'warn');
            toast('The recording exceeded the storage limit and was not saved.', 'error', 4200);
          }
        }
      };

      if (needsMic && recBtn && recLabel) {
        recBtn.onclick = async () => {
          if (rec.recognition || rec.recorder) {
            await stopCapture();
            recLabel.textContent = 'Record answer';
            recBtn.classList.remove('recording');
            recBtn.setAttribute('aria-pressed', 'false');
            setRecState(hasSpoken()
              ? 'Audio saved · you can continue'
              : 'Recording stopped with nothing captured — press record and speak again.', hasSpoken() ? 'ok' : 'warn');
            syncNext();
            // The clip is the answer: it goes to the server now, not only
            // with the lock, so a lock lost to a timeout cannot lose it.
            queueDraft(q.id, currentOpenAnswer(), DRAFT_DELAY_MS.now);
            return;
          }
          recLabel.textContent = 'Stop recording';
          recBtn.classList.add('recording');
          recBtn.setAttribute('aria-pressed', 'true');
          rec.chunks = [];
          rec.audioB64 = '';
          rec.audioMime = '';
          rec.keptRef = false; // a new recording replaces whatever the server holds
          // `startedAt` is only armed once the recorder is actually live: while
          // the browser permission prompt is open nothing is being captured, and
          // the unlock must not fire on that wait.
          if (recTimer) recTimer.hidden = true;
          setRecState('Waiting for microphone permission…', 'muted');
          if (SpeechRec) {
            const recg = new SpeechRec();
            recg.continuous = true;
            recg.interimResults = true;
            recg.lang = 'en-IN';
            recg.onresult = (ev) => {
              transcript = transcriptFromSpeechEvent(ev);
              preview.hidden = false;
              preview.textContent = `Transcript: ${transcript}`;
              // Speech must not silently edit the candidate's textarea. The
              // transcript is shown separately so the candidate can copy or
              // edit it deliberately.
              syncNext();
            };
            recg.onerror = () => { setRecState('Speech recognition unavailable — keep recording; your audio is stored.', 'muted'); };
            recg.start();
            rec.recognition = recg;
          } else {
            setRecState('Live transcription is not supported in this browser. Audio will still be stored.', 'muted');
          }
          try {
            rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            rec.chunks = [];
            const started = startAudioRecorder(window, rec.stream);
            rec.recorder = started.recorder;
            rec.mime = started.mime;
            rec.recorder.ondataavailable = (e) => { if (e.data?.size) rec.chunks.push(e.data); };
            rec.recorder.start();
            rec.startedAt = Date.now();
            if (recTimer) { recTimer.hidden = false; recTimer.textContent = '0:00'; }
            setRecState('Recording — speak clearly', 'ok');
            syncNext();
          } catch {
            try { rec.recognition?.stop(); } catch { /* */ }
            rec.recognition = null;
            releaseMic();
            rec.recorder = null;
            recBtn.classList.remove('recording');
            recBtn.setAttribute('aria-pressed', 'false');
            recLabel.textContent = 'Record answer';
            setRecState('Microphone blocked — allow microphone access for this site in your browser, then press record again.', 'warn');
            toast('The microphone is required for open questions. Allow microphone access and try again.', 'error', 4200);
            syncNext();
          }
        };
      }

      nextBtn.onclick = async () => {
        const timedOut = nextBtn.dataset.force === '1';
        await stopCapture();
        if (!hasEnough() && !timedOut) {
          syncNext();
          toast(enforceMic
            ? 'Record your spoken answer before continuing — typed notes are optional support, not the answer.'
            : 'Add an answer before continuing.', 'error', 2800);
          return;
        }
        if (timedOut && enforceMic && !hasSpoken()) {
          // The clock ran out with no recording: the typed notes are still
          // stored (throwing a candidate's work away helps nobody) but the
          // answer is flagged `audio_missing` server-side and lands in the
          // proctoring trail, so the assessor sees it instead of guessing.
          toast('Time expired with no recording — your notes were saved and flagged for the assessor.', 'error', 4200);
        }
        advance(currentOpenAnswer());
      };
    }

    const startClock = () => {
      if (ticking) clearInterval(ticking);
      ticking = setInterval(() => {
        const left = deadline - Date.now();
        const el = view.querySelector('#exam-timer');
        if (el) {
          el.textContent = fmtMs(left);
          const urgent = left < 8000;
          el.classList.toggle('urgent', urgent);
          el.closest?.('.exam-clock')?.classList.toggle('urgent', urgent);
        }
        if (onTick) onTick();
        if (left <= 0) {
          clearInterval(ticking);
          ticking = null;
          if (open && phase === 'review') {
            // Automatic, so failures stay silent: a 409 just means the candidate
            // clicked through first (or the server already advanced) — either
            // way the refetch repaints whatever the server says is current.
            api(`/candidate/assessments/${id}/phase`, { method: 'POST', body: { phase: 'answer' } })
              .catch(() => null)
              .then(async (switched) => {
                if (unmounted) return;
                try {
                  d = switched?.screen || await api(`/candidate/assessments/${id}`);
                  currentAnswer = d.current_answer;
                  paint();
                } catch {
                  // Offline or a transient failure: retry the handover in a few
                  // seconds rather than stranding the candidate on an expired
                  // review screen (or hammering a dead server every 250 ms).
                  ticking = setTimeout(() => { ticking = null; paint(); }, 3000);
                }
              });
            return;
          }
          nextBtn.dataset.force = '1';
          nextBtn.disabled = false;
          nextBtn.click();
        }
      }, 250);
    };
    restartClock = startClock;
    startClock();
  }

  paint();
}

/* ============================ Submit handover ============================ */

/**
 * Panels for the end-of-exam handover. The last lock, the submit POST and the
 * journey reload are sequential network round trips; on a cold serverless
 * function that is easily 5-15s of dead air. The candidate used to stare at
 * the frozen exam screen the whole time (button unchanged, re-clicks silently
 * swallowed by the advancing guard) — the "Done does nothing" bug.
 */

export const SUBMIT_SLOW_HINT_MS = 8000;

function renderSubmitHandover(view, { slowHintMs = SUBMIT_SLOW_HINT_MS } = {}) {
  document.body.classList.remove('exam-lock');
  view.innerHTML = `
    <div class="empty-page submit-handover" role="status" aria-live="polite">
      <div class="submit-ring"><span class="spinner"></span></div>
      <h1>Submitting your assessment…</h1>
      <p class="muted">Your final answer is locked and on its way to the assessor team. This usually takes a few seconds — please keep this tab open.</p>
      <p class="muted small submit-handover-slow" id="submit-slow" hidden>Still working. Every answer is saved and locked, so nothing is lost if this takes a moment longer than usual.</p>
    </div>`;
  // Reassurance, not decoration: the panel is the only feedback the candidate
  // gets while the request is in flight, and silence on a slow upload reads as
  // a freeze. Guarded on `isConnected` so a timer that fires after the panel
  // was replaced cannot touch a detached node.
  const slow = view.querySelector('#submit-slow');
  if (slow && slowHintMs > 0) {
    setTimeout(() => { if (slow.isConnected) slow.hidden = false; }, slowHintMs);
  }
}

function renderSubmitProblem(view, retry) {
  document.body.classList.remove('exam-lock');
  view.innerHTML = `
    <div class="empty-page" role="alert">
      <div class="error-icon">!</div>
      <h1>We couldn't submit your assessment</h1>
      <p class="muted">Your answers are safely saved — nothing was lost. Check your connection and try again.</p>
      <div class="row" style="justify-content:center;gap:10px;margin-top:8px">
        <button class="btn" id="submit-retry" type="button">Try submitting again</button>
        <a class="btn secondary" href="#/journey">Back to My Journey</a>
      </div>
    </div>`;
  view.querySelector('#submit-retry').onclick = retry;
}

/**
 * Submit a completed exam, retrying transient failures. Every answer is
 * already locked server-side at this point, so a retry never duplicates work;
 * 409 means the exam was already submitted (double click, replayed request)
 * and is success. Other 4xx are thrown immediately — retrying cannot help.
 *
 * Each attempt carries a deadline (`timeoutMs`). A submit that never answers —
 * a serverless invocation killed mid-write, a stalled proxy — must not leave
 * the handover panel spinning forever: the attempt fails like any network
 * error, is retried once or twice more, and then lands on the retry screen
 * that offers both "Try submitting again" and a way back to My Journey.
 */
export async function submitExam(id, { attempts = 3, backoffMs = 1200, timeoutMs = 20_000 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, backoffMs * i));
    try {
      const out = await api(`/candidate/assessments/${id}/submit`, {
        method: 'POST', body: { answers: {} }, timeoutMs,
      });
      return out && typeof out === 'object' ? out : { status: 'submitted' };
    } catch (err) {
      // The submit route's own conflicts ("already submitted", "already
      // scored") mean the paper is in: an earlier attempt landed. The storage
      // layer's insert race ("record was created by another request") is
      // also a 409 but means this attempt wrote nothing. It used to be taken
      // as success too, so the candidate was told "submitted" and sent to a
      // journey page that still showed the exam open. It is retried like a
      // 5xx, as the exam's own lock already does.
      if (err?.status === 409 && /created by another request/i.test(err.message || '')) { lastError = err; continue; }
      if (err?.status === 409) return { status: 'submitted', already: true };
      if (err?.status && err.status !== 429 && err.status < 500) throw err;
      lastError = err; // network failure, timeout, 429 or 5xx — worth another attempt
    }
  }
  throw lastError || new Error('Assessment submission failed');
}

export async function finalizeExam(id, opts) {
  const view = document.getElementById('view');
  renderSubmitHandover(view, opts);
  // Submit with no answers: every lock already persisted its answer (locked
  // rows win server-side, so re-sending them is pure payload — with recorded
  // audio that ran to megabytes and tripped the request-size limit, failing
  // the submit of a completed exam). Unanswered items submit as blanks — and
  // the server writes only the rows that actually changed, so a finished exam
  // finalises in one batch per table instead of one whole-store rewrite per
  // question.
  try {
    await submitExam(id, opts);
    toast('Assessment submitted. An assessor will review open responses.', 'success', 5000);
    location.hash = '#/journey';
  } catch {
    // Stay on an explicit, retryable error screen instead of pretending the
    // submission succeeded and dropping the candidate on a stale journey page
    // that still shows the exam as in progress.
    renderSubmitProblem(view, () => finalizeExam(id, opts));
  }
}

/* ================================ Report card ================================ */
export async function reportView(view, { id }) {
  document.body.classList.remove('exam-lock');
  view.innerHTML = loading();
  const d = await api(`/candidate/reports/${id}`);
  renderReport(view, { ...d, audience: 'candidate' });
}
