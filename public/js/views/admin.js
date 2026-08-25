import { api } from '../api.js';
import { state } from '../app.js';
import {
  esc, fmtDate, fmtDateTime, badge, dataTable, loading, emptyState, toast, attempt,
  formModal, confirmModal, pipelineStepper, stageBadge, assessmentStatusBadge, readinessBadge,
  num, pct, modal,
} from '../ui.js';
import { renderReport } from './report.js';

const M = () => state.meta;

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
        <h1>Capability pipeline<span class="heading-dot">.</span></h1>
        <p>See how your talent pool is moving from first conversation to enterprise-ready.</p>
      </div>
      <div class="heading-actions"><a class="btn" href="#/candidates">＋ Add candidate</a></div>
    </div>
    <div class="grid cols-4 metric-grid">
      <div class="stat"><div class="stat-top"><span class="stat-icon">♧</span><span class="stat-trend">Live</span></div><div class="num">${d.counts.candidates}</div><div class="lbl">Candidates in pipeline</div></div>
      <div class="stat stat-gold"><div class="stat-top"><span class="stat-icon">✦</span><span class="stat-trend">Ready</span></div><div class="num">${d.counts.enterprise_ready}</div><div class="lbl">Enterprise-ready</div></div>
      <div class="stat stat-blue"><div class="stat-top"><span class="stat-icon">↗</span><span class="stat-trend">Active</span></div><div class="num">${d.counts.active_assessments}</div><div class="lbl">Active assessments</div></div>
      <div class="stat stat-violet"><div class="stat-top"><span class="stat-icon">◌</span><span class="stat-trend">${d.counts.avg_score != null ? 'Scored' : 'Awaiting'}</span></div><div class="num">${d.counts.avg_score ?? '—'}${d.counts.avg_score != null ? '%' : ''}</div><div class="lbl">Average scored result</div></div>
    </div>
    <div class="dashboard-grid">
      <div class="card pipeline-panel">
        <div class="panel-head"><div><div class="section-kicker">Talent movement</div><h2>Pipeline health</h2><p>Candidate volume by readiness stage</p></div><a class="btn ghost sm" href="#/candidates">View all <span aria-hidden="true">→</span></a></div>
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
          <div class="panel-head"><div><div class="section-kicker">Workflow pulse</div><h2>Assessment status</h2></div><span class="panel-orb">↗</span></div>
          <div class="status-list">
            ${M().assessmentStatuses.map((s) => `<a class="status-row" href="#/assessments?status=${s.key}"><span>${badge(s.label, s.tone)}</span><strong>${d.by_status[s.key] || 0}</strong><span class="status-arrow">→</span></a>`).join('')}
          </div>
          ${awaiting > 0 ? `<div class="action-callout"><span>!</span><span><b>${awaiting} assessment${awaiting === 1 ? '' : 's'}</b> awaiting scoring</span><a href="#/assessments?status=submitted">Review</a></div>` : ''}
        </div>
        <div class="card activity-panel">
          <div class="panel-head"><div><div class="section-kicker">Latest updates</div><h2>Recent activity</h2></div><span class="panel-orb muted">•••</span></div>
          ${d.recent_activity.length ? `<div class="activity-list">
            ${d.recent_activity.slice(0, 6).map((e) => `<div class="activity-item"><span class="activity-dot"></span><div><div class="small activity-message">${esc(e.message || e.action)}</div><div class="muted" style="font-size:10px">${esc(e.actor_name)} · ${esc(fmtDateTime(e.created_at))}</div></div></div>`).join('')}
          </div>` : `<div class="muted small">No activity yet.</div>`}
        </div>
      </div>
    </div>`;
}

/* ================================ Candidates ================================ */
const candidateFields = (roles) => [
  { name: 'name', label: 'Full name', required: true },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'current_title', label: 'Current title' },
  { name: 'years_experience', label: 'Years of experience', type: 'number', min: 0, max: 50 },
  { name: 'location', label: 'Location' },
  { name: 'source', label: 'Source', placeholder: 'Referral, partner, inbound…' },
  { name: 'target_role_id', label: 'Target role (assessment track)', type: 'select', options: roles.map((r) => ({ value: r.id, label: r.name })) },
  { name: 'stage', label: 'Pipeline stage', type: 'select', options: M().pipelineStages.map((s) => ({ value: s.key, label: s.label })), allowEmpty: false },
  { name: 'notes', label: 'Internal notes', type: 'textarea', rows: 3, help: 'Visible to admins only — never to assessors or the candidate.' },
];

export async function candidatesView(view) {
  view.innerHTML = loading();
  const [{ candidates }, { roles }] = await Promise.all([api('/admin/candidates'), api('/admin/roles')]);
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Talent directory</div><h1>Candidates<span class="heading-dot">.</span></h1><p>Keep every candidate, conversation and next step in one calm view.</p></div>
      <div class="heading-actions"><button class="btn" id="add-cand">＋ Add candidate</button></div>
    </div>
    <div class="card flat toolbar-card">
      <div class="toolbar-label"><span class="toolbar-icon">⌕</span><span>Filter talent</span></div>
      <div class="row toolbar-fields">
        <input type="search" id="cand-q" placeholder="Search name or email…" aria-label="Search candidates" />
        <select id="cand-stage" aria-label="Filter by pipeline stage"><option value="">All stages</option>${M().pipelineStages.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select>
      </div>
      <span class="toolbar-hint">${candidates.length} profile${candidates.length === 1 ? '' : 's'} in your directory</span>
    </div>
    <div class="card table-card" id="cand-list"></div>`;

  const renderList = (rows) => {
    const el = view.querySelector('#cand-list');
    if (!rows.length) { el.innerHTML = emptyState('No candidates match', 'Add your first candidate or adjust the filters.'); return; }
    el.innerHTML = dataTable([
      { label: 'Candidate', render: (c) => `<a href="#/candidates/${c.id}"><b>${esc(c.name)}</b></a><div class="small muted">${esc(c.current_title || '')}${c.years_experience != null ? ` · ${c.years_experience} yrs` : ''}</div>` },
      { label: 'Target role', render: (c) => c.role_name ? esc(c.role_name) : '<span class="muted">—</span>' },
      { label: 'Stage', render: (c) => stageBadge(M().pipelineStages, c.stage) },
      { label: 'Source', render: (c) => esc(c.source || '—') },
      { label: 'Added', render: (c) => `<span class="small muted">${esc(fmtDate(c.created_at))}</span>` },
      { label: '', cls: 'actions', render: (c) => `
        <button class="btn ghost sm" data-act="edit" data-id="${c.id}">Edit</button>
        <button class="btn ghost sm" data-act="alloc" data-id="${c.id}">Allocate</button>
        <button class="btn ghost sm" style="color:var(--red)" data-act="del" data-id="${c.id}">Delete</button>` },
    ], rows);
    el.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = () => candidateAction(b.dataset.act, rows.find((r) => r.id === b.dataset.id), roles)));
  };
  renderList(candidates);

  const refilter = async () => {
    const q = view.querySelector('#cand-q').value, stage = view.querySelector('#cand-stage').value;
    const d = await attempt(() => api(`/admin/candidates?q=${encodeURIComponent(q)}&stage=${encodeURIComponent(stage)}`));
    if (d) renderList(d.candidates);
  };
  view.querySelector('#cand-q').oninput = debounce(refilter, 350);
  view.querySelector('#cand-stage').onchange = refilter;
  view.querySelector('#add-cand').onclick = async () => {
    const vals = await formModal({ title: 'Add candidate', fields: candidateFields(roles), values: { stage: 'intake' } });
    if (!vals) return;
    await attempt(() => api('/admin/candidates', { method: 'POST', body: vals }), { okMessage: 'Candidate added' });
    candidatesView(view);
  };
}

