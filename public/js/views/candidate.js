import { api } from '../api.js';
import { state } from '../app.js';
import {
  esc, fmtDate, loading, emptyState, toast, attempt, confirmModal,
  pipelineStepper, assessmentStatusBadge, readinessBadge,
} from '../ui.js';
import { renderReport } from './report.js';

/* ================================ Portal (My Journey) ================================ */
export async function portalView(view) {
  view.innerHTML = loading();
  const d = await api('/candidate/assessments');
  const stages = state.meta.pipelineStages;
  view.innerHTML = `
    <div class="page-heading candidate-heading">
      <div><div class="eyebrow">Your capability journey</div><h1>Welcome, ${esc(d.candidate.name.split(' ')[0])}<span class="heading-dot">.</span></h1><p>A clear path from your current strengths to enterprise-ready impact.</p></div>
      <div class="journey-status"><span class="online-dot"></span> Profile in progress</div>
    </div>
    <div class="card journey-card">
      <div class="panel-head"><div><div class="section-kicker">Your roadmap</div><h2>Progress at a glance</h2></div><span class="journey-spark">✦</span></div>
      ${pipelineStepper(stages, d.candidate.stage)}
    </div>
    <div class="card assessment-list-card">
      <div class="panel-head"><div><div class="section-kicker">Next steps</div><h2>Your assessments</h2><p>Complete each assessment to unlock your capability report.</p></div></div>
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
            ${['assigned', 'in_progress'].includes(a.status) ? `<a class="btn" href="#/assessments/${a.id}/quiz">${a.status === 'in_progress' ? 'Continue assessment' : 'Start assessment'} →</a>` : ''}
            ${a.status === 'submitted' ? `<span class="chip">Under assessor review — report arrives after scoring</span>` : ''}
            ${['scored', 'validated'].includes(a.status) ? `<a class="btn" href="#/assessments/${a.id}/report">View report card</a>` : ''}
          </div>
        </div>`).join('')
      : emptyState('No assessments yet', 'Your administrator will allocate one when you are ready.')}
    </div>`;
}

/* ================================ Quiz ================================ */
export async function quizView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/candidate/assessments/${id}`);

  if (d.assessment.status === 'submitted') {
    view.innerHTML = `<div class="card">${emptyState('Assessment submitted', 'An assessor is reviewing your answers. Your report card appears here once scoring is complete.', '✅')}<div class="row" style="justify-content:center"><a class="btn secondary" href="#/journey">Back to My Journey</a></div></div>`;
    return;
  }
  if (['scored', 'validated'].includes(d.assessment.status)) { location.hash = `#/assessments/${id}/report`; return; }

  const answers = { ...(d.answers || {}) };
  const comps = [...d.competencies].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const questions = [...d.questions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const total = questions.length;
  let qNo = 0;

  view.innerHTML = `
    <div class="quiz-topbar card">
      <div class="quiz-title"><span class="quiz-back"><a href="#/journey" aria-label="Back to journey">←</a></span><div><div class="section-kicker">Assessment in progress</div><h2>${esc(d.assessment.role?.name || 'Assessment')}</h2></div></div>
      <div class="quiz-progress"><div class="quiz-progress-label"><span><b id="answered-count">0</b> of ${total} answered</span><span class="save-state" id="save-state">Autosaves as you go</span></div><div class="quiz-track"><span id="quiz-progress-fill"></span></div></div>
    </div>
    ${comps.map((c) => {
      const qs = questions.filter((x) => x.competency_id === c.id);
      if (!qs.length) return '';
      return `<div class="comp-header"><h3>${esc(c.name)}</h3>${c.description ? `<div class="meta">${esc(c.description)}</div>` : ''}</div>
        ${qs.map((q) => { qNo += 1; return questionCard(q, qNo, answers[q.id]); }).join('')}`;
    }).join('')}
    <div class="card quiz-submit-card">
      <div><div class="section-kicker">Almost there</div><h3>Ready to submit?</h3><div class="small muted">You cannot change answers after submission. Open questions are reviewed by an independent assessor.</div></div>
      <button class="btn" id="submit-btn">Submit assessment <span aria-hidden="true">→</span></button>
    </div>`;

  const saveState = view.querySelector('#save-state');
  const answeredCount = () => {
    const n = questions.filter((q) => {
      const a = answers[q.id];
      return a !== undefined && a !== null && a !== '' && !(Array.isArray(a) && !a.length);
    }).length;
    view.querySelector('#answered-count').textContent = n;
    const fill = view.querySelector('#quiz-progress-fill');
    if (fill) fill.style.width = `${total ? Math.round((n / total) * 100) : 0}%`;
    return n;
  };
  answeredCount();

  let saveTimer;
  const persist = () => {
    saveState.textContent = 'Saving…';
    saveState.className = 'save-state';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const out = await attempt(() => api(`/candidate/assessments/${id}/answers`, { method: 'PUT', body: { answers } }));
      if (out) { saveState.textContent = `✓ Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; saveState.classList.add('saved'); }
      else saveState.textContent = 'Could not save — retrying on next change';
    }, 600);
  };

  // wire inputs
  for (const q of questions) {
    const card = view.querySelector(`[data-q="${q.id}"]`);
    if (!card) continue;
    if (q.type === 'mcq_single') {
      card.querySelectorAll('input[type=radio]').forEach((r) => (r.onchange = () => {
        answers[q.id] = r.value;
        card.querySelectorAll('.opt').forEach((o) => o.classList.toggle('selected', o.querySelector('input').checked));
        answeredCount(); persist();
      }));
    } else if (q.type === 'mcq_multi') {
      card.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.onchange = () => {
        const picked = [...card.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
        answers[q.id] = picked;
        card.querySelectorAll('.opt').forEach((o) => o.classList.toggle('selected', o.querySelector('input').checked));
        answeredCount(); persist();
      }));
    } else if (q.type === 'scale') {
      card.querySelectorAll('.scale-row button').forEach((b) => (b.onclick = (e) => {
        e.preventDefault();
        answers[q.id] = Number(b.dataset.v);
        card.querySelectorAll('.scale-row button').forEach((x) => x.classList.toggle('selected', Number(x.dataset.v) <= Number(b.dataset.v)));
        answeredCount(); persist();
      }));
    } else if (q.type === 'text') {
      const ta = card.querySelector('textarea');
      ta.oninput = () => { answers[q.id] = ta.value; answeredCount(); persist(); };
    }
  }

  view.querySelector('#submit-btn').onclick = async () => {
    const answered = answeredCount();
    if (answered < total) {
      const yes = await confirmModal('Unanswered questions', `${total - answered} of ${total} questions are unanswered. Submit anyway? Unanswered questions must be completed before submission — go back and finish them.`, 'Keep answering');
      return;
    }
    const yes = await confirmModal('Submit assessment', 'Submit your final answers? You will not be able to change them afterwards.', 'Submit final answers');
    if (!yes) return;
    const out = await attempt(() => api(`/candidate/assessments/${id}/submit`, { method: 'POST', body: { answers } }));
    if (out) {
      toast('Assessment submitted — thank you! An assessor will now review it.', 'success', 5000);
      location.hash = '#/journey';
    }
  };
}

function questionCard(q, n, current) {
  const head = `<div class="q-head"><span class="q-num">${n}</span>
    <div><div class="q-prompt">${esc(q.prompt)}</div>
    ${q.help_text ? `<div class="small muted" style="margin-top:3px">${esc(q.help_text)}</div>` : ''}
    <div class="small muted" style="margin-top:5px"><span class="chip">${esc(typeLabel(q.type))}</span> <span class="chip">${esc(q.difficulty)}</span> <span class="chip">${esc(q.points)} pts</span></div></div></div>`;
  let body = '';
  if (q.type === 'mcq_single' || q.type === 'mcq_multi') {
    const multi = q.type === 'mcq_multi';
    body = (q.options || []).map((o) => {
      const selected = multi ? (current || []).includes(o.id) : current === o.id;
      return `<label class="opt ${selected ? 'selected' : ''}">
        <input type="${multi ? 'checkbox' : 'radio'}" name="q-${q.id}" value="${esc(o.id)}" ${selected ? 'checked' : ''}/>
        <span>${esc(o.label)}</span></label>`;
    }).join('') || '<div class="muted small">No options configured for this question.</div>';
  } else if (q.type === 'scale') {
    body = `<div class="scale-row">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-v="${i}" class="${current >= i && current ? 'selected' : ''}">${i}</button>`).join('')}</div>
      <div class="small muted" style="margin-top:6px">1 = no exposure yet · 5 = deep hands-on expertise</div>`;
  } else {
    body = `<textarea rows="6" placeholder="Type your answer…">${esc(current || '')}</textarea>`;
  }
  return `<div class="q-card" data-q="${esc(q.id)}">${head}${body}</div>`;
}

const typeLabel = (t) => (state.meta.questionTypes.find((x) => x.key === t) || {}).label || t;

/* ================================ Report card ================================ */
export async function reportView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/candidate/reports/${id}`);
  renderReport(view, { ...d, audience: 'candidate' });
}
