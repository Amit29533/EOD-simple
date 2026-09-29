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
  // Put actionable work first while keeping completed reports available.
  const priority = { submitted: 0, in_progress: 1, assigned: 2, scored: 3, validated: 4 };
  const assessments = [...d.assessments].sort((a, b) =>
    (priority[a.status] ?? 9) - (priority[b.status] ?? 9)
    || String(b.submitted_at || b.created_at || '').localeCompare(String(a.submitted_at || a.created_at || '')));
  view.innerHTML = `
    <div class="page-heading">
      <div><h1>Assessments</h1><p class="muted">Score submitted work. Candidate contact details are not shown.</p></div>
      <div class="heading-actions"><span class="workspace-pill">${d.assessments.length} assigned</span></div>
    </div>
    ${pending.length ? `<div class="card attention-card"><span class="attention-icon">!</span><span><b>${pending.length} assessment${pending.length === 1 ? '' : 's'} awaiting your scoring.</b><small>Open a submitted assessment to complete the review.</small></span></div>` : ''}
    ${assessments.length ? `<div class="card flat toolbar-card assessor-toolbar">
      <div class="toolbar-label"><span class="toolbar-icon">⌕</span><span>Find work</span></div>
      <input id="assessor-search" type="search" placeholder="Search candidate or role…" autocomplete="off" aria-label="Search assessments">
      <select id="assessor-status" aria-label="Filter assessments by status"><option value="">All statuses</option>
        ${state.meta.assessmentStatuses.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('')}</select>
      <span class="toolbar-hint" id="assessor-result-count"></span>
    </div>` : ''}
    <div class="card table-card" id="assessor-results">
      ${assessments.length ? `
      <table class="data"><thead><tr><th>Candidate</th><th>Role</th><th>Status</th><th>Submitted</th><th>Outcome</th><th></th></tr></thead><tbody>
      ${assessments.map((a) => `<tr data-assessment-row data-status="${esc(a.status)}" data-search="${esc(`${a.candidate?.name || ''} ${a.role_name || ''}`.toLowerCase())}">
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

  const search = view.querySelector('#assessor-search');
  const status = view.querySelector('#assessor-status');
  const count = view.querySelector('#assessor-result-count');
  if (search && status && count) {
    const rows = [...view.querySelectorAll('[data-assessment-row]')];
    const applyFilters = () => {
      const term = search.value.trim().toLowerCase();
      let visible = 0;
      for (const row of rows) {
        const match = (!term || row.dataset.search.includes(term))
          && (!status.value || row.dataset.status === status.value);
        row.hidden = !match;
        if (match) visible += 1;
      }
      count.textContent = `${visible} of ${rows.length} assessments`;
    };
    search.oninput = applyFilters;
    status.onchange = applyFilters;
    applyFilters();
  }
}

/* ============================== Assessment (score / report) ============================== */
export async function assessmentView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/assessor/assessments/${id}`);

  if (['scored', 'validated'].includes(d.assessment.status) && d.report) {
    // The report is the landing screen of a finalized paper, as before — with a
    // way into the evidence it was built from. The answer sheet, the
    // transcripts and the recordings are kept after finalization (until the
    // retention policy removes them), which is what `answersView` opens.
    renderReport(view, {
      candidate: d.candidate, report: d.report, assessor_name: 'You', audience: 'assessor',
      actionsHtml: `<a class="btn secondary sm" href="#/assessments/${id}/answers">🧾 Answer sheet &amp; recordings</a>`,
    });
    return;
  }
  if (d.assessment.status !== 'submitted') {
    view.innerHTML = `<div class="card">${emptyState('Not ready for scoring', 'The candidate has not submitted this assessment yet.')}</div>`;
    return;
  }

  renderAnswerSheet(view, d, { id, readonly: false });
}

/**
 * The answer sheet of a submitted or finalized paper.
 *
 * This is the same screen the assessor scores on, and — once the report
 * exists — the read-only review of the evidence behind it: every question as
 * served, the MCQ picks with the correct answers marked, the typed notes, the
 * live transcripts and a player per recorded answer. On a finalized paper the
 * inputs are disabled, the finalize button is gone and the report card is one
 * click away; nothing here disappears until the admin's retention policy says
 * so (per paper, the `retention` block says when).
 */