async function candidateAction(act, c, roles) {
  if (!c) return;
  if (act === 'edit') {
    const vals = await formModal({ title: `Edit ${c.name}`, fields: candidateFields(roles), values: c });
    if (!vals) return;
    await attempt(() => api(`/admin/candidates/${c.id}`, { method: 'PATCH', body: vals }), { okMessage: 'Candidate updated' });
    refresh();
  } else if (act === 'alloc') {
    await allocateAssessorModal(c);
  } else if (act === 'del') {
    await deleteCandidateFlow(c);
  }
}

/**
 * Password-gated permanent delete: confirm intent, then require the admin's
 * password. The server cascades over the linked portal login and any open
 * assessments; candidates with finalized reports are protected (409).
 * `goBack` navigates to the list afterwards (used from the detail page).
 */
async function deleteCandidateFlow(c, { goBack = false } = {}) {
  const yes = await confirmModal(
    'Delete candidate',
    `Permanently delete "${c.name}"? This also removes their portal login and any open (not yet scored) assessments. Candidates with finalized reports cannot be deleted.`,
    'Continue', true);
  if (!yes) return;
  const auth = await formModal({
    title: `Confirm deletion · ${c.name}`,
    submitLabel: 'Delete permanently',
    fields: [{
      name: 'password', label: 'Admin password', type: 'password', required: true,
      help: 'This action is permanent and requires your admin password.',
    }],
  });
  if (!auth) return;
  const out = await attempt(
    () => api(`/admin/candidates/${c.id}`, { method: 'DELETE', body: { password: auth.password } }),
    { okMessage: `Candidate "${c.name}" deleted` });
  if (!out) return;
  if (goBack) location.hash = '#/candidates';
  else refresh();
}

export async function allocateAssessorModal(c, presetRoleId) {
  const [{ roles }, { users }] = await Promise.all([api('/admin/roles'), api('/admin/users')]);
  const assessors = users.filter((u) => u.role === 'assessor' && u.active);
  const activeRoles = roles.filter((r) => r.active !== false);
  if (!activeRoles.length) { toast('Create an assessment track (role) with questions first.', 'error'); return; }
  if (!assessors.length) { toast('Create an assessor user first (Users & Access).', 'error'); return; }
  const vals = await formModal({
    title: `Allocate assessment · ${c.name}`,
    fields: [
      { name: 'role_id', label: 'Role / track', type: 'select', required: true, allowEmpty: false, options: activeRoles.map((r) => ({ value: r.id, label: `${r.name} (${r.question_count} questions)` })) },
      { name: 'assessor_id', label: 'Assessor', type: 'select', allowEmpty: false, options: assessors.map((u) => ({ value: u.id, label: u.name })) },
    ],
    values: { role_id: presetRoleId || c.target_role_id || activeRoles[0].id },
    submitLabel: 'Allocate',
  });
  if (!vals) return;
  await attempt(() => api('/admin/assessments', { method: 'POST', body: { candidate_id: c.id, role_id: vals.role_id, assessor_id: vals.assessor_id || null } }),
    { okMessage: 'Assessment allocated' });
  refresh();
}

