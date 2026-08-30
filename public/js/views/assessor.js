import { api } from '../api.js';
import { state } from '../app.js';
import {
  esc, fmtDateTime, fmtDate, loading, emptyState, toast, attempt, confirmModal,
  assessmentStatusBadge, readinessBadge, badge,
} from '../ui.js';
import { renderReport } from './report.js';

const fmtPts = (v) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

/* ================================ Workspace ================================ */
export async function workspaceView(view) {
  view.innerHTML = loading();
  const d = await api('/assessor/assessments');
  const pending = d.assessments.filter((a) => a.status === 'submitted');
  view.innerHTML = `
    <div class="page-heading">
      <div><h1>Assessments</h1><p class="muted">Score submitted work. Candidate contact details are not shown.</p></div>
      <div class="heading-actions"><span class="workspace-pill">${d.assessments.length} assigned</span></div>
    </div>
    ${pending.length ? `<div class="card attention-card"><span class="attention-icon">!</span><span><b>${pending.length} assessment${pending.length === 1 ? '' : 's'} awaiting your scoring.</b><small>Open a submitted assessment to complete the review.</small></span></div>` : ''}
    <div class="card table-card">
      ${d.assessments.length ? `
      <table class="data"><thead><tr><th>Candidate</th><th>Role</th><th>Status</th><th>Submitted</th><th>Outcome</th><th></th></tr></thead><tbody>
      ${d.assessments.map((a) => `<tr>
        <td><b>${esc(a.candidate?.name || '—')}</b><div class="small muted">${esc(a.candidate?.current_title || '')}${a.candidate?.years_experience != null ? ` · ${a.candidate.years_experience} yrs` : ''}</div></td>
        <td>${esc(a.role_name)}</td>
        <td>${assessmentStatusBadge(state.meta.assessmentStatuses, a.status)}</td>
        <td><span class="small muted">${a.submitted_at ? esc(fmtDateTime(a.submitted_at)) : 'not yet'}</span></td>
        <td>${a.overall_pct != null ? `<b>${a.overall_pct}%</b> ${readinessBadge(a.readiness_key, a.readiness_label)}` : '—'}</td>
        <td class="actions">${['submitted', 'scored', 'validated'].includes(a.status)
          ? `<a class="btn ${a.status === 'submitted' ? '' : 'secondary'} sm" href="#/assessments/${a.id}">${a.status === 'submitted' ? 'Score now' : 'View report'}</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>`
      : emptyState('No assignments yet', 'Assessments allocated to you will appear here.', '🧭')}
    </div>`;
}

/* ============================== Assessment (score / report) ============================== */
export async function assessmentView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/assessor/assessments/${id}`);

  if (['scored', 'validated'].includes(d.assessment.status) && d.report) {
    renderReport(view, { candidate: d.candidate, report: d.report, assessor_name: 'You', audience: 'assessor' });
    return;
  }
  if (d.assessment.status !== 'submitted') {
    view.innerHTML = `<div class="card">${emptyState('Not ready for scoring', 'The candidate has not submitted this assessment yet.')}</div>`;
    return;
  }

  // scoring workspace
  const responses = Object.fromEntries(d.responses.map((r) => [r.question_id, r]));
  const manualQs = d.questions.filter((q) => q.type === 'text');
  const scores = {};        // qid -> score
  const comments = {};      // qid -> comment
  for (const q of manualQs) {
    scores[q.id] = responses[q.id]?.assessor_score ?? null;
    comments[q.id] = responses[q.id]?.assessor_comment ?? '';
  }
  let qNo = 0;

  view.innerHTML = `
    <div class="score-topbar card">
      <div class="score-identity"><a href="#/workspace" class="back-link">← Workspace</a><span class="score-separator"></span><div><div class="section-kicker">Scoring review</div><h2>${esc(d.candidate?.name || '')}</h2><span class="muted small">${esc(d.assessment.role?.name || '')} · submitted ${esc(fmtDate(d.assessment.submitted_at))}</span></div></div>
      <div class="row score-actions"><span class="badge grey" id="score-progress"></span><button class="btn" id="finalize-btn">Finalize report <span aria-hidden="true">→</span></button></div>
    </div>
    <div class="card">
      <div class="small muted">Candidate profile (shared with you for context): <b>${esc(d.candidate?.current_title || 'n/a')}</b>${d.candidate?.years_experience != null ? `, ${d.candidate.years_experience} years of experience` : ''}. Objective MCQ and scale items are scored automatically — review them; your judgment is required only for open responses, scored against the rubric.</div>
    </div>
    ${d.competencies.map((c) => {
      const qs = d.questions.filter((x) => x.competency_id === c.id);
      if (!qs.length) return '';
      return `<div class="comp-header"><h3>${esc(c.name)}</h3><div class="meta">weight ${esc(c.weight)} · target L${esc(c.target_level)}</div></div>
        ${qs.map((q) => { qNo += 1; return scoreCard(q, qNo, responses[q.id]); }).join('')}`;
    }).join('')}`;

  const updateProgress = () => {
    const scored = manualQs.filter((q) => scores[q.id] !== null && scores[q.id] !== '').length;
    const el = view.querySelector('#score-progress');
    el.textContent = `${scored}/${manualQs.length} open questions scored`;
    el.className = `badge ${scored === manualQs.length ? 'green' : 'amber'}`;
    return scored;
  };
  updateProgress();

  // wire manual inputs
  for (const q of manualQs) {
    const input = view.querySelector(`#score-${q.id}`);
    const comment = view.querySelector(`#comment-${q.id}`);
    const save = async () => {
      const out = await attempt(() => api(`/assessor/assessments/${id}/scores`, {
        method: 'PUT',
        body: { scores: [{ question_id: q.id, score: scores[q.id], comment: comments[q.id] }] },
      }));
      if (out) toast('Saved', 'success', 1200);
    };
    input.onchange = () => {
      const val = input.value === '' ? null : Number(input.value);
      if (val !== null && (val < 0 || val > q.points)) { toast(`Score must be between 0 and ${q.points}`, 'error'); input.value = scores[q.id] ?? ''; return; }
      scores[q.id] = val;
      updateProgress();
      save();
    };
    comment.onchange = () => { comments[q.id] = comment.value; save(); };
  }

  view.querySelector('#finalize-btn').onclick = async () => {
    const scored = updateProgress();
    if (scored < manualQs.length) {
      toast(`Score all ${manualQs.length} open questions before finalizing (${scored} done).`, 'error');
      return;
    }
    const yes = await confirmModal('Finalize scoring', 'Generate the capability report? Scores and the report are locked afterwards (admin can still view them).', 'Finalize & generate');
    if (!yes) return;
    const out = await attempt(() => api(`/assessor/assessments/${id}/finalize`, { method: 'POST' }));
    if (out) {
      toast(`Report generated: ${out.report.band.label} at ${out.report.overall_pct}%`, 'success', 5000);
      renderReport(view, { candidate: out.candidate, report: out.report, assessor_name: 'You', audience: 'assessor' });
    }
  };
}

