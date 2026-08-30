import { api } from '../api.js';
import { state } from '../app.js';
import {
  esc, fmtDate, fmtDateTime, badge, dataTable, loading, emptyState, toast, attempt,
  formModal, confirmModal, pipelineStepper, stageBadge, assessmentStatusBadge, readinessBadge,
  num, pct, modal,
} from '../ui.js';
import { renderReport } from './report.js';

const M = () => state.meta;
// Kept as a fallback for cached/static bootstrap payloads from before the
// allocation cap was published. The API is the source of truth when available.
const FALLBACK_MAX_ASSESSMENT_QUESTIONS = 50;
const maxAssessmentQuestions = () => Math.max(
  1,
  Number(M()?.maxAssessmentQuestions) || FALLBACK_MAX_ASSESSMENT_QUESTIONS,
);

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
      <div class="heading-actions"><a class="btn" href="#/candidates">＋ Add candidate</a></div>
    </div>
    <div class="grid cols-4 metric-grid">
      <div class="stat"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.candidates}</span></div><div class="num">${d.counts.candidates}</div><div class="lbl">Candidates in pipeline</div></div>
      <div class="stat stat-gold"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.ready}</span></div><div class="num">${d.counts.enterprise_ready}</div><div class="lbl">Enterprise-ready</div></div>
      <div class="stat stat-blue"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.active}</span></div><div class="num">${d.counts.active_assessments}</div><div class="lbl">Active assessments</div></div>
      <div class="stat stat-violet"><div class="stat-top"><span class="stat-icon">${DASHBOARD_ICONS.score}</span></div><div class="num">${d.counts.avg_score ?? '—'}${d.counts.avg_score != null ? '%' : ''}</div><div class="lbl">Average scored result</div></div>
    </div>
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
      <div><div class="eyebrow">Talent directory</div><h1>Candidates</h1><p>Search, filter and open a candidate record.</p></div>
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

/**
 * Allocate an assessment: pick the track, the assessor, and how many questions
 * to serve. The question count is optional — "full bank" stays the default —
 * and a live preview shows exactly how a cap spreads across competencies
 * (weighted, so a shorter assessment still scores fairly).
 */