export async function candidateDetailView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/admin/candidates/${id}`);
  const c = d.candidate;
  const stages = M().pipelineStages;
  view.innerHTML = `
    <div class="card" style="padding:12px 18px"><a class="btn ghost sm" href="#/candidates">← All candidates</a></div>
    <div class="row" style="align-items:flex-start">
      <div style="flex:1.2">
        <div class="card">
          <div class="row between">
            <div><h2 style="margin:0">${esc(c.name)}</h2>
              <div class="muted small">${esc(c.current_title || '')}${c.years_experience != null ? ` · ${c.years_experience} yrs experience` : ''}</div></div>
            <div class="row">
              <button class="btn secondary sm" id="edit">Edit</button>
              <button class="btn sm" id="alloc">Allocate assessment</button>
              <button class="btn ghost sm" id="del" style="color:var(--red)">Delete</button>
            </div>
          </div>
          <hr class="hr"/>
          <div class="grid cols-2 small" style="gap:6px 26px">
            <div><span class="muted">Email:</span> ${esc(c.email || '—')}</div>
            <div><span class="muted">Phone:</span> ${esc(c.phone || '—')}</div>
            <div><span class="muted">Location:</span> ${esc(c.location || '—')}</div>
            <div><span class="muted">Source:</span> ${esc(c.source || '—')}</div>
            <div><span class="muted">Target role:</span> ${esc(d.role_name || '—')}</div>
            <div><span class="muted">Portal login:</span> ${d.linked_user ? `<code>${esc(d.linked_user.username)}</code>` : '<span class="muted">not provisioned — create under Users & Access</span>'}</div>
          </div>
          ${c.notes ? `<hr class="hr"/><div class="small"><span class="muted">Internal notes:</span><br/>${esc(c.notes)}</div>` : ''}
        </div>
        <div class="card">
          <h3>Assessments</h3>
          ${d.assessments.length ? dataTable([
            { label: 'Role', render: (a) => esc(a.role_name) },
            { label: 'Assessor', render: (a) => esc(a.assessor_name || '—') },
            { label: 'Status', render: (a) => assessmentStatusBadge(M().assessmentStatuses, a.status) },
            { label: 'Score', render: (a) => a.overall_pct != null ? `<b>${a.overall_pct}%</b> ${readinessBadge(a.readiness_key, a.readiness_label)}` : '—' },
            { label: '', cls: 'actions', render: (a) => ['scored', 'validated'].includes(a.status) ? `<a class="btn ghost sm" href="#/assessments/${a.id}/report">Report</a>` : '' },
          ], d.assessments) : emptyState('No assessments yet', 'Allocate one to begin.')}
        </div>
      </div>
      <div style="flex:1">
        <div class="card">
          <h3>Pipeline</h3>
          ${pipelineStepper(stages, c.stage)}
        </div>
        <div class="card">
          <h3>Timeline</h3>
          ${d.timeline.length ? `<table class="data"><tbody>${d.timeline.map((e) => `
            <tr><td class="small">${esc(e.message)}<div class="muted" style="font-size:11px">${esc(e.actor_name)} · ${esc(fmtDateTime(e.created_at))}</div></td></tr>`).join('')}</tbody></table>`
          : '<div class="muted small">No events yet.</div>'}
        </div>
      </div>
    </div>`;
  const { roles } = await api('/admin/roles');
  view.querySelector('#edit').onclick = () => candidateAction('edit', c, roles);
  view.querySelector('#alloc').onclick = () => allocateAssessorModal(c, c.target_role_id);
  view.querySelector('#del').onclick = () => deleteCandidateFlow(c, { goBack: true });
}

/* ================================ Assessments ================================ */
export async function assessmentsView(view) {
  view.innerHTML = loading();
  const urlStatus = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  const [d, { users }] = await Promise.all([api(`/admin/assessments${urlStatus ? `?status=${urlStatus}` : ''}`), api('/admin/users')]);
  const assessors = users.filter((u) => u.role === 'assessor' && u.active);
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Evaluation operations</div><h1>Assessments<span class="heading-dot">.</span></h1><p>Track allocations, submissions and readiness outcomes across every role.</p></div>
    </div>
    <div class="card flat toolbar-card">
      <div class="toolbar-label"><span class="toolbar-icon">◷</span><span>Assessment status</span></div>
      <div class="pill-row filter-pills">
        <a href="#/assessments" class="chip ${!urlStatus ? 'selected' : ''}">All <b>${d.assessments.length}</b></a>
        ${M().assessmentStatuses.map((s) => `<a href="#/assessments?status=${s.key}" class="chip ${urlStatus === s.key ? 'selected' : ''}">${esc(s.label)} <b>${d.assessments.filter((a) => a.status === s.key).length}</b></a>`).join('')}
      </div>
    </div>
    <div class="card table-card">
      ${d.assessments.length ? dataTable([
        { label: 'Candidate', render: (a) => `<a href="#/candidates/${a.candidate_id}"><b>${esc(a.candidate_name)}</b></a>` },
        { label: 'Role', render: (a) => esc(a.role_name) },
        { label: 'Assessor', render: (a) => a.assessor_name ? esc(a.assessor_name) : '<span class="muted">unassigned</span>' },
        { label: 'Status', render: (a) => assessmentStatusBadge(M().assessmentStatuses, a.status) },
        { label: 'Outcome', render: (a) => a.overall_pct != null ? `<b>${a.overall_pct}%</b> ${readinessBadge(a.readiness_key, a.readiness_label)}` : '<span class="muted">—</span>' },
        { label: 'Created', render: (a) => `<span class="small muted">${esc(fmtDate(a.created_at))}</span>` },
        { label: '', cls: 'actions', render: (a) => `
            ${['scored', 'validated'].includes(a.status) ? `<a class="btn ghost sm" href="#/assessments/${a.id}/report">Report</a>` : ''}
            ${['assigned', 'in_progress', 'submitted'].includes(a.status) ? `<button class="btn ghost sm" data-re="${a.id}">Reassign</button>` : ''}
            ${['assigned', 'in_progress'].includes(a.status) ? `<button class="btn ghost sm" style="color:var(--red)" data-del="${a.id}">Delete</button>` : ''}` },
      ], d.assessments) : emptyState('No assessments', 'Allocate an assessment from a candidate or the Candidates page.')}
    </div>`;
  view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const yes = await confirmModal('Delete assessment', 'Delete this not-yet-submitted assessment and its draft answers?', 'Delete', true);
    if (!yes) return;
    await attempt(() => api(`/admin/assessments/${b.dataset.del}`, { method: 'DELETE' }), { okMessage: 'Assessment deleted' });
    assessmentsView(view);
  }));
  view.querySelectorAll('[data-re]').forEach((b) => (b.onclick = async () => {
    const a = d.assessments.find((x) => x.id === b.dataset.re);
    const vals = await formModal({
      title: `Reassign assessor · ${a.candidate_name}`,
      fields: [{ name: 'assessor_id', label: 'Assessor', type: 'select', allowEmpty: false, options: assessors.map((u) => ({ value: u.id, label: u.name })) }],
      values: { assessor_id: a.assessor_id || '' },
    });
    if (!vals) return;
    await attempt(() => api(`/admin/assessments/${a.id}`, { method: 'PATCH', body: { assessor_id: vals.assessor_id || null } }), { okMessage: 'Assessor updated' });
    assessmentsView(view);
  }));
}