function scoreCard(q, n, r) {
  const answer = r?.answer;
  const head = `<div class="q-head"><span class="q-num">${n}</span>
    <div><div class="q-prompt">${esc(q.prompt)}</div>
      <div class="small muted" style="margin-top:5px"><span class="chip">${esc(q.type)}</span> <span class="chip">${esc(q.difficulty)}</span> <span class="chip">${esc(q.points)} pts</span>
      ${q.type !== 'text' ? `<span class="chip" style="background:var(--blue-bg);color:var(--blue)">auto-scored</span>` : `<span class="chip" style="background:var(--amber-bg);color:var(--amber)">needs your score</span>`}
      ${q.audio_required ? `<span class="chip chip-mic">🎙 recorded answer required</span>` : ''}</div>
    </div></div>`;

  let answerBlock = '';
  if (q.type === 'mcq_single' || q.type === 'mcq_multi') {
    const picked = q.type === 'mcq_multi'
      ? (Array.isArray(answer) ? answer.map(String) : (answer ? [String(answer)] : []))
      : [answer].filter((v) => v !== undefined && v !== null && v !== '');
    const correct = (q.correct_option_ids || []).map(String);
    const hits = picked.filter((id) => correct.includes(id)).length;
    answerBlock = (q.options || []).map((o) => {
      const isPicked = picked.includes(String(o.id));
      const isCorrect = correct.includes(String(o.id));
      const cls = isPicked && isCorrect ? 'opt correct' : isPicked ? 'opt wrong' : 'opt';
      const mark = isPicked && isCorrect ? '✓ candidate · correct' : isPicked ? '✗ candidate · incorrect' : isCorrect ? '<span class="small muted">(correct option)</span>' : '';
      return `<div class="${cls}" style="cursor:default"><span style="flex:1">${esc(o.label)}</span><span class="small" style="font-weight:700">${mark}</span></div>`;
    }).join('');
    const auto = Number(r?.auto_score ?? 0);
    const tone = auto >= Number(q.points) ? 'green' : auto > 0 ? 'amber' : 'red';
    const partial = q.type === 'mcq_multi' && correct.length
      ? ` · ${hits}/${correct.length} correct options`
      : '';
    answerBlock += `<div class="row" style="margin-top:8px">${badge(`Auto score: ${fmtPts(auto)}/${q.points}${partial}`, tone)}</div>`;
  } else if (q.type === 'scale') {
    answerBlock = `<div class="row"><b style="font-size:22px">${answer ?? '—'}</b><span class="muted">/5 self-rated</span>${badge(`Auto score: ${r?.auto_score ?? 0}/${q.points}`, 'blue')}</div>`;
  } else {
    // Open answer: the recording is the answer and typed notes are optional, so
    // the player — plus an explicit warning when the mandatory recording is
    // missing — has to be in front of the assessor, not hidden in the payload.
    const ans = answer && typeof answer === 'object' ? answer : { text: answer || '' };
    const textAns = [ans.text, ans.transcript && ans.transcript !== ans.text ? `\n\n[Transcript]\n${ans.transcript}` : ''].filter(Boolean).join('');
    const audioPlayer = ans.audio_b64
      ? `<audio class="exam-audio-playback" controls src="data:${esc(ans.audio_mime || 'audio/webm')};base64,${esc(ans.audio_b64)}"></audio>`
      : '';
    const nothingSpoken = !ans.audio_b64 && !String(ans.transcript || '').trim();
    const spokenWarning = ans.audio_missing === true
      ? '<div class="small" style="margin-top:6px;color:var(--red);font-weight:700">⚠ No recording was submitted. Open questions require a spoken answer, so this is typed notes only — score accordingly and say so in the feedback.</div>'
      : (nothingSpoken && q.audio_required === true && String(ans.text || '').trim()
        ? '<div class="small" style="margin-top:6px;color:var(--amber);font-weight:700">⚠ No recording attached to this open answer.</div>'
        : '');
    answerBlock = `
      <blockquote class="answer">${esc(textAns || '— no answer —')}</blockquote>
      ${audioPlayer}
      ${spokenWarning}
      ${ans.source === 'audio' ? '<div class="small muted" style="margin-top:6px">Submitted via audio (transcribed).</div>' : ''}
      <details class="fold" style="margin-top:10px"><summary>📋 Scoring rubric (expected evidence)</summary>
        <div class="rubric" style="margin-top:8px">${esc(q.rubric || 'No rubric configured.')}</div></details>
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <label class="f" style="margin:0"><span class="lbl">Your score (0-${q.points})</span>
          <input type="number" class="score-input" id="score-${esc(q.id)}" min="0" max="${esc(q.points)}" step="0.5" value="${r?.assessor_score ?? ''}"/></label>
        <label class="f" style="margin:0;flex:1"><span class="lbl">Feedback for the report (internal)</span>
          <input type="text" id="comment-${esc(q.id)}" value="${esc(r?.assessor_comment || '')}" placeholder="Why this score? Not shown to the candidate."/></label>
      </div>`;
  }
  return `<div class="q-card">${head}${answerBlock}</div>`;
}
