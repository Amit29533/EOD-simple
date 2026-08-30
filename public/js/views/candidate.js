import { api, session } from '../api.js';
import { state } from '../app.js';
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
export async function quizView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/candidate/assessments/${id}`);

  if (d.assessment.status === 'submitted') {
    document.body.classList.remove('exam-lock');
    view.innerHTML = `<div class="card">${emptyState('Assessment submitted', 'An assessor is reviewing your answers. Your report card appears here once scoring is complete.', '✅')}<div class="row" style="justify-content:center"><a class="btn secondary" href="#/journey">Back to My Journey</a></div></div>`;
    return;
  }
  if (['scored', 'validated'].includes(d.assessment.status)) { location.hash = `#/assessments/${id}/report`; return; }

  if (d.exam?.complete) {
    await finalizeExam(id, {});
    return;
  }

  const gateKey = `ecod.exam.ack.${id}`;
  if (!sessionStorage.getItem(gateKey)) {
    renderExamGate(view, d, () => {
      sessionStorage.setItem(gateKey, '1');
      quizView(view, { id });
    });
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
          <li><b>Multiple-choice &amp; scale:</b> 30 seconds to answer.</li>
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

async function runExamSession(view, id, payload) {
  document.body.classList.add('exam-lock');
  let d = payload;
  let currentAnswer = d.current_answer;
  let ticking = null;
  let advancing = false;
  let finished = false;
  // Released whenever the exam view is torn down or repainted, so a recording
  // never outlives the question it belongs to (the browser tab keeps showing
  // the "microphone in use" indicator otherwise).
  let stopLiveCapture = null;
  let pageHideLogged = false;
  const tabId = `${id}-${Math.random().toString(36).slice(2, 9)}`;
  const collected = {};
  const cleanup = [];
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
  cleanup.push(() => {
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

  const stillHere = () => location.hash.includes(`/assessments/${id}/quiz`);

  async function advance(answer) {
    if (advancing) return;
    advancing = true;
    if (ticking) { clearInterval(ticking); ticking = null; }
    const q = d.current_question;
    if (q && answer !== undefined) collected[q.id] = answer;
    const out = await attempt(() => api(`/candidate/assessments/${id}/next`, {
      method: 'POST',
      body: { answer: answer === undefined ? null : answer },
    }));
    if (!out) { advancing = false; return; }
    if (out.complete) {
      finished = true;
      cleanup.forEach((fn) => fn());
      await finalizeExam(id, collected);
      return;
    }
    d = await api(`/candidate/assessments/${id}`);
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

  function paint() {
    if (!stillHere()) { cleanup.forEach((fn) => fn()); return; }
    const q = d.current_question;
    const exam = d.exam;
    if (!q || exam.complete) {
      finished = true;
      cleanup.forEach((fn) => fn());
      finalizeExam(id, collected);
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
                ${open ? `<span class="chip">${phase === 'review' ? 'Review window · 60s' : 'Recording window · 2 min'}</span><span class="chip chip-mic">🎙 Recorded answer required</span>` : `<span class="chip">30s</span>`}
              </div>
            </div>
          </div>
          <div class="exam-body" id="exam-body"></div>
        </div>
        <div class="exam-actions row between">
          <span class="small muted">Answers lock when time expires. You cannot return.</span>
          <button class="btn" id="exam-next" ${open && phase === 'review' ? '' : ''}>${open && phase === 'review' ? 'Start answering →' : (n >= exam.total ? 'Lock & submit' : 'Lock & continue →')}</button>
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
    const recElapsed = () => (rec.startedAt ? fmtMs(Date.now() - rec.startedAt) : '');

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
        await attempt(() => api(`/candidate/assessments/${id}/phase`, { method: 'POST', body: { phase: 'answer' } }));
        d = await api(`/candidate/assessments/${id}`);
        currentAnswer = d.current_answer;
        paint();
      };
    } else if (q.type === 'mcq_single' || q.type === 'mcq_multi') {
      const multi = q.type === 'mcq_multi';
      let val = multi ? (Array.isArray(currentAnswer) ? [...currentAnswer] : []) : (typeof currentAnswer === 'string' ? currentAnswer : null);
      body.innerHTML = (q.options || []).map((o) => {
        const selected = multi ? val.includes(o.id) : val === o.id;
        return `<label class="opt ${selected ? 'selected' : ''}">
          <input type="${multi ? 'checkbox' : 'radio'}" name="q-cur" value="${esc(o.id)}" ${selected ? 'checked' : ''}/>
          <span>${esc(o.label)}</span></label>`;
      }).join('') || '<div class="muted small">No options configured.</div>';
      body.querySelectorAll('input').forEach((inp) => {
        inp.onchange = () => {
          if (multi) val = [...body.querySelectorAll('input:checked')].map((x) => x.value);
          else val = inp.value;
          body.querySelectorAll('.opt').forEach((o) => o.classList.toggle('selected', o.querySelector('input').checked));
          currentAnswer = val;
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
      body.innerHTML = `
        <div class="exam-answer${needsMic ? ' has-audio' : ''}">
          <textarea id="exam-ta" rows="8" placeholder="${needsMic ? 'Optional notes — the recording below is your answer' : 'Type your answer here'}">${esc(text)}</textarea>
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
      ta.oninput = () => { text = ta.value; syncNext(); };
      ta.onpaste = () => logIntegrity('paste');
      const recBtn = body.querySelector('#rec-btn');
      const recLabel = body.querySelector('#rec-label');
      const recState = body.querySelector('#rec-state');
      const recTimer = body.querySelector('#rec-timer');
      const preview = body.querySelector('#transcript-preview');
      if (transcript) { preview.hidden = false; preview.textContent = `Transcript: ${transcript}`; }
      const hasAnswer = () => Boolean((ta?.value || text).trim() || transcript.trim() || rec.audioB64);
      // Spoken evidence = a stored recording or a transcript. Either alone is
      // enough: Safari/Firefox have no speech recognition, and a clip can be
      // dropped for size, so both paths count as "answered out loud". While the
      // recorder is live the answer also counts — browsers only flush chunks on
      // stop(), and "Lock & continue" stops the recording first, so the button
      // must not deadlock a candidate mid-sentence.
      const hasSpoken = () => Boolean(rec.audioB64 || transcript.trim()
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
      if (existing.audio_b64) setRecState('Recorded answer restored · you can continue', 'ok');
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
            return;
          }
          recLabel.textContent = 'Stop recording';
          recBtn.classList.add('recording');
          recBtn.setAttribute('aria-pressed', 'true');
          rec.chunks = [];
          rec.audioB64 = '';
          rec.audioMime = '';
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
        advance(buildTextAnswer({
          text: ta.value || text,
          transcript,
          audioB64: rec.audioB64,
          audioMime: rec.audioMime,
        }));
      };
    }

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
          attempt(() => api(`/candidate/assessments/${id}/phase`, { method: 'POST', body: { phase: 'answer' } }))
            .then(async () => {
              d = await api(`/candidate/assessments/${id}`);
              currentAnswer = d.current_answer;
              paint();
            });
          return;
        }
        nextBtn.dataset.force = '1';
        nextBtn.disabled = false;
        nextBtn.click();
      }
    }, 250);
  }

  paint();
}

async function finalizeExam(id, answers) {
  document.body.classList.remove('exam-lock');
  const out = await attempt(() => api(`/candidate/assessments/${id}/submit`, { method: 'POST', body: { answers } }));
  if (out) {
    toast('Assessment submitted. An assessor will review open responses.', 'success', 5000);
    location.hash = '#/journey';
  } else {
    location.hash = '#/journey';
  }
}

/* ================================ Report card ================================ */
export async function reportView(view, { id }) {
  document.body.classList.remove('exam-lock');
  view.innerHTML = loading();
  const d = await api(`/candidate/reports/${id}`);
  renderReport(view, { ...d, audience: 'candidate' });
}