export async function reportView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/admin/reports/${id}`);
  renderReport(view, { ...d, audience: 'admin' });
}

/* ================================ Roles & frameworks ================================ */
export async function rolesView(view) {
  view.innerHTML = loading();
  const { roles } = await api('/admin/roles');
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Capability architecture</div><h1>Roles & frameworks<span class="heading-dot">.</span></h1><p>Shape the capabilities, benchmarks and assessment tracks your teams need.</p></div>
      <div class="heading-actions"><button class="btn" id="add-role">＋ New role / track</button></div>
    </div>
    <div class="card flat info-strip"><span class="info-strip-icon">✦</span><span>Assessment tracks are configuration, not code. Change the framework here and new assessments use it automatically.</span></div>
    <div class="card table-card">
      ${roles.length ? dataTable([
        { label: 'Role', render: (r) => `<a href="#/roles/${r.id}"><b>${esc(r.name)}</b></a><div class="small muted">${esc(r.key)} · ${esc(r.technology)}</div>` },
        { label: 'Competencies', render: (r) => esc(r.competency_count) },
        { label: 'Questions', render: (r) => esc(r.question_count) },
        { label: 'Assessments', render: (r) => esc(r.assessment_count) },
        { label: 'Status', render: (r) => r.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey') },
        { label: '', cls: 'actions', render: (r) => `<a class="btn ghost sm" href="#/roles/${r.id}">Configure</a>
          <a class="btn ghost sm" href="#/questions?role=${r.id}">Questions</a>` },
      ], roles) : emptyState('No roles yet', 'Create your first assessment track.')}
    </div>`;
  view.querySelector('#add-role').onclick = async () => {
    const vals = await formModal({
      title: 'New assessment track',
      fields: [
        { name: 'name', label: 'Role name', required: true, placeholder: 'e.g. Resident Solutions Architect (RSA)' },
        { name: 'key', label: 'Key (slug)', required: true, placeholder: 'e.g. databricks-rsa', help: 'Lowercase letters, numbers, dashes.' },
        { name: 'technology', label: 'Technology', required: true, placeholder: 'e.g. Databricks' },
        { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
      ],
    });
    if (!vals) return;
    await attempt(() => api('/admin/roles', { method: 'POST', body: vals }), { okMessage: 'Role created with a default scoring framework' });
    rolesView(view);
  };
}

