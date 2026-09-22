import { api } from '../api.js';
import { state, VIEW_UNMOUNT_EVENT } from '../app.js';
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
    }).join('')}
    ${(() => {
      // A paper frozen before its competency was deactivated (or by an older
      // build that still served such questions) can carry answers no
      // competency section claims. They must still be shown — and scorable —
      // otherwise the score inputs the wiring below expects do not exist and
      // the whole scoring screen dies on the first missing element.
      const grouped = new Set(d.competencies.map((c) => c.id));
      const orphans = d.questions.filter((q) => !grouped.has(q.competency_id));
      if (!orphans.length) return '';
      return `<div class="comp-header"><h3>Other questions</h3><div class="meta">competency no longer part of this track · not counted in the report</div></div>
        ${orphans.map((q) => { qNo += 1; return scoreCard(q, qNo, responses[q.id]); }).join('')}`;
    })()}`;

  loadRecordings(view, id);

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
    if (!input || !comment) continue;
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

/**
 * Recordings arrive separately from the detail: one request per spoken
 * answer, two at a time, in page order, so the first questions are playable
 * within a second while a 33-clip paper streams in behind them. Leaving the
 * page stops the queue; a failed clip gets a retry button instead of a
 * silent gap.
 */
export function loadRecordings(view, assessmentId, { concurrency = 2, fetchRecording } = {}) {
  const slots = [...view.querySelectorAll('.exam-audio-slot[data-recording]')];
  if (!slots.length) return;
  const load = fetchRecording
    || ((qid) => api(`/assessor/assessments/${assessmentId}/recordings/${encodeURIComponent(qid)}`));
  const queue = slots.slice();
  let active = 0;
  let stopped = false;
  const onUnmount = () => { stopped = true; document.removeEventListener(VIEW_UNMOUNT_EVENT, onUnmount); };
  document.addEventListener(VIEW_UNMOUNT_EVENT, onUnmount);

  const fill = async (slot) => {
    const qid = slot.dataset.recording;
    slot.innerHTML = '<span class="small muted">Loading recording…</span>';
    try {
      const rec = await load(qid);
      if (stopped || !slot.isConnected) return;
      if (!rec?.audio_b64) throw new Error('empty recording');
      const audio = document.createElement('audio');
      audio.className = 'exam-audio-playback';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = `data:${rec.audio_mime || 'audio/webm'};base64,${rec.audio_b64}`;
      slot.replaceChildren(audio);
    } catch (err) {
      if (stopped || !slot.isConnected) return;
      slot.innerHTML = `<span class="small" style="color:var(--red)">Recording could not be loaded${err?.message ? `: ${esc(err.message)}` : ''}.</span> <button type="button" class="btn ghost sm">Retry</button>`;
      slot.querySelector('button').onclick = () => { queue.push(slot); pump(); };
    }
  };
  const pump = () => {
    while (!stopped && active < concurrency && queue.length) {
      const slot = queue.shift();
      active += 1;
      fill(slot).finally(() => { active -= 1; pump(); });
    }
    if (!active && !queue.length) document.removeEventListener(VIEW_UNMOUNT_EVENT, onUnmount);
  };
  pump();
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
    const pickedRaw = q.type === 'mcq_multi'
      ? (Array.isArray(answer) ? answer.map(String) : (answer ? [String(answer)] : []))
      : [answer].filter((v) => v !== undefined && v !== null && v !== '').map(String);
    const picked = [...new Set(pickedRaw.filter(Boolean))];
    const correct = [...new Set((q.correct_option_ids || []).map(String).filter(Boolean))];
    const hits = picked.filter((id) => correct.includes(id)).length;
    const extras = picked.filter((id) => !correct.includes(id)).length;
    const exact = extras === 0 && hits === correct.length && correct.length > 0;
    answerBlock = (q.options || []).map((o) => {
      const isPicked = picked.includes(String(o.id));
      const isCorrect = correct.includes(String(o.id));
      const cls = isPicked && isCorrect ? 'opt correct' : isPicked ? 'opt wrong' : 'opt';
      const mark = isPicked && isCorrect ? '✓ candidate · correct' : isPicked ? '✗ candidate · incorrect' : isCorrect ? '<span class="small muted">(correct option)</span>' : '';
      return `<div class="${cls}" style="cursor:default"><span style="flex:1">${esc(o.label)}</span><span class="small" style="font-weight:700">${mark}</span></div>`;
    }).join('');
    const auto = Number(r?.auto_score ?? 0);
    const tone = auto >= Number(q.points) ? 'green' : auto > 0 ? 'amber' : 'red';
    const multiNote = q.type === 'mcq_multi' && correct.length
      ? (exact
        ? ' · exact match'
        : ` · not an exact match (${hits}/${correct.length} correct${extras ? `, ${extras} incorrect` : ''})`)
      : '';
    answerBlock += `<div class="row" style="margin-top:8px">${badge(`Auto score: ${fmtPts(auto)}/${q.points}${multiNote}`, tone)}</div>`;
  } else if (q.type === 'scale') {
    // The answer is candidate-controlled stored data: escape it like every
    // other rendered answer, even though the API only accepts 1-5 today.
    answerBlock = `<div class="row"><b style="font-size:22px">${esc(answer ?? '—')}</b><span class="muted">/5 self-rated</span>${badge(`Auto score: ${r?.auto_score ?? 0}/${q.points}`, 'blue')}</div>`;
  } else {
    // Open answer: the recording is the answer and typed notes are optional, so
    // the player — plus an explicit warning when the mandatory recording is
    // missing — has to be in front of the assessor, not hidden in the payload.
    const ans = answer && typeof answer === 'object' ? answer : { text: answer || '' };
    const textAns = [ans.text, ans.transcript && ans.transcript !== ans.text ? `\n\n[Transcript]\n${ans.transcript}` : ''].filter(Boolean).join('');
    // The clip itself is not in the detail payload (a whole-bank paper holds
    // ~10 MB of audio); `has_recording` marks a slot that loadRecordings()
    // fills from the per-question endpoint once the page is up.
    const hasRecording = ans.has_recording === true || Boolean(ans.audio_b64);
    const audioPlayer = hasRecording
      ? `<div class="exam-audio-slot" data-recording="${esc(q.id)}"><span class="small muted">Loading recording…</span></div>`
      : '';
    const nothingSpoken = !hasRecording && !String(ans.transcript || '').trim();
    const spokenWarning = ans.audio_missing === true
      ? '<div class="small" style="margin-top:6px;color:var(--red);font-weight:700">⚠ No recording was submitted. Open questions require a spoken answer, so this is typed notes only — score accordingly and say so in the feedback.</div>'
      : (nothingSpoken && q.audio_required === true && String(ans.text || '').trim()
        ? '<div class="small" style="margin-top:6px;color:var(--amber);font-weight:700">⚠ No recording attached to this open answer.</div>'
        : '');
    // A blank open answer carries how it came about: the clock ran out, or the
    // candidate moved on without answering. Say which, so the assessor is not
    // left guessing from an empty box.
    const blankNote = !textAns && !hasRecording
      ? (ans.source === 'timed_out' ? '— no answer · time expired —' : ans.source === 'skipped' ? '— no answer · question skipped —' : '— no answer —')
      : '';
    answerBlock = `
      <blockquote class="answer">${esc(textAns || blankNote)}</blockquote>
      ${audioPlayer}
      ${spokenWarning}
      ${ans.source === 'audio' ? '<div class="small muted" style="margin-top:6px">Submitted via audio (transcribed).</div>' : ''}
      <details class="fold" style="margin-top:10px"><summary>📋 Scoring rubric (expected evidence)</summary>
        <div class="rubric" style="margin-top:8px">${esc(q.rubric || 'No rubric configured.')}</div></details>
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <label class="f" style="margin:0"><span class="lbl">Your score (0-${esc(q.points)})</span>
          <input type="number" class="score-input" id="score-${esc(q.id)}" min="0" max="${esc(q.points)}" step="0.5" value="${esc(r?.assessor_score ?? '')}"/></label>
        <label class="f" style="margin:0;flex:1"><span class="lbl">Feedback for the report (internal)</span>
          <input type="text" id="comment-${esc(q.id)}" value="${esc(r?.assessor_comment || '')}" placeholder="Why this score? Not shown to the candidate."/></label>
      </div>`;
  }
  return `<div class="q-card">${head}${answerBlock}</div>`;
}
