import { api } from '../../api.js';
import { esc, fmtDate, fmtDateTime, loading, toast, attempt, confirmModal } from '../../ui.js';

/** Settings: answer-sheet and recording retention. */
export function retentionCell(ret) {
  if (!ret || ret.state === 'untracked') return '<span class="small muted">—</span>';
  if (ret.state === 'purged') return `<span class="small muted" title="Deleted by the retention policy">deleted ${esc(fmtDate(ret.purged_at))}</span>`;
  if (ret.state === 'off') return '<span class="small muted">kept</span>';
  if (ret.state === 'due') return '<span class="small" style="color:var(--amber);font-weight:700">due for cleanup</span>';
  return `<span class="small muted">${ret.days_left} d left</span>`;
}

/** One sentence for the admin screens about a paper's stored evidence. */
export function retentionLine(ret) {
  if (!ret) return '';
  if (ret.state === 'purged') {
    const what = [ret.purged?.answer_sheets ? 'answer sheet' : '', ret.purged?.recordings ? 'recordings' : '']
      .filter(Boolean).join(' and ') || 'answer sheet and recordings';
    return `The ${what} of this assessment were deleted by the retention policy on ${esc(fmtDate(ret.purged_at))}. The report keeps every prompt, score and comment.`;
  }
  if (ret.state === 'off') return 'Automatic cleanup is off: the answer sheet, transcripts and recordings are kept indefinitely.';
  if (ret.due_at) {
    const days = ret.days_left;
    return `Answer sheet, transcripts and recordings are kept and will be deleted by the retention cleanup on ${esc(fmtDate(ret.due_at))}${days == null ? '' : ` (in ${days} day${days === 1 ? '' : 's'})`}.`;
  }
  return '';
}

/* ================================ Settings ================================ */
/**
 * Platform settings. Today: how long the raw material of a finished assessment
 * — the answer sheet (typed notes, transcripts, and the objective answers when
 * the scope is "all") and the recorded clips — is kept after its report was
 * generated. Default 30 days; the cleanup itself and every read path live in
 * src/core/retention.mjs + src/api/retention-service.mjs.
 */