export async function roleDetailView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/admin/roles/${id}`);
  const { role } = d;
  const weightSum = d.competencies.reduce((s, c) => s + Number(c.weight || 0), 0);
  view.innerHTML = `
    <div class="card" style="padding:12px 18px"><div class="row between">
      <a class="btn ghost sm" href="#/roles">← All roles</a>
      <a class="btn secondary sm" href="#/questions?role=${role.id}">Open question bank (${d.questions.length})</a>
    </div></div>
    <div class="card">
      <div class="row between">
        <div><h2 style="margin:0">${esc(role.name)}</h2><div class="muted small">${esc(role.key)} · ${esc(role.technology)}</div></div>
        <div class="row">${role.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey')}<button class="btn secondary sm" id="edit-role">Edit</button></div>
      </div>
      ${role.description ? `<p class="small muted" style="margin-top:8px">${esc(role.description)}</p>` : ''}
    </div>
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">Competencies</h3>
        <div class="row">
          ${badge(`Weight total: ${weightSum}`, weightSum === 100 ? 'green' : 'amber')}
          <button class="btn sm" id="add-comp">＋ Add competency</button>
        </div>
      </div>
      ${weightSum !== 100 ? `<p class="small" style="color:var(--amber)">⚠ Competency weights do not total 100 — overall scores will still compute (weights are normalised) but 100 keeps reporting intuitive.</p>` : ''}
      ${d.competencies.length ? dataTable([
        { label: '#', render: (c) => esc(c.order ?? '') },
        { label: 'Competency', render: (c) => `<b>${esc(c.name)}</b><div class="small muted">${esc(c.description || '')}</div>${c.enrichment_hint ? `<div class="small" style="color:var(--amber)">Focus hint: ${esc(c.enrichment_hint)}</div>` : ''}` },
        { label: 'Category', render: (c) => `<span class="chip">${esc(c.category || 'technical')}</span>` },
        { label: 'Weight', render: (c) => esc(c.weight) },
        { label: 'Target', render: (c) => `L${esc(c.target_level)}` },
        { label: 'Status', render: (c) => c.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey') },
        { label: '', cls: 'actions', render: (c) => `<button class="btn ghost sm" data-edit="${c.id}">Edit</button><button class="btn ghost sm" style="color:var(--red)" data-del="${c.id}">Delete</button>` },
      ], d.competencies) : emptyState('No competencies yet', 'Add competencies with weights before writing questions.')}
    </div>
    <div class="card">
      <h3>Scoring & readiness framework</h3>
      <div id="fw-box"></div>
    </div>`;

  const compFields = [
    { name: 'name', label: 'Competency name', required: true },
    { name: 'category', label: 'Category', type: 'select', allowEmpty: false, options: ['technical', 'architecture', 'engineering', 'governance', 'data-ai', 'optimization', 'platform', 'advisory', 'behavioral', 'domain'].map((x) => ({ value: x, label: x })) },
    { name: 'description', label: 'What this measures', type: 'textarea', rows: 2 },
    { name: 'enrichment_hint', label: 'Recommended focus when gap found', type: 'textarea', rows: 2, help: 'Shown on the report card under Areas to improve.' },
    { name: 'weight', label: 'Weight (0-100)', type: 'number', required: true, min: 0, max: 100 },
    { name: 'target_level', label: 'Enterprise-ready target level (1-5)', type: 'number', required: true, min: 1, max: 5 },
    { name: 'order', label: 'Display order', type: 'number' },
    { name: 'active', label: 'Active (included in new assessments)', type: 'checkbox' },
  ];

  const editComp = async (c) => {
    const vals = await formModal({ title: c ? `Edit ${c.name}` : 'Add competency', fields: compFields, values: c || { target_level: 4, active: true, order: d.competencies.length + 1 }, wide: true });
    if (!vals) return;
    await attempt(() => c
      ? api(`/admin/competencies/${c.id}`, { method: 'PATCH', body: vals })
      : api('/admin/competencies', { method: 'POST', body: { ...vals, role_id: role.id } }),
      { okMessage: c ? 'Competency updated' : 'Competency added' });
    roleDetailView(view, { id });
  };
  view.querySelector('#add-comp').onclick = () => editComp(null);
  view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editComp(d.competencies.find((c) => c.id === b.dataset.edit))));
  view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const c = d.competencies.find((x) => x.id === b.dataset.del);
    const yes = await confirmModal('Delete competency', `Delete "${c.name}" and all of its questions? In-flight assessments keep their snapshot and are unaffected.`, 'Delete', true);
    if (!yes) return;
    await attempt(() => api(`/admin/competencies/${c.id}`, { method: 'DELETE' }), { okMessage: 'Competency deleted' });
    roleDetailView(view, { id });
  }));
  view.querySelector('#edit-role').onclick = async () => {
    const vals = await formModal({
      title: 'Edit role', values: role,
      fields: [
        { name: 'name', label: 'Role name', required: true },
        { name: 'technology', label: 'Technology', required: true },
        { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
        { name: 'active', label: 'Active', type: 'checkbox' },
      ],
    });
    if (!vals) return;
    await attempt(() => api(`/admin/roles/${role.id}`, { method: 'PATCH', body: vals }), { okMessage: 'Role updated' });
    roleDetailView(view, { id });
  };

  renderFramework(view.querySelector('#fw-box'), role, d.framework, () => roleDetailView(view, { id }));
}

function renderFramework(box, role, fw, done) {
  const cfg = fw?.config || {};
  const bands = cfg.readiness_bands || [];
  box.innerHTML = `
    <p class="small muted">Scoring blend: competency-weighted average. Bands decide the readiness verdict; level thresholds translate a competency score into the 1-5 capability scale used for gap mapping.</p>
    <table class="data"><thead><tr><th>Readiness band</th><th>Verdict label</th><th style="width:120px">Min. overall %</th></tr></thead>
      <tbody>${bands.map((b, i) => `<tr>
        <td><code>${esc(b.key)}</code></td>
        <td><input type="text" id="fw-label-${i}" value="${esc(b.label)}"/></td>
        <td><input type="number" id="fw-min-${i}" value="${esc(b.min)}" min="0" max="100"/></td>
      </tr>`).join('')}</tbody></table>
    <div class="f-row-3" style="margin-top:14px">
      <label class="f"><span class="lbl">Level thresholds (5 values)</span><input type="text" id="fw-levels" value="${esc((cfg.level_thresholds || []).join(', '))}"/></label>
      <label class="f"><span class="lbl">Moderate gap ≥ levels</span><input type="number" id="fw-mod" value="${esc(cfg.gap_severity?.moderate ?? 1)}" min="1" max="4"/></label>
      <label class="f"><span class="lbl">Critical gap ≥ levels</span><input type="number" id="fw-crit" value="${esc(cfg.gap_severity?.critical ?? 2)}" min="1" max="4"/></label>
    </div>
    <div class="row end"><button class="btn" id="fw-save">Save framework</button></div>
    <p class="small muted">Note: framework changes apply to <b>new</b> assessments only — in-flight assessments keep their original snapshot.</p>`;
  box.querySelector('#fw-save').onclick = async () => {
    const config = {
      readiness_bands: bands.map((b, i) => ({
        key: b.key, tone: b.tone, description: b.description,
        label: box.querySelector(`#fw-label-${i}`).value.trim(),
        min: Number(box.querySelector(`#fw-min-${i}`).value),
      })),
      level_thresholds: box.querySelector('#fw-levels').value.split(',').map((s) => Number(s.trim())),
      gap_severity: {
        moderate: Number(box.querySelector('#fw-mod').value),
        critical: Number(box.querySelector('#fw-crit').value),
      },
    };
    const out = await attempt(async () => {
      try {
        return await api('/admin/frameworks', { method: 'PUT', body: { role_id: role.id, name: fw?.name, config } });
      } catch (err) {
        if (err.body?.problems?.length) throw new Error(err.body.problems.join(' '));
        throw err;
      }
    }, { okMessage: 'Framework saved — applies to new assessments' });
    if (out) done();
  };
}