export async function answersView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/assessor/assessments/${id}`);
  if (['assigned', 'in_progress'].includes(d.assessment.status)) {
    view.innerHTML = `<div class="card">${emptyState('Not ready', 'The candidate has not submitted this assessment yet.')}</div>`;
    return;
  }
  renderAnswerSheet(view, d, { id, readonly: ['scored', 'validated'].includes(d.assessment.status) });
}

function renderAnswerSheet(view, d, { id, readonly }) {
  const responses = Object.fromEntries(d.responses.map((r) => [r.question_id, r]));
  const manualQs = d.questions.filter((q) => q.type === 'text');
  const scores = {};        // qid -> score
  const comments = {};      // qid -> comment
  for (const q of manualQs) {
    scores[q.id] = responses[q.id]?.assessor_score ?? null;
    comments[q.id] = responses[q.id]?.assessor_comment ?? '';
  }
  let qNo = 0;

  const retentionNote = readonly ? retentionLine(d.retention) : '';

  view.innerHTML = `
    <div class="score-topbar card">
      <div class="score-identity"><a href="#/workspace" class="back-link">← Workspace</a><span class="score-separator"></span><div><div class="section-kicker">${readonly ? 'Answer sheet · report finalized' : 'Scoring review'}</div><h2>${esc(d.candidate?.name || '')}</h2><span class="muted small">${esc(d.assessment.role?.name || '')} · submitted ${esc(fmtDate(d.assessment.submitted_at))}${readonly && d.assessment.scored_at ? ` · finalized ${esc(fmtDate(d.assessment.scored_at))}` : ''}</span></div></div>
      <div class="row score-actions"><span class="badge grey" id="score-progress"></span>${readonly
        ? `<a class="btn secondary" href="#/assessments/${esc(id)}">View report card <span aria-hidden="true">→</span></a>`
        : '<button class="btn" id="finalize-btn">Finalize report <span aria-hidden="true">→</span></button>'}</div>
    </div>
    <div class="card">
      <div class="small muted">Candidate profile (shared with you for context): <b>${esc(d.candidate?.current_title || 'n/a')}</b>${d.candidate?.years_experience != null ? `, ${d.candidate.years_experience} years of experience` : ''}. Objective MCQ and scale items are scored automatically — review them; your judgment is required only for open responses, scored against the rubric.</div>
      ${retentionNote ? `<div class="small muted" style="margin-top:8px">🗂 ${retentionNote}</div>` : ''}
    </div>
    ${d.competencies.map((c) => {
      const qs = d.questions.filter((x) => x.competency_id === c.id);
      if (!qs.length) return '';
      return `<div class="comp-header"><h3>${esc(c.name)}</h3><div class="meta">weight ${esc(c.weight)} · target L${esc(c.target_level)}</div></div>
        ${qs.map((q) => { qNo += 1; return scoreCard(q, qNo, responses[q.id], { readonly }); }).join('')}`;
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
        ${orphans.map((q) => { qNo += 1; return scoreCard(q, qNo, responses[q.id], { readonly }); }).join('')}`;
    })()}`;

  // Clips load per question; the delete control beside each player removes
  // that one recording (it is the only copy — the dialog says so).
  loadRecordings(view, id);
  wireRecordingDeletes(view, id);

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

  if (readonly) return; // finalized: scores are locked, the inputs are disabled

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
 * What the paper's retention block means, in the assessor's words: how long the
 * evidence behind the report stays reviewable, and what the cleanup already
 * took (a purged paper keeps its report — and says so here).
 */
function retentionLine(ret) {
  if (!ret) return '';
  if (ret.state === 'purged') {
    return `The answer sheet and recordings were deleted by the retention policy on ${esc(fmtDate(ret.purged_at))}. The report card keeps every prompt, score and comment.`;
  }
  if (ret.state === 'off') {
    return 'Automatic cleanup is switched off: the answer sheet, transcripts and recordings are kept until an admin removes them.';
  }
  if (ret.due_at) {
    const days = ret.days_left;
    const left = days == null ? '' : days <= 0 ? ' (due for cleanup)' : ` (in ${days} day${days === 1 ? '' : 's'})`;
    return `Kept for review: the answer sheet, transcripts and recordings are deleted automatically on ${esc(fmtDate(ret.due_at))}${left}.`;
  }
  return '';
}

/**
 * "Delete recording" behind each player. One confirmation (the clip is the only
 * copy), one DELETE, and the slot is repainted in place — a clip still being
 * fetched for that question is dropped with it.
 */
function wireRecordingDeletes(view, assessmentId) {
  view.querySelectorAll('[data-delete-recording]').forEach((btn) => {
    btn.onclick = async () => {
      const qid = btn.dataset.deleteRecording;
      const yes = await confirmModal(
        'Delete this recording?',
        'The recorded answer is the only copy and cannot be recovered. The transcript and the typed notes stay in the answer sheet, and the deletion is written to the audit log.',
        'Delete recording', true,
      );
      if (!yes) return;
      const out = await attempt(() => api(`/assessor/assessments/${assessmentId}/recordings/${encodeURIComponent(qid)}`, { method: 'DELETE' }));
      if (!out) return;
      const slot = btn.closest('.q-card')?.querySelector('.exam-audio-slot');
      // Replacing the node detaches it, so a clip still loading for this
      // question cannot paint itself back over the note.
      if (slot) slot.outerHTML = '<div class="small muted">🎙 Recording deleted — the transcript and typed notes are kept.</div>';
      btn.remove();
      toast('Recording deleted', 'success', 2000);
    };
  });
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

function scoreCard(q, n, r, { readonly = false } = {}) {
  const answer = r?.answer;
  const head = `<div class="q-head"><span class="q-num">${n}</span>
    <div><div class="q-prompt">${esc(q.prompt)}</div>
      <div class="small muted" style="margin-top:5px"><span class="chip">${esc(q.type)}</span> <span class="chip">${esc(q.difficulty)}</span> <span class="chip">${esc(q.points)} pts</span>
      ${q.type !== 'text'
        ? '<span class="chip" style="background:var(--blue-bg);color:var(--blue)">auto-scored</span>'
        : readonly
          ? '<span class="chip" style="background:var(--blue-bg);color:var(--blue)">assessor-scored</span>'
          : '<span class="chip" style="background:var(--amber-bg);color:var(--amber)">needs your score</span>'}
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
    // The retention cleanup (and the manual delete) leave a marker instead of
    // an empty answer: without these notes a purged row would read exactly like
    // a question the candidate never answered.
    const sheetDeleted = ans.answer_deleted === true;
    const recordingDeleted = ans.recording_deleted === true;
    const textAns = sheetDeleted
      ? ''
      : [ans.text, ans.transcript && ans.transcript !== ans.text ? `\n\n[Transcript]\n${ans.transcript}` : ''].filter(Boolean).join('');
    // The clip itself is not in the detail payload (a whole-bank paper holds
    // ~10 MB of audio); `has_recording` marks a slot that loadRecordings()
    // fills from the per-question endpoint once the page is up.
    const hasRecording = !sheetDeleted && (ans.has_recording === true || Boolean(ans.audio_b64));
    const audioPlayer = hasRecording
      ? `<div class="exam-audio-slot" data-recording="${esc(q.id)}"><span class="small muted">Loading recording…</span></div>
        <div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" style="color:var(--red)" data-delete-recording="${esc(q.id)}" title="Permanently delete this recorded answer">🗑 Delete recording</button></div>`
      : (recordingDeleted && !sheetDeleted
        ? '<div class="small muted" style="margin-top:6px">🎙 The recording was deleted — the transcript and typed notes above are what remain.</div>'
        : '');
    const nothingSpoken = !hasRecording && !String(ans.transcript || '').trim();
    const spokenWarning = sheetDeleted || recordingDeleted
      ? ''
      : ans.audio_missing === true
        ? '<div class="small" style="margin-top:6px;color:var(--red);font-weight:700">⚠ No recording was submitted. Open questions require a spoken answer, so this is typed notes only — score accordingly and say so in the feedback.</div>'
        : (nothingSpoken && q.audio_required === true && String(ans.text || '').trim()
          ? '<div class="small" style="margin-top:6px;color:var(--amber);font-weight:700">⚠ No recording attached to this open answer.</div>'
          : '');
    // A blank open answer carries how it came about: the clock ran out, the
    // candidate moved on, the retention policy removed the material, or the
    // assessor deleted the clip. Say which, so the assessor is not left
    // guessing from an empty box.
    const blankNote = sheetDeleted
      ? `— answer sheet deleted by ${ans.deleted_reason === 'manual' ? 'the assessor' : 'the retention policy'} on ${fmtDate(ans.answer_deleted_at)} —`
      : (!textAns && !hasRecording && !recordingDeleted
        ? (ans.source === 'timed_out' ? '— no answer · time expired —' : ans.source === 'skipped' ? '— no answer · question skipped —' : '— no answer —')
        : '');
    answerBlock = `
      <blockquote class="answer">${textAns ? esc(textAns) : `<span class="muted">${esc(blankNote)}</span>`}</blockquote>
      ${audioPlayer}
      ${spokenWarning}
      ${ans.source === 'audio' && !sheetDeleted ? '<div class="small muted" style="margin-top:6px">Submitted via audio (transcribed).</div>' : ''}
      <details class="fold" style="margin-top:10px"><summary>📋 Scoring rubric (expected evidence)</summary>
        <div class="rubric" style="margin-top:8px">${esc(q.rubric || 'No rubric configured.')}</div></details>
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <label class="f" style="margin:0"><span class="lbl">Your score (0-${esc(q.points)})</span>
          <input type="number" class="score-input" id="score-${esc(q.id)}" min="0" max="${esc(q.points)}" step="0.5" value="${esc(r?.assessor_score ?? '')}" ${readonly ? 'disabled' : ''}/></label>
        <label class="f" style="margin:0;flex:1"><span class="lbl">Feedback for the report (internal)</span>
          <input type="text" id="comment-${esc(q.id)}" value="${esc(r?.assessor_comment || '')}" placeholder="Why this score? Not shown to the candidate." ${readonly ? 'disabled' : ''}/></label>
      </div>`;
  }
  return `<div class="q-card">${head}${answerBlock}</div>`;
}
