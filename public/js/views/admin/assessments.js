import { api, apiAll } from '../../api.js';
import { esc, fmtDate, fmtDateTime, badge, dataTable, loading, emptyState, toast, attempt, formModal, confirmModal, assessmentStatusBadge, readinessBadge, integrityRiskBadge, integrityRiskPanel } from '../../ui.js';
import { renderReport } from '../report.js';
import { M } from './shared.js';
import { retentionCell, retentionLine } from './settings.js';
import { questionScope } from './question-bank.js';

/** Assessments: list, report and integrity trail. */
export async function assessmentsView(view) {
  view.innerHTML = loading();
  const urlStatus = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  // Always fetch the full list so the status pills keep truthful counts while a
  // filter is active (filtering server-side made every other pill read 0).
  const [all, users] = await Promise.all([apiAll('/admin/assessments', 'assessments'), apiAll('/admin/users', 'users')]);
  const assessments = urlStatus ? all.filter((a) => a.status === urlStatus) : all;
  const assessors = users.filter((u) => u.role === 'assessor' && u.active !== false);
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Evaluation operations</div><h1>Assessments</h1><p>Allocations, submissions and outcomes.</p></div>
    </div>
    <div class="card flat toolbar-card">
      <div class="toolbar-label"><span class="toolbar-icon">◷</span><span>Assessment status</span></div>
      <div class="pill-row filter-pills">
        <a href="#/assessments" class="chip ${!urlStatus ? 'selected' : ''}">All <b>${all.length}</b></a>
        ${M().assessmentStatuses.map((s) => `<a href="#/assessments?status=${s.key}" class="chip ${urlStatus === s.key ? 'selected' : ''}">${esc(s.label)} <b>${all.filter((a) => a.status === s.key).length}</b></a>`).join('')}
      </div>
    </div>
    <div class="card table-card">
      ${assessments.length ? dataTable([
        { label: 'Candidate', render: (a) => `<a href="#/candidates/${a.candidate_id}"><b>${esc(a.candidate_name)}</b></a>` },
        { label: 'Role', render: (a) => esc(a.role_name) },
        { label: 'Assessor', render: (a) => a.assessor_name ? esc(a.assessor_name) : '<span class="muted">unassigned</span>' },
        { label: 'Questions', render: (a) => questionScope(a) },
        { label: 'Integrity', render: (a) => integrityBadge(a) },
        { label: 'Status', render: (a) => assessmentStatusBadge(M().assessmentStatuses, a.status) },
        { label: 'Outcome', render: (a) => a.overall_pct != null ? `<b>${a.overall_pct}%</b> ${readinessBadge(a.readiness_key, a.readiness_label)}` : '<span class="muted">—</span>' },
        { label: 'Created', render: (a) => `<span class="small muted">${esc(fmtDate(a.created_at))}</span>` },
        // Whether the answer sheet / recordings behind a scored paper are
        // still stored, and when the retention cleanup will take them.
        { label: 'Evidence', render: (a) => retentionCell(a.retention) },
        { label: '', cls: 'actions', render: (a) => `
            <a class="btn ghost sm" href="#/assessments/${a.id}/integrity">Integrity</a>
            ${['scored', 'validated'].includes(a.status) ? `<a class="btn ghost sm" href="#/assessments/${a.id}/report">Report</a>` : ''}
            ${['assigned', 'in_progress', 'submitted'].includes(a.status) ? `<button class="btn ghost sm" data-re="${a.id}">Reassign</button>` : ''}
            ${['assigned', 'in_progress'].includes(a.status) ? `<button class="btn ghost sm" style="color:var(--red)" data-del="${a.id}">Delete</button>` : ''}` },
      ], assessments) : emptyState('No assessments', 'Allocate an assessment from a candidate or the Candidates page.')}
    </div>`;
  view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const yes = await confirmModal('Delete assessment', 'Delete this not-yet-submitted assessment and its draft answers?', 'Delete', true);
    if (!yes) return;
    await attempt(() => api(`/admin/assessments/${b.dataset.del}`, { method: 'DELETE' }), { okMessage: 'Assessment deleted' });
    assessmentsView(view);
  }));
  view.querySelectorAll('[data-re]').forEach((b) => (b.onclick = async () => {
    const a = all.find((x) => x.id === b.dataset.re);
    const saved = await formModal({
      title: `Reassign assessor · ${a.candidate_name}`,
      fields: [{ name: 'assessor_id', label: 'Assessor', type: 'select', allowEmpty: false, options: assessors.map((u) => ({ value: u.id, label: u.name })) }],
      values: { assessor_id: a.assessor_id || '' },
      onSubmit: (vals) => api(`/admin/assessments/${a.id}`, { method: 'PATCH', body: { assessor_id: vals.assessor_id || null } }),
    });
    if (!saved) return;
    toast('Assessor updated', 'success');
    assessmentsView(view);
  }));
}

export async function reportView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/admin/reports/${id}`);
  renderReport(view, { ...d, audience: 'admin' });
  // Whether the evidence behind this report (answer sheet, transcripts,
  // recordings) is still stored, and when the cleanup will remove it.
  if (d.integrity_risk) {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'report-integrity';
    card.innerHTML = integrityRiskPanel(d.integrity_risk, { href: `#/assessments/${id}/integrity` });
    view.querySelector('.report-document')?.prepend(card);
  }
  const note = retentionLine(d.retention);
  if (note) {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'report-retention';
    card.innerHTML = `<div class="small muted">🗂 ${note}</div>`;
    view.querySelector('.report-document')?.prepend(card);
  }
}