/* ================================ Question bank ================================ */
export async function questionsView(view) {
  view.innerHTML = loading();
  const filterRole = new URLSearchParams(location.hash.split('?')[1] || '').get('role') || '';
  const [{ roles }, { questions }] = await Promise.all([
    api('/admin/roles'),
    api(`/admin/questions${filterRole ? `?role_id=${filterRole}` : ''}`),
  ]);
  const typeLabel = Object.fromEntries(M().questionTypes.map((t) => [t.key, t.label]));
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Assessment design</div><h1>Question bank<span class="heading-dot">.</span></h1><p>Build thoughtful prompts that reveal how capability shows up in the real world.</p></div>
      <div class="heading-actions"><button class="btn" id="add-q">＋ Add question</button></div>
    </div>
    <div class="card flat toolbar-card">
      <div class="toolbar-label"><span class="toolbar-icon">⌘</span><span>Show questions for</span></div>
      <select id="q-role" aria-label="Filter questions by role"><option value="">All roles</option>
        ${roles.map((r) => `<option value="${r.id}" ${r.id === filterRole ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      <span class="toolbar-hint">${questions.length} question${questions.length === 1 ? '' : 's'} in this view</span>
    </div>
    <div class="card table-card" id="q-list">
      ${questions.length ? dataTable([
        { label: 'Question', render: (qq) => `<div style="max-width:520px">${esc(qq.prompt)}</div><div class="small muted">${esc(qq.competency_name)}</div>` },
        { label: 'Type', render: (qq) => `<span class="chip">${esc(typeLabel[qq.type] || qq.type)}</span>` },
        { label: 'Points', render: (qq) => esc(qq.points) },
        { label: 'Difficulty', render: (qq) => esc(qq.difficulty || '') },
        { label: 'Status', render: (qq) => qq.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey') },
        { label: '', cls: 'actions', render: (qq) => `<button class="btn ghost sm" data-edit="${qq.id}">Edit</button><button class="btn ghost sm" style="color:var(--red)" data-del="${qq.id}">Delete</button>` },
      ], questions) : emptyState('No questions', filterRole ? 'This role has no questions yet.' : 'Choose a role and add questions.')}
    </div>`;
  view.querySelector('#q-role').onchange = (e) => { location.hash = e.target.value ? `#/questions?role=${e.target.value}` : '#/questions'; };
  const editQ = async (existing) => {
    const roleId = existing?.role_id || filterRole || roles[0]?.id;
    if (!roleId) { toast('Create a role first.', 'error'); return; }
    const detail = await api(`/admin/roles/${roleId}`);
    if (!detail.competencies.length) { toast('Add competencies to this role first.', 'error'); return; }
    const vals = await questionEditorModal(existing, detail.competencies);
    if (!vals) return;
    await attempt(() => existing
      ? api(`/admin/questions/${existing.id}`, { method: 'PATCH', body: vals })
      : api('/admin/questions', { method: 'POST', body: { ...vals, role_id: roleId } }),
      { okMessage: existing ? 'Question updated' : 'Question added' });
    questionsView(view);
  };
  view.querySelector('#add-q').onclick = () => editQ(null);
  view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editQ(questions.find((x) => x.id === b.dataset.edit))));
  view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const yes = await confirmModal('Delete question', 'Delete this question? In-flight assessments keep their snapshot.', 'Delete', true);
    if (!yes) return;
    await attempt(() => api(`/admin/questions/${b.dataset.del}`, { method: 'DELETE' }), { okMessage: 'Question deleted' });
    questionsView(view);
  }));
}