export async function settingsView(view) {
  view.innerHTML = loading();
  const d = await api('/admin/settings/retention');
  const s = d.settings;
  const st = d.status || {};
  const dayLabel = (n) => `${n} day${n === 1 ? '' : 's'}`;
  // What the policy currently means, in words — the form alone can be skimmed,
  // and "recordings off" is easy to miss among three inputs.
  const deleting = [s.auto_delete_answer_sheets && 'answer sheets', s.auto_delete_recordings && 'recordings'].filter(Boolean);
  const summary = `${st.finalized_papers || 0} finalized paper${(st.finalized_papers || 0) === 1 ? '' : 's'} · `
    + `${st.due_now || 0} due for cleanup now · ${st.purged_papers || 0} already cleaned`
    + ` · keeping evidence for ${dayLabel(s.days)}${deleting.length
      ? `, then deleting ${deleting.join(' + ')}${s.auto_delete_answer_sheets && s.scope === 'open' ? ' (open answers only)' : ''}`
      : ' (nothing is auto-deleted)'}`
    + (st.next_due_at ? ` · next on ${esc(fmtDate(st.next_due_at))}` : '');
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Platform configuration</div><h1>Settings</h1>
      <p>Data retention and platform-wide defaults.</p></div>
      <div class="heading-actions"><a class="btn ghost" href="#/assessments">View assessments</a></div>
    </div>
    ${d.provisioned === false ? `<div class="card attention-card"><span class="attention-icon">!</span><span><b>Saving is unavailable on this backend.</b>
      <small>${esc(d.detail || 'The settings table is missing.')}</small></span></div>` : ''}
    <div class="card">
      <div class="panel-head"><div><h2>Answer sheet &amp; recording retention</h2>
        <p>After a report is generated, the candidate's answers, transcripts and recordings stay reviewable by
        their assessor and by admins. They are then deleted automatically — the report card itself
        (marks, feedback, gaps) is never touched.</p></div></div>
      <form id="retention-form">
        <div class="f-row-3">
          <label class="f"><span class="lbl">Keep for (days)</span>
            <input type="number" id="ret-days" min="0" max="3650" step="1" value="${esc(s.days)}"/>
            <span class="help muted small">Counted from the moment the report is generated. 0 = delete at the next cleanup. Default ${esc(d.defaults?.days ?? 30)}.</span></label>
          <label class="f"><span class="lbl">Answers to delete</span>
            <select id="ret-scope">
              <option value="all" ${s.scope === 'all' ? 'selected' : ''}>All answers (objective + open)</option>
              <option value="open" ${s.scope === 'open' ? 'selected' : ''}>Open answers only (keep MCQ / scale)</option>
            </select>
            <span class="help muted small">Used when answer sheets are deleted.</span></label>
          <div class="f"><span class="lbl">Auto-delete</span>
            <label class="check"><input type="checkbox" id="ret-sheets" ${s.auto_delete_answer_sheets ? 'checked' : ''}/> <span>Answer sheets (notes, transcripts${s.scope === 'all' ? ', objective answers' : ''})</span></label>
            <label class="check" style="margin-top:6px"><input type="checkbox" id="ret-recordings" ${s.auto_delete_recordings ? 'checked' : ''}/> <span>Spoken-answer recordings</span></label>
          </div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn" type="submit" ${d.provisioned === false ? 'disabled' : ''}>Save retention policy</button>
          <button class="btn secondary" type="button" id="ret-run" ${d.provisioned === false ? 'disabled' : ''}>Run cleanup now</button>
        </div>
      </form>
      <div class="small muted" id="ret-status" style="margin-top:12px">
        ${summary}${d.updated_at ? ` · last changed ${esc(fmtDateTime(d.updated_at))}${d.updated_by_name ? ` by ${esc(d.updated_by_name)}` : ''}` : ''}
      </div>
    </div>
    <div class="card">
      <div class="panel-head"><div><h2>How the cleanup works</h2></div></div>
      <div class="small muted">
        <p style="margin-top:0">The clock starts when the report is generated — a paper still waiting for its assessor is never touched.</p>
        <p>Each run clears up to ${esc(st.sweep_limit ?? 25)} papers and removes only the raw material: it keeps every
        score on the response rows and the whole report card. An entry is written to the audit log for each paper.</p>
        <p style="margin-bottom:0">Runs start from this screen, the dashboard and the assessments list (there is no scheduler
        in this deployment), so the policy is applied the next time someone opens one of them. Assessors can also delete a
        single recording by hand from a paper's answer sheet.</p>
      </div>
    </div>`;

  const readForm = () => ({
    days: Number(view.querySelector('#ret-days').value),
    scope: view.querySelector('#ret-scope').value,
    auto_delete_answer_sheets: view.querySelector('#ret-sheets').checked,
    auto_delete_recordings: view.querySelector('#ret-recordings').checked,
  });
  view.querySelector('#retention-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = await attempt(() => api('/admin/settings/retention', { method: 'PUT', body: readForm() }), { okMessage: 'Retention policy saved' });
    if (out) settingsView(view);
  };
  view.querySelector('#ret-run').onclick = async () => {
    const yes = await confirmModal('Run cleanup now',
      `Delete the answer sheets and recordings of every finalized paper that has passed the ${dayLabel(Number(view.querySelector('#ret-days').value))} window? The report cards are kept.`,
      'Run cleanup', true);
    if (!yes) return;
    const out = await attempt(() => api('/admin/retention/run', { method: 'POST' }));
    if (!out) return;
    toast(out.purged
      ? `Cleanup finished: ${out.purged} paper(s), ${out.rows} answer row(s), ${out.clips} recording(s)`
      : 'Nothing was due for cleanup', out.purged ? 'success' : 'info', 5000);
    settingsView(view);
  };
}

/* ============================== Integrity / anti-cheat trail ============================== */