/** Compact form of `retentionLine` for the assessments table. */

function integrityBadge(a) {
  const n = Number(a.integrity_count || 0);
  const risk = n && a.integrity_risk ? `<div style="margin-top:4px">${integrityRiskBadge(a.integrity_risk, { href: `#/assessments/${a.id}/integrity` })}</div>` : '';
  if (!n) return badge('0', 'grey');
  const severe = integrityTone(a.last_integrity_event) === 'red';
  return `<a href="#/assessments/${esc(a.id)}/integrity" style="text-decoration:none">${badge(`${n}`, severe ? 'red' : 'amber')} <span class="small muted">${esc(a.last_integrity_event || 'events')}</span></a>${risk}`;
}

const INTEGRITY_EVENT_TONE = {
  tab_switch: 'red', browser_close: 'red', exam_exit: 'red', exam_reopen: 'red',
  multi_window: 'red', devtools_key: 'red', devtools_resize: 'red',
  paste_attempt: 'amber', copy_attempt: 'amber', cut_attempt: 'amber',
  // `copy` is copying exam content outside an answer field (the in-field
  // attempt is `copy_attempt`); `paste` is the name older clients logged a
  // blocked paste under. Both were grey, as if routine.
  copy: 'amber', paste: 'amber',
  screenshot: 'red', fullscreen_exit: 'red', contextmenu: 'amber',
  // Logged by the API when an open question is locked without a recording.
  spoken_answer_missing: 'amber',
  // Logged by the API when a question window ran out (auto-advanced / blank).
  time_expired: 'amber',
  // Logged by the API's one-device rule.
  device_switch: 'red', ip_change: 'amber',
};
/**
 * Tone for an event name. Own keys only: event names come from the
 * candidate's browser, so `TONE["constructor"]` must be "grey", not a function
 * stringified into a class attribute.
 */
const integrityTone = (event) => (typeof event === 'string' && Object.hasOwn(INTEGRITY_EVENT_TONE, event)
  ? INTEGRITY_EVENT_TONE[event]
  : 'grey');

/**
 * The integrity tiles, each the sum of the counters it names. Every counter the
 * API keeps (INTEGRITY_EVENT_KEYS in src/api/quiz-session.mjs) belongs to
 * exactly one tile, except the two routine ones (the exam starting, the
 * candidate returning to the tab), which only the headline total includes.
 * The grid used to leave out copy, paste, screenshot, right-click and every
 * unrecognised event, so a trail could read "0" on every copy tile while the
 * headline counted the copies. `blur` and `visibility` are the names older
 * clients logged the window-blur and tab-switch signals under.
 */