export async function allocateAssessorModal(c, presetRoleId) {
  const [{ roles }, { users }] = await Promise.all([api('/admin/roles'), api('/admin/users')]);
  const assessors = users.filter((u) => u.role === 'assessor' && u.active);
  const activeRoles = roles.filter((r) => r.active !== false);
  if (!activeRoles.length) { toast('Create an assessment track (role) with questions first.', 'error'); return; }
  if (!assessors.length) { toast('Create an assessor user first (Users & Access).', 'error'); return; }

  const initialRole = activeRoles.find((r) => r.id === (presetRoleId || c.target_role_id)) || activeRoles[0];
  const maxQuestions = maxAssessmentQuestions();
  const vals = await new Promise((resolve) => {
    let roleId = initialRole.id;
    let assessorId = assessors[0].id;
    let mode = 'all';              // 'all' | 'limit'
    let count = '';
    let plan = null;
    let planToken = 0;

    modal({
      title: `Allocate assessment · ${c.name}`,
      wide: true,
      bodyHtml: `
        <div class="f-row">
          <label class="f"><span class="lbl">Role / track <span class="req">*</span></span>
            <select id="al-role">${activeRoles.map((r) => `<option value="${esc(r.id)}" ${r.id === roleId ? 'selected' : ''}>${esc(r.name)} · ${esc(r.question_count)} questions</option>`).join('')}</select></label>
          <label class="f"><span class="lbl">Assessor <span class="req">*</span></span>
            <select id="al-assessor">${assessors.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select></label>
        </div>

        <fieldset class="alloc-scope">
          <legend class="lbl">Questions to serve</legend>
          <label class="scope-opt selected" data-scope="all">
            <input type="radio" name="al-scope" value="all" checked />
            <span class="scope-copy"><b>Full question bank</b><small id="al-all-hint">Every active question for this track</small></span>
          </label>
          <label class="scope-opt" data-scope="limit">
            <input type="radio" name="al-scope" value="limit" />
            <span class="scope-copy"><b>Limit to a set number</b><small>Choose up to ${maxQuestions} questions — or the whole bank if it is smaller — balanced across competencies by weight</small></span>
          </label>
          <div class="scope-count" id="al-count-row" hidden>
            <label class="f" style="margin:0">
              <span class="lbl">Number of questions <span class="req">*</span> <span class="muted scope-count-max" id="al-count-max">1–${maxQuestions}</span></span>
              <input type="number" id="al-count" min="1" max="${maxQuestions}" step="1" inputmode="numeric" placeholder="e.g. 10" />
            </label>
            <div class="scope-presets" id="al-presets"></div>
          </div>
          <div class="scope-bank-note" id="al-bank-note" hidden></div>
        </fieldset>

        <div class="alloc-preview" id="al-preview" aria-live="polite"></div>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { close(); resolve(null); } },
        {
          label: 'Allocate',
          onClick: async (close, btn) => {
            if (mode === 'limit') {
              const n = Number(count);
              if (!Number.isInteger(n) || n < 1) { toast('Enter a whole number of questions (1 or more).', 'error'); return; }
              if (n > maxQuestions) { toast(`You can allocate up to ${maxQuestions} questions.`, 'error'); return; }
              if (plan && n > plan.bank_total) { toast(`This track only has ${plan.bank_total} active question(s) — grow the bank to allocate more.`, 'error'); return; }
            }
            btn.disabled = true;
            close();
            resolve({
              role_id: roleId,
              assessor_id: assessorId,
              question_count: mode === 'limit' ? Number(count) : null,
            });
          },
        },
      ],
      onOpen: (el) => {
        const preview = el.querySelector('#al-preview');
        const countRow = el.querySelector('#al-count-row');
        const countInput = el.querySelector('#al-count');
        const countMax = el.querySelector('#al-count-max');
        const presets = el.querySelector('#al-presets');
        const allHint = el.querySelector('#al-all-hint');
        const bankNote = el.querySelector('#al-bank-note');

        // When the bank is smaller than the platform cap, explain WHY and offer
        // the published-catalogue top-up inline — the cap should never feel
        // arbitrary (or silently smaller than the configured 50).
        const renderBankNote = () => {
          if (!plan || !plan.bank_total || plan.bank_total >= maxQuestions) {
            bankNote.hidden = true;
            bankNote.innerHTML = '';
            return;
          }
          const missing = Number(plan.catalogue?.missing) || 0;
          const bank = plan.bank_total;
          bankNote.hidden = false;
          bankNote.innerHTML = `
            <div class="scope-bank-note-copy">
              <b>This track's bank has only ${bank} question${bank === 1 ? '' : 's'}</b>
              <small>Assessments can serve up to ${maxQuestions}, but a cap can never exceed the bank.
                ${missing
                  ? `Top it up with the ${missing} remaining published question${missing === 1 ? '' : 's'} below, or add your own in the Question Bank.`
                  : 'Add questions in the Question Bank to use the full cap.'}</small>
            </div>
            ${missing
              ? `<button type="button" class="btn sm" id="al-sync-catalogue">＋ Add ${missing} published question${missing === 1 ? '' : 's'}</button>`
              : ''}`;
          const syncBtn = bankNote.querySelector('#al-sync-catalogue');
          if (syncBtn) syncBtn.onclick = async () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Adding…';
            const out = await attempt(() => api('/admin/content/sync', { method: 'POST', body: {} }));
            if (!out) { syncBtn.disabled = false; syncBtn.textContent = `＋ Add ${missing} published question${missing === 1 ? '' : 's'}`; return; }
            toast(out.added
              ? `Added ${out.added} published question${out.added === 1 ? '' : 's'} — the bank now has ${out.bank_total}`
              : 'The bank already has the full published catalogue.', 'success');
            loadPlan();
          };
        };

        const renderPreview = () => {
          if (!plan) { preview.innerHTML = `<div class="alloc-preview-loading">${'<span class="spinner"></span>'}<span>Reading the question bank…</span></div>`; return; }
          if (!plan.bank_total) {
            preview.innerHTML = `<div class="alloc-warn"><span>!</span><span>This track has no active questions yet. Add questions before allocating.</span></div>`;
            return;
          }
          const rows = plan.per_competency;
          const shown = plan.total;
          preview.innerHTML = `
            <div class="alloc-preview-head">
              <div><div class="section-kicker">Allocation preview</div>
                <b>${shown} question${shown === 1 ? '' : 's'}</b>
                <span class="muted">of ${plan.bank_total} in the bank · ${plan.points} points</span></div>
              ${mode === 'limit' && shown < plan.bank_total ? '<span class="chip">Weighted subset</span>' : '<span class="chip">Full bank</span>'}
            </div>
            <div class="alloc-split">
              ${rows.map((r) => `
                <div class="alloc-split-row ${r.count ? '' : 'is-empty'}">
                  <span class="alloc-split-name">${esc(r.name)}<small>weight ${esc(r.weight)}</small></span>
                  <span class="alloc-split-bar"><i style="width:${shown ? Math.round((r.count / shown) * 100) : 0}%"></i></span>
                  <span class="alloc-split-count">${r.count}</span>
                </div>`).join('')}
            </div>
            ${rows.some((r) => !r.count) ? `<div class="alloc-note">Competencies showing 0 have no question served at this size — increase the count to cover every competency.</div>` : ''}`;
        };

        const loadPlan = async () => {
          const token = ++planToken;
          plan = null;
          renderPreview();
          const limit = mode === 'limit' && Number(count) >= 1 ? `?limit=${Number(count)}` : '';
          const out = await attempt(() => api(`/admin/roles/${roleId}/question-plan${limit}`));
          if (token !== planToken) return; // a newer request won
          plan = out || null;
          if (plan) {
            allHint.textContent = `All ${plan.total} served question${plan.total === 1 ? '' : 's'} (${plan.bank_total} in the bank · max 5 spoken)`;
            const max = Math.min(plan.bank_total, maxQuestions);
            countInput.max = String(max);
            countMax.textContent = `1–${max}`;
            const options = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
              .filter((n) => n < plan.bank_total && n <= max);
            presets.innerHTML = options.map((n) => `<button type="button" class="chip preset ${Number(count) === n ? 'selected' : ''}" data-preset="${n}">${n}</button>`).join('')
              + (plan.bank_total <= max
                ? `<button type="button" class="chip preset ${Number(count) === plan.bank_total ? 'selected' : ''}" data-preset="${plan.bank_total}">All ${plan.bank_total}</button>`
                : '');
            presets.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
              count = b.dataset.preset;
              countInput.value = count;
              loadPlan();
            }));
          }
          renderBankNote();
          renderPreview();
        };

        el.querySelector('#al-assessor').onchange = (e) => { assessorId = e.target.value; };
        el.querySelector('#al-role').onchange = (e) => { roleId = e.target.value; count = ''; countInput.value = ''; loadPlan(); };
        el.querySelectorAll('input[name=al-scope]').forEach((r) => (r.onchange = () => {
          mode = r.value;
          el.querySelectorAll('.scope-opt').forEach((o) => o.classList.toggle('selected', o.dataset.scope === mode));
          countRow.hidden = mode !== 'limit';
          if (mode === 'limit' && !count) { count = ''; countInput.focus(); }
          loadPlan();
        }));
        countInput.oninput = debounce(() => { count = countInput.value; loadPlan(); }, 300);

        loadPlan();
      },
    });
  });

  if (!vals) return;
  const body = { candidate_id: c.id, role_id: vals.role_id, assessor_id: vals.assessor_id || null };
  if (vals.question_count) body.question_count = vals.question_count;
  await attempt(() => api('/admin/assessments', { method: 'POST', body }),
    { okMessage: vals.question_count ? `Assessment allocated · ${vals.question_count} questions` : 'Assessment allocated' });
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
            { label: 'Questions', render: (a) => questionScope(a) },
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
      <div><div class="eyebrow">Evaluation operations</div><h1>Assessments</h1><p>Allocations, submissions and outcomes.</p></div>
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
        { label: 'Questions', render: (a) => questionScope(a) },
        { label: 'Integrity', render: (a) => integrityBadge(a) },
        { label: 'Status', render: (a) => assessmentStatusBadge(M().assessmentStatuses, a.status) },
        { label: 'Outcome', render: (a) => a.overall_pct != null ? `<b>${a.overall_pct}%</b> ${readinessBadge(a.readiness_key, a.readiness_label)}` : '<span class="muted">—</span>' },
        { label: 'Created', render: (a) => `<span class="small muted">${esc(fmtDate(a.created_at))}</span>` },
        { label: '', cls: 'actions', render: (a) => `
            <a class="btn ghost sm" href="#/assessments/${a.id}/integrity">Integrity</a>
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

/* ============================== Integrity / anti-cheat trail ============================== */
function integrityBadge(a) {
  const n = Number(a.integrity_count || 0);
  if (!n) return badge('0', 'grey');
  const severe = [
    'tab_switch', 'browser_close', 'exam_exit', 'exam_reopen', 'multi_window',
    'devtools_key', 'devtools_resize', 'paste_attempt', 'copy_attempt',
    'cut_attempt', 'screenshot', 'fullscreen_exit',
  ].includes(a.last_integrity_event);
  return `<a href="#/assessments/${esc(a.id)}/integrity" style="text-decoration:none">${badge(`${n}`, severe ? 'red' : 'amber')} <span class="small muted">${esc(a.last_integrity_event || 'events')}</span></a>`;
}

const INTEGRITY_EVENT_TONE = {
  tab_switch: 'red', browser_close: 'red', exam_exit: 'red', exam_reopen: 'red',
  multi_window: 'red', devtools_key: 'red', devtools_resize: 'red',
  paste_attempt: 'amber', copy_attempt: 'amber', cut_attempt: 'amber',
  screenshot: 'red', fullscreen_exit: 'red', contextmenu: 'amber',
};

export async function integrityView(view, { id }) {
  view.innerHTML = loading();
  const d = await api(`/admin/assessments/${id}/integrity`);
  const counters = d.integrity || {};
  const total = Object.values(counters).reduce((s, v) => s + Number(v || 0), 0);
  const severeEvents = (d.events || []).filter((e) => INTEGRITY_EVENT_TONE[e.event] === 'red').length;
  view.innerHTML = `
    <div class="card" style="padding:12px 18px"><a class="btn ghost sm" href="#/assessments">← All assessments</a></div>
    <div class="card">
      <div class="row between">
        <div><div class="section-kicker">Proctoring / integrity trail</div><h2 style="margin:0">${esc(d.candidate?.name || 'Candidate')} · ${esc(d.assessment.id)}</h2>
          <div class="small muted" style="margin-top:5px">Status: ${esc(d.assessment.status)} · Started ${d.assessment.started_at ? esc(fmtDateTime(d.assessment.started_at)) : '—'}</div></div>
        <div class="row">${badge(`${total} events`, total ? 'amber' : 'green')}${severeEvents ? badge(`${severeEvents} severe`, 'red') : badge('no severe events', 'green')}</div>
      </div>
      <div class="grid cols-3 metric-grid" style="margin-top:16px">
        <div class="stat"><div class="lbl">Tab switches</div><div class="num">${counters.tab_switch || 0}</div></div>
        <div class="stat"><div class="lbl">Window blur / browser close</div><div class="num">${((counters.window_blur || 0) + (counters.browser_close || 0))}</div></div>
        <div class="stat"><div class="lbl">Exit / reopen exam</div><div class="num">${((counters.exam_exit || 0) + (counters.exam_reopen || 0))}</div></div>
        <div class="stat"><div class="lbl">Copy / paste / devtools</div><div class="num">${((counters.copy_attempt || 0) + (counters.paste_attempt || 0) + (counters.cut_attempt || 0) + (counters.devtools_key || 0) + (counters.devtools_resize || 0))}</div></div>
        <div class="stat"><div class="lbl">Fullscreen exit</div><div class="num">${counters.fullscreen_exit || 0}</div></div>
        <div class="stat"><div class="lbl">Multi-window</div><div class="num">${counters.multi_window || 0}</div></div>
      </div>
    </div>
    <div class="card table-card">
      <h3 style="margin:0 0 10px">Event history</h3>
      ${(d.events || []).length ? dataTable([
        { label: 'When', render: (e) => `<span class="small muted">${esc(fmtDateTime(e.at))}</span>` },
        { label: 'Event', render: (e) => badge(e.event, INTEGRITY_EVENT_TONE[e.event] || 'grey') },
        { label: 'Question', render: (e) => e.question_index != null ? `Q${Number(e.question_index) + 1}` : '<span class="muted">—</span>' },
        { label: 'Detail', render: (e) => `<span class="small">${esc(e.detail || '—')}</span>` },
      ], d.events) : emptyState('No integrity events yet', 'Tab switch, blur, copy, paste, devtools, exit/reopen and window events are logged here.')}
    </div>`;
}

/* ================================ Roles & frameworks ================================ */
export async function rolesView(view) {
  view.innerHTML = loading();
  const { roles } = await api('/admin/roles');
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Capability architecture</div><h1>Roles & frameworks</h1><p>Competencies, scoring bands and tracks.</p></div>
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
  const [{ roles }, { questions }, catalogue] = await Promise.all([
    api('/admin/roles'),
    api(`/admin/questions${filterRole ? `?role_id=${filterRole}` : ''}`),
    attempt(() => api('/admin/content/catalogue')),
  ]);
  const typeLabel = Object.fromEntries(M().questionTypes.map((t) => [t.key, t.label]));
  const missing = catalogue?.available ? Number(catalogue.missing) || 0 : 0;
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Assessment design</div><h1>Question bank</h1><p>Prompts, options, rubrics and points.</p></div>
      <div class="heading-actions"><button class="btn" id="add-q">＋ Add question</button></div>
    </div>
    ${missing ? `
    <div class="card flat catalogue-strip">
      <span class="info-strip-icon">＋</span>
      <span class="catalogue-strip-copy"><b>${missing} published question${missing === 1 ? '' : 's'} not in this workspace yet.</b>
        <small>The published ${esc(catalogue.role.name)} catalogue carries ${catalogue.catalogue_total} questions — this bank has ${catalogue.bank_total}, so assessments top out below the ${maxAssessmentQuestions()}-question cap.</small></span>
      <button class="btn sm" id="sync-catalogue">Add published questions</button>
    </div>` : ''}
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
  const syncBtn = view.querySelector('#sync-catalogue');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Adding…';
    const out = await attempt(() => api('/admin/content/sync', { method: 'POST', body: {} }));
    if (!out) { syncBtn.disabled = false; syncBtn.textContent = 'Add published questions'; return; }
    toast(out.added
      ? `Added ${out.added} published question${out.added === 1 ? '' : 's'} — the bank now has ${out.bank_total}`
      : 'The bank already has the full published catalogue.', 'success');
    questionsView(view);
  };
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
            const root = m.el;
            const type = v.type;
            const isChoice = ['mcq_single', 'mcq_multi'].includes(type);
            const opts = options.map((o, i) => ({ id: o.id, label: root.querySelector(`[data-opt-label="${i}"]`)?.value.trim() || '' })).filter((o) => o.label);
            const correct = [...root.querySelectorAll('input[name=qe-correct]:checked')].map((x) => x.value);
            const prompt = root.querySelector('#qe-prompt').value.trim();
            const rubric = root.querySelector('#qe-rubric').value.trim();
            const points = Number(root.querySelector('#qe-points').value || 4);
            const fail = (message, selector) => {
              toast(message, 'error');
              const field = root.querySelector(selector);
              field?.focus();
              field?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            };
            if (!prompt) { fail('Question prompt is required.', '#qe-prompt'); return; }
            if (!Number.isFinite(points) || points < 1 || points > 20) { fail('Points must be between 1 and 20.', '#qe-points'); return; }
            if (isChoice) {
              if (opts.length < 2) { fail('At least two answer options are required.', '[data-opt-label="0"]'); return; }
              const optionIds = new Set(opts.map((o) => o.id));
              const validCorrect = correct.filter((id) => optionIds.has(id));
              if (type === 'mcq_single' && validCorrect.length !== 1) { fail('Select exactly one correct option.', 'input[name=qe-correct]'); return; }
              if (type === 'mcq_multi' && (validCorrect.length < 1 || validCorrect.length >= opts.length)) { fail('Select at least one correct option, but not all options.', 'input[name=qe-correct]'); return; }
            }
            if (type === 'text' && !rubric) { fail('Add the assessor rubric for this open question.', '#qe-rubric'); return; }
            btn.disabled = true;
            const out = {
              competency_id: root.querySelector('#qe-comp').value,
              type,
              prompt,
              help_text: root.querySelector('#qe-help').value.trim(),
              options: isChoice ? opts : [],
              correct_option_ids: isChoice ? correct.filter((id) => opts.some((o) => o.id === id)) : [],
              rubric,
              points,
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
      <div><div class="eyebrow">Workspace access</div><h1>Users & access</h1><p>Provision accounts and assign roles.</p></div>
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
    ...(values && values.role !== 'candidate' ? [] : [{
      name: 'candidate_id', label: 'Linked candidate (required for candidate role)', type: 'select',
      options: candidates.map((c) => ({ value: c.id, label: c.name })),
      required: values?.role === 'candidate',
      help: values ? 'Candidate portal users must stay linked to exactly one candidate record.' : 'Required only when Role is candidate; ignored for other roles.',
    }]),
  ];

  view.querySelector('#add-user').onclick = async () => {
    let values = { role: 'assessor' };
    while (true) {
      const vals = await formModal({ title: 'Create user', fields: userFields(null), values });
      if (!vals) return;
      values = vals;
      if (vals.role === 'candidate' && !vals.candidate_id) {
        toast('Choose the linked candidate before creating a candidate portal user.', 'error');
        continue;
      }
      const body = { ...vals };
      if (body.role !== 'candidate') delete body.candidate_id;
      const out = await attempt(() => api('/admin/users', { method: 'POST', body }), { okMessage: `User "${vals.username}" created` });
      if (out) usersView(view);
      return;
    }
  };
  view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    const editable = ['name', 'email', 'password', ...(u.role === 'candidate' ? ['candidate_id'] : [])];
    const vals = await formModal({ title: `Edit @${u.username}`, values: u, fields: userFields(u).filter((f) => editable.includes(f.name)) });
    if (!vals) return;
    const body = { name: vals.name, email: vals.email };
    if (u.role === 'candidate') body.candidate_id = vals.candidate_id;
    if (vals.password) body.password = vals.password;
    const out = await attempt(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body }), { okMessage: 'User updated' });
    if (out) usersView(view);
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
      <div><div class="eyebrow">Trust & transparency</div><h1>Audit log</h1><p>Account, candidate, assessment and framework events.</p></div>
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
/** "12 of 21" when the allocation was capped, plain count otherwise. */
function questionScope(a) {
  const n = a.question_count ?? null;
  if (n === null) return '<span class="muted">—</span>';
  const capped = a.question_limit != null && a.bank_total != null && a.bank_total > n;
  return capped
    ? `<b>${esc(n)}</b><span class="muted small"> of ${esc(a.bank_total)}</span>`
    : `<b>${esc(n)}</b>`;
}

function refresh() {
  const evt = new HashChangeEvent('hashchange');
  window.dispatchEvent(evt);
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ============================ Question Bank v1.2 ============================ */
/**
 * Family -> module view of the finalized question bank, plus the fixed shape
 * of a generated paper. Read-only published content: the modules, their
 * families and the per-module quotas come from the API, so this view never
 * drifts from src/core/test-generation.mjs.
 */
export async function modulesView(view) {
  view.innerHTML = loading();
  const [bank, plan] = await Promise.all([
    api('/admin/question-bank/modules?include_optional=1'),
    attempt(() => api('/admin/question-bank/plan')),
  ]);

  const bp = bank.blueprint;
  const families = bank.families;
  const byFamily = new Map(families.map((f) => [f.key, []]));
  for (const m of [...bank.modules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!byFamily.has(m.family)) byFamily.set(m.family, []);
    byFamily.get(m.family).push(m);
  }
  const planFor = new Map((plan?.modules || []).map((r) => [r.module, r]));

  const quota = (m) => {
    if (m.mandatory) return '<span class="chip chip-mandatory">Always served</span>';
    if (m.technical) return '<span class="chip">3 objective + 1 open</span>';
    return '<span class="chip">1 open</span>';
  };

  view.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="eyebrow">Assessment design</div>
        <h1>Modules &amp; families</h1>
        <p>The finalized question bank v${esc(bank.version)} — ${bank.bank_total} questions across
           ${bank.modules.length - 1} modules, grouped into ${families.length - 1} families.</p>
      </div>
      <div class="heading-actions"><button class="btn" id="mv-preview">Preview a test</button></div>
    </div>

    <div class="card flat blueprint-strip">
      <span class="info-strip-icon">≡</span>
      <span class="catalogue-strip-copy">
        <b>Every generated test contains ${bp.total} questions.</b>
        <small>${bp.mandatory} mandatory · ${bp.technical_objective} technical objective ·
          ${bp.technical_open} technical open · ${bp.non_technical_open} non-technical open.
          Questions are drawn at random from each module's bank while this structure is held exactly.</small>
      </span>
      ${plan && plan.ready
        ? badge('All modules ready', 'green')
        : badge('Some modules are short', 'amber')}
    </div>

    ${families.map((f) => {
      const mods = byFamily.get(f.key) || [];
      if (!mods.length) return '';
      return `
      <div class="card module-family">
        <div class="panel-head">
          <div>
            <h2>${esc(f.name)}</h2>
            <p class="small muted">${esc(f.description)}</p>
          </div>
          <span class="chip">${mods.length} module${mods.length === 1 ? '' : 's'}</span>
        </div>
        ${dataTable([
          { label: 'Module', render: (m) => `<b>${esc(m.key)}</b> — ${esc(m.name)}` },
          { label: 'Served per test', render: quota },
          { label: 'Objective', render: (m) => esc(m.objective) },
          { label: 'Open', render: (m) => esc(m.open) },
          { label: 'Optional', render: (m) => m.optional
              ? `<span class="chip chip-optional">${esc(m.optional)}</span>` : '—' },
          { label: 'Status', render: (m) => {
              const row = planFor.get(m.key);
              if (!row) return '';
              return row.sufficient ? badge('Ready', 'green') : badge('Short', 'amber');
            } },
        ], mods)}
      </div>`;
    }).join('')}

    <div class="card flat">
      <div class="panel-head"><div><h2>Optional pool</h2>
        <p class="small muted">The retired catalogue, kept as a fallback. These questions are never
        served while a module can fill its quota from the bank above — they are only drawn to cover a
        shortfall.</p></div>
        <span class="chip chip-optional">${bank.optional.total} questions</span></div>
    </div>`;

  view.querySelector('#mv-preview').onclick = async () => {
    const out = await attempt(() => api('/admin/question-bank/preview', { method: 'POST', body: {} }));
    if (out) previewModal(out);
  };
}

/** Show one generated paper, grouped by module. */
function previewModal(result) {
  const c = result.counts;
  const rows = result.questions.map((q, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td><b>${esc(q.mandatory ? 'M00' : q.module)}</b></td>
      <td><span class="chip">${esc(q.type === 'objective' ? 'Objective' : 'Open')}</span></td>
      <td style="max-width:520px">${esc(q.prompt)}
        ${q.mandatory ? '<span class="chip chip-mandatory">Mandatory</span>' : ''}
        ${q.optional ? '<span class="chip chip-optional">Optional</span>' : ''}</td>
    </tr>`).join('');

  modal({
    title: 'Sample generated test',
    wide: true,
    bodyHtml: `
      <p class="small muted">${c.total} questions — ${c.mandatory} mandatory,
        ${c.technical_objective} technical objective, ${c.technical_open} technical open,
        ${c.non_technical_open} non-technical open${c.from_optional
          ? `, ${c.from_optional} drawn from the optional pool` : ''}.</p>
      ${result.warnings.length
        ? `<div class="card flat"><b>Warnings</b><ul class="small">${
            result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : ''}
      <div class="preview-scroll">
        <table class="data"><thead><tr>
          <th>#</th><th>Module</th><th>Type</th><th>Question</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>`,
    actions: [{ label: 'Close', kind: 'ghost', close: true }],
  });
}