/** Custom editor: dynamic options with correct-answer markers, type-conditional fields. */
function questionEditorModal(existing, competencies) {
  return new Promise((resolve) => {
    const v = existing || { type: 'mcq_single', points: 4, difficulty: 'intermediate', active: true, options: [{ id: 'a', label: '' }, { id: 'b', label: '' }], correct_option_ids: [] };
    let options = (v.options || []).map((o) => ({ ...o }));
    const qtypes = state.meta.questionTypes;

    const optionRows = () => options.map((o, i) => `
      <div class="row" style="gap:8px;margin-bottom:7px" data-opt-row="${i}">
        <input type="${v.type === 'mcq_multi' ? 'checkbox' : 'radio'}" name="qe-correct" value="${esc(o.id)}" ${v.correct_option_ids?.includes(o.id) ? 'checked' : ''} title="Mark as correct" style="flex:none;margin-top:9px"/>
        <input type="text" data-opt-label="${i}" value="${esc(o.label)}" placeholder="Option ${esc(o.id.toUpperCase())}" style="flex:1"/>
        <button type="button" class="btn ghost sm" data-opt-del="${i}" ${options.length <= 2 ? 'disabled' : ''}>✕</button>
      </div>`).join('');

    const m = modal({
      title: existing ? 'Edit question' : 'Add question', wide: true,
      bodyHtml: `
        <div class="f-row">
          <label class="f"><span class="lbl">Competency <span class="req">*</span></span>
            <select id="qe-comp">${competencies.map((c) => `<option value="${c.id}" ${v.competency_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="f"><span class="lbl">Type <span class="req">*</span></span>
            <select id="qe-type" ${existing ? 'disabled' : ''}>${qtypes.map((t) => `<option value="${t.key}" ${v.type === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
        </div>
        <label class="f"><span class="lbl">Question / scenario <span class="req">*</span></span>
          <textarea id="qe-prompt" rows="3">${esc(v.prompt || '')}</textarea></label>
        <label class="f"><span class="lbl">Guidance shown to candidate (optional)</span>
          <input type="text" id="qe-help" value="${esc(v.help_text || '')}"/></label>
        <div id="qe-options-zone">
          <span class="lbl" style="display:block;font-size:12.5px;font-weight:600;color:var(--ink-2);margin-bottom:6px">Options & correct answer(s)</span>
          <div id="qe-opts">${optionRows()}</div>
          <button type="button" class="btn secondary sm" id="qe-add-opt">＋ Add option</button>
        </div>
        <div id="qe-rubric-zone" style="margin-top:12px">
          <label class="f"><span class="lbl">Assessor rubric — expected answer / evidence <span class="req">*</span></span>
            <textarea id="qe-rubric" rows="3" placeholder="What a strong answer must demonstrate. Visible only to assessors while scoring.">${esc(v.rubric || '')}</textarea></label>
        </div>
        <div class="f-row-3" style="margin-top:12px">
          <label class="f"><span class="lbl">Points</span><input type="number" id="qe-points" value="${esc(v.points)}" min="1" max="20"/></label>
          <label class="f"><span class="lbl">Difficulty</span><select id="qe-diff">${state.meta.difficulties.map((d) => `<option value="${d}" ${v.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="f"><span class="lbl">Display order</span><input type="number" id="qe-order" value="${esc(v.order ?? 0)}"/></label>
        </div>
        <label class="check"><input type="checkbox" id="qe-active" ${v.active !== false ? 'checked' : ''}/> <span>Active (included in new assessments)</span></label>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { close(); resolve(null); } },
        {
          label: 'Save question',
          onClick: async (close, btn) => {
            btn.disabled = true;
            const root = m.el;
            const type = v.type;
            const opts = options.map((o, i) => ({ id: o.id, label: root.querySelector(`[data-opt-label="${i}"]`)?.value.trim() || '' })).filter((o) => o.label);
            const correct = [...root.querySelectorAll('input[name=qe-correct]:checked')].map((x) => x.value);
            const out = {
              competency_id: root.querySelector('#qe-comp').value,
              type,
              prompt: root.querySelector('#qe-prompt').value.trim(),
              help_text: root.querySelector('#qe-help').value.trim(),
              options: ['mcq_single', 'mcq_multi'].includes(type) ? opts : [],
              correct_option_ids: ['mcq_single', 'mcq_multi'].includes(type) ? correct : [],
              rubric: root.querySelector('#qe-rubric').value.trim(),
              points: Number(root.querySelector('#qe-points').value || 4),
              difficulty: root.querySelector('#qe-diff').value,
              order: Number(root.querySelector('#qe-order').value || 0),
              active: root.querySelector('#qe-active').checked,
            };
            close();
            resolve(out);
          },
        },
      ],
      onOpen: (el) => {
        const zone = el.querySelector('#qe-options-zone');
        const rubricZone = el.querySelector('#qe-rubric-zone');
        const syncVisibility = () => {
          zone.style.display = ['mcq_single', 'mcq_multi'].includes(v.type) ? '' : 'none';
          rubricZone.style.display = v.type === 'text' ? '' : 'none';
        };
        syncVisibility();
        const wireOpts = () => {
          el.querySelectorAll('[data-opt-del]').forEach((b) => (b.onclick = () => { options.splice(Number(b.dataset.optDel), 1); refreshOpts(); }));
        };
        const refreshOpts = () => { el.querySelector('#qe-opts').innerHTML = optionRows(); wireOpts(); };
        wireOpts();
        el.querySelector('#qe-add-opt').onclick = () => {
          const next = String.fromCharCode(97 + options.length);
          options.push({ id: next, label: '' });
          refreshOpts();
        };
        el.querySelector('#qe-type').onchange = (e) => { v.type = e.target.value; v.correct_option_ids = []; syncVisibility(); refreshOpts(); };
      },
    });
  });
}

/* ================================ Users & access ================================ */
export async function usersView(view) {
  view.innerHTML = loading();
  const [{ users }, { candidates }] = await Promise.all([api('/admin/users'), api('/admin/candidates')]);
  const roleTone = { admin: 'red', assessor: 'blue', candidate: 'green', validator: 'amber', trainer: 'amber' };
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Workspace access</div><h1>Users & access<span class="heading-dot">.</span></h1><p>Give the right people the right view of your capability workspace.</p></div>
      <div class="heading-actions"><button class="btn" id="add-user">＋ Create user</button></div>
    </div>
    <div class="demo-creds no-print"><span class="info-strip-icon">⌁</span><span>Only admins can provision accounts. Permissions are role-based, and sensitive candidate details stay compartmentalized.</span></div>
    <div class="card flat account-summary"><span class="account-summary-number">${users.length}</span><span>account${users.length === 1 ? '' : 's'} provisioned</span><span class="summary-divider"></span><span class="muted">Passwords are stored as salted hashes</span></div>
    <div class="card table-card">
      ${dataTable([
        { label: 'User', render: (u) => `<b>${esc(u.name)}</b><div class="small muted mono">@${esc(u.username)}</div>` },
        { label: 'Role', render: (u) => badge(u.role, roleTone[u.role] || 'grey') },
        { label: 'Linked candidate', render: (u) => esc(u.candidate_name || '—') },
        { label: 'Status', render: (u) => u.active !== false ? badge('Active', 'green') : badge('Deactivated', 'grey') },
        { label: '', cls: 'actions', render: (u) => `
            <button class="btn ghost sm" data-edit="${u.id}">Edit</button>
            <button class="btn ghost sm" data-pw="${u.id}">Reset password</button>
            ${u.active !== false ? `<button class="btn ghost sm" style="color:var(--red)" data-off="${u.id}">Deactivate</button>` : `<button class="btn ghost sm" data-on="${u.id}">Reactivate</button>`}` },
      ], users)}
    </div>`;

  const userFields = (values) => [
    { name: 'username', label: 'Username', required: true, help: 'a-z 0-9 . _ - , at least 3 characters.' },
    { name: 'name', label: 'Full name', required: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'role', label: 'Role', type: 'select', required: true, allowEmpty: false, options: state.meta.userRoles.map((r) => ({ value: r, label: r })) },
    { name: 'password', label: values ? 'New password (leave blank to keep current)' : 'Password', type: 'password', required: !values, help: 'Minimum 8 characters. Share securely with the user.' },
    { name: 'candidate_id', label: 'Linked candidate (for role = candidate)', type: 'select', options: candidates.map((c) => ({ value: c.id, label: c.name })) },
  ];

  view.querySelector('#add-user').onclick = async () => {
    const vals = await formModal({ title: 'Create user', fields: userFields(null), values: { role: 'assessor' } });
    if (!vals) return;
    await attempt(() => api('/admin/users', { method: 'POST', body: vals }), { okMessage: `User "${vals.username}" created` });
    usersView(view);
  };
  view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    const vals = await formModal({ title: `Edit @${u.username}`, values: u, fields: userFields(u).filter((f) => ['name', 'email', 'candidate_id', 'password'].includes(f.name)) });
    if (!vals) return;
    const body = { name: vals.name, email: vals.email, candidate_id: vals.candidate_id || null };
    if (vals.password) body.password = vals.password;
    await attempt(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body }), { okMessage: 'User updated' });
    usersView(view);
  }));
  view.querySelectorAll('[data-pw]').forEach((b) => (b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.pw);
    const vals = await formModal({ title: `Reset password · @${u.username}`, fields: [{ name: 'password', label: 'New password', type: 'password', required: true, help: 'Minimum 8 characters.' }] });
    if (!vals) return;
    await attempt(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { password: vals.password } }), { okMessage: 'Password reset' });
  }));
  const toggle = async (id, active) => {
    await attempt(() => api(`/admin/users/${id}`, { method: 'PATCH', body: { active } }), { okMessage: active ? 'User reactivated' : 'User deactivated' });
    usersView(view);
  };
  view.querySelectorAll('[data-off]').forEach((b) => (b.onclick = () => toggle(b.dataset.off, false)));
  view.querySelectorAll('[data-on]').forEach((b) => (b.onclick = () => toggle(b.dataset.on, true)));
}

/* ================================ Audit log ================================ */
export async function auditView(view) {
  view.innerHTML = loading();
  const { events } = await api('/admin/audit');
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Trust & transparency</div><h1>Audit log<span class="heading-dot">.</span></h1><p>A clear history of the changes and decisions made across your workspace.</p></div>
    </div>
    <div class="card flat info-strip"><span class="info-strip-icon">✓</span><span>Events are recorded automatically for account, candidate, assessment and framework activity.</span></div>
    <div class="card table-card">
      ${events.length ? dataTable([
        { label: 'When', render: (e) => `<span class="small muted">${esc(fmtDateTime(e.created_at))}</span>` },
        { label: 'Actor', render: (e) => esc(e.actor_name) },
        { label: 'Action', render: (e) => `<span class="chip">${esc(e.action)}</span>` },
        { label: 'Detail', render: (e) => esc(e.message || '') },
      ], events) : emptyState('No audit events yet')}
    </div>`;
}

/* ================================ utils ================================ */
function refresh() {
  const evt = new HashChangeEvent('hashchange');
  window.dispatchEvent(evt);
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