const INTEGRITY_TILES = [
  { label: 'Tab switches', keys: ['tab_switch', 'visibility'] },
  { label: 'Window blur / browser close', keys: ['window_blur', 'blur', 'browser_close'] },
  { label: 'Exit / reopen exam', keys: ['exam_exit', 'exam_reopen'] },
  { label: 'Copy / paste / devtools', keys: ['copy', 'copy_attempt', 'cut_attempt', 'paste', 'paste_attempt', 'devtools_key', 'devtools_resize'] },
  { label: 'Fullscreen exit', keys: ['fullscreen_exit'] },
  { label: 'Multi-window', keys: ['multi_window'] },
  { label: 'Device / network changes', keys: ['device_switch', 'ip_change'] },
  { label: 'Open answers locked without a recording', keys: ['spoken_answer_missing'] },
  { label: 'Questions timed out', keys: ['time_expired'] },
  { label: 'Screenshot / right-click / other', keys: ['screenshot', 'contextmenu', 'other'] },
];
const counterSum = (counters, keys) => keys.reduce((sum, k) => sum + (Number(counters[k]) || 0), 0);

export async function integrityView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/admin/assessments/${id}/integrity`);
  const counters = d.integrity || {};
  const total = Object.values(counters).reduce((s, v) => s + Number(v || 0), 0);
  const severeEvents = (d.events || []).filter((e) => integrityTone(e.event) === 'red').length;
  view.innerHTML = `
    <div class="card" style="padding:12px 18px"><a class="btn ghost sm" href="#/assessments">← All assessments</a></div>
    <div class="card">
      <div class="row between">
        <div><div class="section-kicker">Proctoring / integrity trail</div><h2 style="margin:0">${esc(d.candidate?.name || 'Candidate')} · ${esc(d.assessment.id)}</h2>
          <div class="small muted" style="margin-top:5px">Status: ${esc(d.assessment.status)} · Started ${d.assessment.started_at ? esc(fmtDateTime(d.assessment.started_at)) : '—'}</div></div>
        <div class="row">${badge(`${total} event${total === 1 ? '' : 's'}`, total ? 'amber' : 'green')}${severeEvents ? badge(`${severeEvents} severe`, 'red') : badge('no severe events', 'green')}</div>
      </div>
      ${integrityRiskPanel(d.integrity_risk)}
      <div class="grid cols-3 metric-grid" style="margin-top:16px">
        ${INTEGRITY_TILES.map((tile) => `<div class="stat"><div class="lbl">${esc(tile.label)}</div><div class="num">${counterSum(counters, tile.keys)}</div></div>`).join('')}
      </div>
    </div>
    <div class="card table-card">
      <h3 style="margin:0 0 10px">Event history</h3>
      ${(d.events || []).length ? dataTable([
        { label: 'When', render: (e) => `<span class="small muted">${esc(fmtDateTime(e.at))}</span>` },
        { label: 'Event', render: (e) => badge(e.event, integrityTone(e.event)) },
        { label: 'Question', render: (e) => e.question_index != null ? `Q${Number(e.question_index) + 1}` : '<span class="muted">—</span>' },
        { label: 'Detail', render: (e) => `<span class="small">${esc(e.detail || '—')}</span>` },
      ], d.events) : emptyState('No integrity events yet', 'Tab switch, blur, copy, paste, devtools, exit/reopen and window events are logged here.')}
    </div>`;
}

/* ================================ Roles & frameworks ================================ */
/**
 * Add a published track to the workspace (or top an installed one up) and
 * report what happened. Shared by the Roles screen and the Question Bank
 * strip: both offer the same action for a track that shipped after the
 * workspace was seeded. Resolves to the API result, or null on failure.
 */
