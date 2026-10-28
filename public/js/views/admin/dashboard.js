import { api } from '../../api.js';
import { esc, fmtDateTime, badge, loading } from '../../ui.js';
import { bookingTable, createBookingLink } from '../bookings.js';
import { M } from './shared.js';

/** Dashboard: pipeline counts and upcoming tests. */
const DASHBOARD_ICONS = {
  candidates: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M3.8 19c.4-3.1 2.1-4.7 5.2-4.7s4.8 1.6 5.2 4.7"></path><path d="M16 5.4a3 3 0 0 1 0 5.7M17 14.6c2.1.5 3.3 2 3.5 4.4"></path></svg>',
  ready: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"></path><circle cx="12" cy="12" r="8"></circle></svg>',
  active: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.8h8l3 3V20H7z"></path><path d="M15 3.8V7h3M10 11h5M10 14.5h5M10 18h3"></path></svg>',
  score: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5"></path><path d="M4 19h16"></path><path d="m7 15 3-3 3 2 5-7"></path><path d="M16 7h2v2"></path></svg>',
};

/* ================================ Dashboard ================================ */
export async function dashboardView(view) {
  view.innerHTML = loading();
  const d = await api('/admin/dashboard');
  const stages = M().pipelineStages;
  const maxStage = Math.max(1, ...Object.values(d.by_stage));
  const awaiting = d.by_status.submitted || 0;
  view.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="eyebrow">Platform overview</div>
        <h1>Capability pipeline</h1>
        <p>Candidates, assessments and average scored results.</p>
      </div>
      <div class="heading-actions"><button class="btn secondary" id="dashboard-booking-link">Create booking link</button><a class="btn" href="#/candidates">＋ Add candidate</a></div>
    </div>
    <div class="grid cols-4 metric-grid">
      <div class="stat"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.candidates}</span></div><div class="num">${d.counts.candidates}</div><div class="lbl">Candidates in pipeline</div></div>
      <div class="stat stat-gold"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.ready}</span></div><div class="num">${d.counts.enterprise_ready}</div><div class="lbl">Enterprise-ready</div></div>
      <div class="stat stat-blue"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.active}</span></div><div class="num">${d.counts.active_assessments}</div><div class="lbl">Active assessments</div></div>
      <div class="stat stat-violet"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.score}</span></div><div class="num">${d.counts.avg_score ?? '—'}${d.counts.avg_score != null ? '%' : ''}</div><div class="lbl">Average scored result</div></div>
    </div>
    <div class="card" id="upcoming-tests"><div class="panel-head"><div><h2>Upcoming tests (${d.counts.upcoming_tests ?? 0})</h2><p>Candidate-booked slots · India Standard Time (IST)</p></div><a class="btn ghost sm" href="#/bookings">View all bookings →</a></div>${bookingTable(d.upcoming_tests || [])}</div>
    <div class="dashboard-grid">
      <div class="card pipeline-panel">
        <div class="panel-head"><div><h2>Pipeline health</h2><p>Candidate volume by readiness stage</p></div><a class="btn ghost sm" href="#/candidates">View all <span aria-hidden="true">→</span></a></div>
        <div class="stage-bars">
          ${stages.map((s) => `<div class="bar-row">
            <div class="small" style="font-weight:700">${esc(s.label)}</div>
            <div class="track"><div class="fill" style="width:${Math.round(((d.by_stage[s.key] || 0) / maxStage) * 100)}%"></div></div>
            <div class="small" style="text-align:right;font-weight:800">${d.by_stage[s.key] || 0}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="dashboard-side">
        <div class="card status-panel">
          <div class="panel-head"><div><h2>Assessment status</h2></div></div>
          <div class="status-list">
            ${M().assessmentStatuses.map((s) => `<a class="status-row" href="#/assessments?status=${s.key}"><span>${badge(s.label, s.tone)}</span><strong>${d.by_status[s.key] || 0}</strong><span class="status-arrow">→</span></a>`).join('')}
          </div>
          ${awaiting > 0 ? `<div class="action-callout"><span>!</span><span><b>${awaiting} assessment${awaiting === 1 ? '' : 's'}</b> awaiting scoring</span><a href="#/assessments?status=submitted">Review</a></div>` : ''}
        </div>
        <div class="card activity-panel">
          <div class="panel-head"><div><h2>Recent activity</h2></div></div>
          ${d.recent_activity.length ? `<div class="activity-list">
            ${d.recent_activity.slice(0, 6).map((e) => `<div class="activity-item"><span class="activity-dot"></span><div><div class="small activity-message">${esc(e.message || e.action)}</div><div class="muted" style="font-size:10px">${esc(e.actor_name)} · ${esc(fmtDateTime(e.created_at))}</div></div></div>`).join('')}
          </div>` : `<div class="muted small">No activity yet.</div>`}
        </div>
      </div>
    </div>`;
  view.querySelector('#dashboard-booking-link').onclick = () => createBookingLink(() => dashboardView(view));
}

/* ================================ Candidates ================================ */
