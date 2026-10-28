import { deletePersonFlow } from '../../person-delete.js';
import { api, apiAll, newRequestId } from '../../api.js';
import { state } from '../../app.js';
import { esc, fmtDate, fmtDateTime, badge, dataTable, loading, emptyState, toast, attempt, formModal, confirmModal, pipelineStepper, stageBadge, assessmentStatusBadge, readinessBadge, modal } from '../../ui.js';
import { renderReport } from '../report.js';
import { M, maxAssessmentQuestions, refresh, debounce, fileToBase64, csvCell, downloadText } from './shared.js';
import { questionScope } from './question-bank.js';

/** Candidates: list, detail, assessor allocation, deletion and spreadsheet import. */
const candidateFields = (roles, assessors = [], current = {}) => [
  { name: 'name', label: 'Full name', required: true },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'current_title', label: 'Current title' },
  { name: 'years_experience', label: 'Years of experience', type: 'number', min: 0, max: 50 },
  { name: 'location', label: 'Location' },
  { name: 'source', label: 'Source', placeholder: 'Referral, partner, inbound…' },
  {
    name: 'target_role_id', label: 'Target role (assessment track)', type: 'select',
    // Active tracks are offered; a candidate's own track that has since been
    // deactivated stays selectable (labelled) so opening and saving the form
    // is a no-op unless the admin deliberately picks another.
    options: roles
      .filter((r) => r.active !== false || r.id === current.target_role_id)
      .map((r) => ({ value: r.id, label: r.active === false ? `${r.name} (inactive)` : r.name })),
  },
  {
    name: 'assessor_id', label: 'Assessor', type: 'select',
    // A candidate whose assessor has since been deactivated keeps that
    // assessor selectable: otherwise the select would open blank and saving
    // an unrelated field would silently unassign every paper.
    options: [
      ...assessors.map((u) => ({ value: u.id, label: u.name })),
      ...(current.assessor_id && !assessors.some((u) => u.id === current.assessor_id)
        ? [{ value: current.assessor_id, label: `${current.assessor_name || 'Current assessor'} (deactivated)` }] : []),
    ],
    help: assessors.length
      ? 'Scores this candidate\'s assessments. Auto-allocated papers go to this assessor; changing it moves their open (not yet scored) assessments too — finalized reports keep the assessor who scored them.'
      : 'No active assessor users yet — create one under Users & Access.',
  },
  { name: 'stage', label: 'Pipeline stage', type: 'select', options: M().pipelineStages.map((s) => ({ value: s.key, label: s.label })), allowEmpty: false },
  { name: 'notes', label: 'Internal notes', type: 'textarea', rows: 3, help: 'Visible to admins only — never to assessors or the candidate.' },
];

/** Active assessor-role users, for every "Assessor" selector on the admin screens. */
export async function loadAssessors() {
  const users = await apiAll('/admin/users', 'users');
  return users.filter((u) => u.role === 'assessor' && u.active !== false);
}

export function trackAssessorLabel(role) {
  if (!role.default_assessor_id) return '<span class="muted">Not set</span>';
  const name = esc(role.default_assessor_name || 'Unavailable assessor');
  return role.default_assessor_active ? name : `${name} ${badge('Unavailable — choose another', 'amber')}`;
}

export function trackAssessorField(assessors, role = {}) {
  return {
    name: 'default_assessor_id', label: 'Default assessor', type: 'select', allowEmpty: false,
    options: [
      { value: '', label: 'No default — assign manually' },
      ...assessors.map((u) => ({ value: u.id, label: u.name })),
      ...(role.default_assessor_id && !assessors.some((u) => u.id === role.default_assessor_id)
        ? [{ value: role.default_assessor_id, label: `${role.default_assessor_name || 'Current assessor'} (unavailable)` }] : []),
    ],
    help: 'Receives new booking, candidate-user and CSV auto allocations when no active assessor was selected for the candidate. Existing assessments keep their assessor.'
      + (assessors.length ? '' : ' Create an assessor in Users & Access to choose one here.'),
  };
}

export async function candidatesView(view) {
  view.innerHTML = loading();
  const [candidates, { roles }, assessors] = await Promise.all([apiAll('/admin/candidates', 'candidates'), api('/admin/roles'), loadAssessors()]);
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Talent directory</div><h1>Candidates</h1><p>Search, filter and open a candidate record.</p></div>
      <div class="heading-actions">
        <button class="btn secondary" id="import-cands">Import from Excel</button>
        <button class="btn" id="add-cand">＋ Add candidate</button>
      </div>
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
      { label: 'Target role', render: (c) => `${c.role_name ? esc(c.role_name) : '<span class="muted">—</span>'}${c.deleting ? `<div>${badge('Deletion incomplete', 'red')}</div>` : ''}` },
      { label: 'Assessor', render: (c) => c.assessor_name ? esc(c.assessor_name) : '<span class="muted">unassigned</span>' },
      { label: 'Stage', render: (c) => stageBadge(M().pipelineStages, c.stage) },
      { label: 'Source', render: (c) => esc(c.source || '—') },
      { label: 'Added', render: (c) => `<span class="small muted">${esc(fmtDate(c.created_at))}</span>` },
      { label: '', cls: 'actions', render: (c) => `
        <button class="btn ghost sm" data-act="edit" data-id="${c.id}">Edit</button>
        <button class="btn ghost sm" data-act="alloc" data-id="${c.id}">Allocate</button>
        <button class="btn ghost sm" style="color:var(--red)" data-act="del" data-id="${c.id}">Delete</button>
        <button class="btn ghost sm" style="color:var(--red)" data-act="purge" data-id="${c.id}">Delete all data</button>` },
    ], rows);
    el.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = () => candidateAction(b.dataset.act, rows.find((r) => r.id === b.dataset.id), roles, assessors)));
  };
  renderList(candidates);

  // Debounced input can have several fetches in flight; only the newest one
  // may paint, otherwise a slow earlier response overwrites the latest filter.
  let filterSeq = 0;
  const refilter = async () => {
    const q = view.querySelector('#cand-q').value, stage = view.querySelector('#cand-stage').value;
    const seq = ++filterSeq;
    // Walk every page like the initial load does: a single request is capped
    // at one page (200 rows), so a filtered view of a large workspace used to
    // be silently truncated.
    const rows = await attempt(() => apiAll(`/admin/candidates?q=${encodeURIComponent(q)}&stage=${encodeURIComponent(stage)}`, 'candidates'));
    if (rows && seq === filterSeq) renderList(rows);
  };
  view.querySelector('#cand-q').oninput = debounce(refilter, 350);
  view.querySelector('#cand-stage').onchange = refilter;
  view.querySelector('#import-cands').onclick = () => importCandidatesModal(() => candidatesView(view));
  view.querySelector('#add-cand').onclick = async () => {
    const saved = await formModal({
      title: 'Add candidate', fields: candidateFields(roles, assessors), values: { stage: 'intake' },
      onSubmit: (vals) => api('/admin/candidates', { method: 'POST', body: vals }),
    });
    if (!saved) return;
    toast('Candidate added', 'success');
    candidatesView(view);
  };
}

async function candidateAction(act, c, roles, assessors = null) {
  if (!c) return;
  if (act === 'edit') {
    const list = assessors || await loadAssessors();
    const saved = await formModal({
      title: `Edit ${c.name}`, fields: candidateFields(roles, list, c), values: c,
      onSubmit: (vals) => api(`/admin/candidates/${c.id}`, { method: 'PATCH', body: vals }),
    });
    if (!saved) return;
    toast(saved.reassigned_assessments
      ? `Candidate updated · ${saved.reassigned_assessments} open assessment${saved.reassigned_assessments === 1 ? '' : 's'} moved to the new assessor`
      : 'Candidate updated', 'success');
    refresh();
  } else if (act === 'alloc') {
    await allocateAssessorModal(c);
  } else if (act === 'del') {
    await deleteCandidateFlow(c);
  } else if (act === 'purge') {
    await deletePersonFlow('candidates', c, refresh);
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
  // A wrong password keeps the dialog open to try again.
  const deleted = await formModal({
    title: `Confirm deletion · ${c.name}`,
    submitLabel: 'Delete permanently',
    busyLabel: 'Deleting…',
    fields: [{
      name: 'password', label: 'Admin password', type: 'password', required: true,
      help: 'This action is permanent and requires your admin password.',
    }],
    onSubmit: (vals) => api(`/admin/candidates/${c.id}`, { method: 'DELETE', body: { password: vals.password } }),
  });
  if (!deleted) return;
  toast(`Candidate "${c.name}" deleted`, 'success');
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
  const [{ roles }, users] = await Promise.all([api('/admin/roles'), apiAll('/admin/users', 'users')]);
  const assessors = users.filter((u) => u.role === 'assessor' && u.active !== false);
  const activeRoles = roles.filter((r) => r.active !== false);
  if (!activeRoles.length) { toast('Create an assessment track (role) with questions first.', 'error'); return; }
  if (!assessors.length) { toast('Create an assessor user first (Users & Access).', 'error'); return; }

  const initialRole = activeRoles.find((r) => r.id === (presetRoleId || c.target_role_id)) || activeRoles[0];
  const maxQuestions = maxAssessmentQuestions();
  const vals = await new Promise((resolve) => {
    // Answer exactly once. Esc, the backdrop and ✕ close the dialog through
    // onClose, and used to leave this promise pending for good (only Cancel
    // resolved it). The chosen values are settled BEFORE close(), because
    // closing now reports "cancelled".
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    let roleId = initialRole.id;
    // The candidate's own assessor (Edit form / import column) is the default.
    let assessorId = (c.assessor_id && assessors.find((u) => u.id === c.assessor_id)) ? c.assessor_id : assessors[0].id;
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
            <select id="al-assessor">${assessors.map((u) => `<option value="${esc(u.id)}" ${u.id === assessorId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
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
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { settle(null); close(); } },
        {
          label: 'Allocate',
          onClick: async (close, btn) => {
            if (!plan) { toast('Wait for a valid allocation preview before allocating.', 'error'); return; }
            if (mode === 'limit') {
              const n = Number(count);
              if (!Number.isInteger(n) || n < 1) { toast('Enter a whole number of questions (1 or more).', 'error'); return; }
              if (n > maxQuestions) { toast(`You can allocate up to ${maxQuestions} questions.`, 'error'); return; }
              if (plan && n > plan.bank_total) { toast(`This track only has ${plan.bank_total} active question(s) — grow the bank to allocate more.`, 'error'); return; }
            }
            btn.disabled = true;
            settle({
              role_id: roleId,
              assessor_id: assessorId,
              question_count: mode === 'limit' ? Number(count) : null,
            });
            close();
          },
        },
      ],
      onClose: () => settle(null),
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
            // Sync the track the dialog is allocating for — never the default.
            const roleKey = activeRoles.find((r) => r.id === roleId)?.key;
            const out = await attempt(() => api('/admin/content/sync', { method: 'POST', body: { role_key: roleKey } }));
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
          const rows = plan.per_module ? plan.per_module.map((s) => ({ name: `${s.module} · ${s.name}`, count: s.objective + s.open,
            quota: `${s.objective} objective + ${s.open} open` })) : plan.per_competency;
          const shown = plan.total;
          preview.innerHTML = `
            <div class="alloc-preview-head">
              <div><div class="section-kicker">Allocation preview</div>
                <b>${shown} question${shown === 1 ? '' : 's'}</b>
                <span class="muted">of ${plan.bank_total} in the bank · ${plan.points} points</span></div>
              ${plan.required_question_count ? '<span class="chip">Fixed module blueprint</span>' : mode === 'limit' && shown < plan.bank_total ? '<span class="chip">Weighted subset</span>' : '<span class="chip">Full bank</span>'}
            </div>
            <div class="alloc-split">
              ${rows.map((r) => `
                <div class="alloc-split-row ${r.count ? '' : 'is-empty'}">
                  <span class="alloc-split-name">${esc(r.name)}<small>${r.quota ? esc(r.quota) : `weight ${esc(r.weight)}`}</small></span>
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
            const fixed = Boolean(plan.required_question_count);
            const allChoice = el.querySelector('[data-scope="all"]');
            el.querySelector('[data-scope="limit"]').hidden = fixed;
            allChoice.querySelector('b').textContent = fixed ? '50-question module assessment' : 'Full question bank';
            if (fixed) {
              mode = 'all'; count = ''; countRow.hidden = true;
              allChoice.querySelector('input').checked = true;
              allChoice.classList.add('selected');
              el.querySelector('[data-scope="limit"]').classList.remove('selected');
            }
            // The spoken cap is whatever the plan actually served, not a
            // hard-coded "max 5": a track without a spoken set has none.
            const spoken = Number(plan.spoken_served || 0);
            allHint.textContent = fixed ? '30 technical objective + 10 technical open + 10 non-technical open'
              : `All ${plan.total} served question${plan.total === 1 ? '' : 's'} (${plan.bank_total} in the bank${spoken ? ` · ${spoken} spoken` : ''})`;
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
  const body = { candidate_id: c.id, role_id: vals.role_id, assessor_id: vals.assessor_id || null, request_id: newRequestId() };
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
    ${c.deleting ? '<div class="card attention-card">Deletion is incomplete. Use “Delete all data” to review the remaining records and finish cleanup. Candidate account access stays disabled.</div>' : ''}
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
              <button class="btn ghost sm" id="purge-person" style="color:var(--red)">Delete all data</button>
            </div>
          </div>
          <hr class="hr"/>
          <div class="grid cols-2 small" style="gap:6px 26px">
            <div><span class="muted">Email:</span> ${esc(c.email || '—')}</div>
            <div><span class="muted">Phone:</span> ${esc(c.phone || '—')}</div>
            <div><span class="muted">Location:</span> ${esc(c.location || '—')}</div>
            <div><span class="muted">Source:</span> ${esc(c.source || '—')}</div>
            <div><span class="muted">Target role:</span> ${esc(d.role_name || '—')}</div>
            <div><span class="muted">Assessor:</span> ${d.assessor_name ? esc(d.assessor_name) : '<span class="muted">unassigned — press Edit to choose one</span>'}</div>
            <div><span class="muted">Portal login:</span> ${d.linked_user ? `<code>${esc(d.linked_user.username)}</code>` : '<span class="muted">not provisioned — create under Users & Access</span>'}</div>
          </div>
          ${c.notes ? `<hr class="hr"/><div class="small"><span class="muted">Internal notes:</span><br/>${esc(c.notes)}</div>` : ''}
        </div>
        <div class="card">
          <h3>Assessments</h3>
          ${d.assessments.length ? dataTable([
            { label: 'Role', render: (a) => esc(a.role_name) },
            { label: 'Assessor', render: (a) => a.assessor_name ? esc(a.assessor_name) : '<span class="muted">unassigned</span>' },
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
  const [{ roles }, assessors] = await Promise.all([api('/admin/roles'), loadAssessors()]);
  view.querySelector('#edit').onclick = () => candidateAction('edit', { ...c, assessor_name: d.assessor_name }, roles, assessors);
  view.querySelector('#alloc').onclick = () => allocateAssessorModal(c, c.target_role_id);
  view.querySelector('#del').onclick = () => deleteCandidateFlow(c, { goBack: true });
  view.querySelector('#purge-person').onclick = () => deletePersonFlow('candidates', c, () => { location.hash = '#/candidates'; });
}

/* ================================ Assessments ================================ */

export function importCandidatesModal(onDone) {
  let checked = null;      // last dry-run report
  let payload = null;      // { file_base64 | csv, filename }
  let lastFile = null;     // re-checked when the user toggle changes
  let rootEl = null;       // the open dialog, set in onOpen
  let committed = false;   // a successful import happened; close -> refresh
  let assessorOptions = []; // active assessors, for the default and the post-import selectors
  const IMPORT_PAGE_ROWS = 100; // ≈ 2–3 s of server work per page
  const part = (sel) => rootEl?.querySelector(sel);

  const body = `
    <p class="modal-intro">Upload an .xlsx or .csv of candidates. The first row must be a header.
      The file is validated as a dry run first — nothing is written until you press Import.</p>
    <div class="import-drop" id="ic-drop">
      <input type="file" id="ic-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden/>
      <div class="import-drop-copy">
        <b id="ic-name">Choose a file or drop it here</b>
        <small>.xlsx or .csv · up to 2000 rows</small>
      </div>
      <button type="button" class="btn secondary sm" id="ic-browse">Browse</button>
    </div>
    <label class="import-toggle" id="ic-users-row">
      <input type="checkbox" id="ic-users" checked />
      <span><b>Create linked portal users</b>
        <small>Each candidate gets a candidate-role login. Leave <span class="mono">Username</span> /
        <span class="mono">Password</span> blank and they are generated; credentials are shown once here.</small></span>
    </label>
    <label class="import-toggle" id="ic-alloc-row">
      <input type="checkbox" id="ic-alloc" checked />
      <span><b>Auto-allocate each role’s default assessment</b>
        <small>Each new portal user gets the question count configured for their target role under Roles & frameworks.</small></span>
    </label>
    <label class="f" id="ic-assessor-row" style="margin:10px 0 0">
      <span class="lbl">Assessor for imported candidates</span>
      <select id="ic-assessor" aria-label="Default assessor for imported candidates">
        <option value="">— unassigned (assign later) —</option>
      </select>
      <div class="help">Scores the auto-allocated assessments. A row's own <span class="mono">Assessor</span> column
        (name, username or email of an assessor user) overrides this default.</div>
    </label>
    <p class="small muted" style="margin:11px 0 0">
      Columns: <b>Name</b> · Email · Current title · Years of experience · Target role · Pipeline stage ·
      Assessor · Username · Password · Notes (plus Phone, Location, Source).
      Not sure? <a href="#" id="ic-template">Download the template</a>.
    </p>
    <div id="ic-report"></div>`;

  const renderReport = (r) => {
    const report = part('#ic-report');
    const problems = [
      ...r.errors.map((e) => ({ ...e, kind: 'Rejected' })),
      ...r.duplicate_rows.map((d) => ({ ...d, kind: 'Duplicate', errors: d.errors || ['Already in the directory.'] })),
    ].sort((a, b) => a.line - b.line);

    report.innerHTML = `
      <div class="import-summary">
        ${badge(`${r.accepted} ready`, r.accepted ? 'green' : 'grey')}
        ${r.rejected ? badge(`${r.rejected} rejected`, 'red') : ''}
        ${r.duplicates ? badge(`${r.duplicates} duplicate`, 'amber') : ''}
        <span class="small muted">of ${r.total} data ${r.total === 1 ? 'row' : 'rows'}
          ${r.create_users ? '· portal users will be created' : '· candidates only'}</span>
      </div>
      ${r.create_users ? `<p class="small muted" style="margin:8px 0 0">${
        r.auto_allocate
          ? (r.would_auto_allocate
            ? `↳ <b>${r.would_auto_allocate}</b> assessment${r.would_auto_allocate === 1 ? '' : 's'} will be auto-allocated using each target role’s configured default${r.auto_skipped ? ` — ${r.auto_skipped} row${r.auto_skipped === 1 ? '' : 's'} skipped (no track or empty bank)` : ''}.`
            : '↳ No assessments can be auto-allocated yet (no track with questions) — allocate manually after importing.')
          : '↳ Automatic allocation is off — allocate manually after importing.'}</p>` : ''}
      ${r.preview.length ? `
        <div class="preview-scroll" style="max-height:26vh;margin-top:12px">
          <table class="data"><thead><tr>
            <th>Row</th><th>Name</th><th>Target role</th><th>Stage</th><th>Assessor</th><th>Username</th>
          </tr></thead><tbody>${r.preview.map((p) => `
            <tr><td class="muted">${p.line}</td><td><b>${esc(p.name)}</b></td>
              <td class="small">${esc(p.target_role || '—')}</td>
              <td class="small">${esc(p.stage || '—')}</td>
              <td class="small">${p.assessor ? esc(p.assessor) : '<span class="muted">unassigned</span>'}</td>
              <td class="small mono">${esc(p.username || '')}</td></tr>`).join('')}
          </tbody></table>
        </div>
        ${r.accepted > r.preview.length
          ? `<p class="small muted">…and ${r.accepted - r.preview.length} more ready to import.</p>` : ''}` : ''}
      ${problems.length ? `
        <div class="preview-scroll" style="max-height:24vh;margin-top:12px">
          <table class="data"><thead><tr><th>Row</th><th>Problem</th></tr></thead><tbody>
            ${problems.map((p) => `<tr>
              <td class="muted">${p.line}</td>
              <td><b>${esc(p.kind)}</b> — ${esc((p.errors || []).join(' '))}
                ${p.name ? `<div class="small muted">${esc(String(p.name).slice(0, 120))}</div>` : ''}</td>
            </tr>`).join('')}
          </tbody></table>
        </div>` : ''}
      ${!r.accepted ? '<p class="small muted">Nothing can be imported from this file yet.</p>' : ''}`;
    const importBtn = [...rootEl.querySelectorAll('.m-foot .btn')].pop();
    importBtn.disabled = !r.accepted;
  };

  // The commit runs in pages of IMPORT_PAGE_ROWS. A page costs the server
  // ~22 ms per portal user (a password hash each) before any network, so the
  // 2000-row file the dry run validates in a blink would run ~45 s as one
  // request — killed by a serverless function's timeout with the candidates
  // written and their logins not. Pages keep every request a few seconds
  // long, show progress, and leave a re-uploadable state behind if one fails:
  // rows already imported are simply reported as duplicates next time.
  const renderProgress = (done, total) => {
    const report = part('#ic-report');
    const pct = total ? Math.round((done / total) * 100) : 0;
    report.innerHTML = `
      <div class="import-summary" role="status" aria-live="polite">
        ${badge(`Importing… ${done} of ${total} rows`, 'blue')}
        <span class="small muted">${pct}% · keep this dialog open</span>
      </div>
      <div class="progress" style="margin-top:10px;height:8px;background:var(--line);border-radius:4px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--blue)"></div>
      </div>`;
  };

  const renderSuccess = (out) => {
    const report = part('#ic-report');
    const creds = out.credentials || [];
    const skipped = (out.auto_allocations || []).filter((a) => !a.allocated).length;
    const unassigned = (out.auto_allocations || []).filter((a) => a.allocated && !a.assessor_id).length;
    report.innerHTML = `
      <div class="import-summary">
        ${badge(`${out.imported} imported`, 'green')}
        ${out.users_created ? badge(`${out.users_created} user${out.users_created === 1 ? '' : 's'} created`, 'blue') : ''}
        ${out.auto_allocated ? badge(`${out.auto_allocated} assessment${out.auto_allocated === 1 ? '' : 's'} auto-allocated`, 'green') : ''}
        ${out.stopped ? badge('stopped early', 'red') : ''}
      </div>
      ${out.stopped ? `<p class="small" style="margin:8px 0 0;color:var(--red);font-weight:700">The import stopped after row ${out.stopped_at} of ${out.total}: ${esc(out.stopped)}.
        Everything above is in the directory. Upload the same file again to import the rest — rows already imported are skipped as duplicates.</p>` : ''}
      ${skipped ? `<p class="small muted" style="margin:8px 0 0">${skipped} row${skipped === 1 ? '' : 's'} imported without an assessment (no track or empty bank) — allocate manually from the candidate record.</p>` : ''}
      ${(out.candidate_ids || []).length ? `
        <div class="card flat" id="ic-bulk-assessor" style="margin-top:12px;padding:12px 14px">
          <b>Assessor for ${out.candidate_ids.length === 1 ? 'the imported candidate' : `all ${out.candidate_ids.length} imported candidates`}</b>
          <div class="small muted" style="margin:2px 0 8px">${unassigned
            ? `${unassigned} assessment${unassigned === 1 ? ' was' : 's were'} allocated without an assessor. `
            : ''}Pick one assessor to set on every candidate from this import at once — their assessments move with it. You can still change any candidate individually from Edit.</div>
          <div class="row" style="gap:8px;align-items:center">
            <select id="ic-apply-assessor" aria-label="Assessor for all imported candidates">
              <option value="">— choose an assessor —</option>
              ${assessorOptions.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn secondary sm" id="ic-apply-btn">Apply to all</button>
            <span class="small" id="ic-apply-status" role="status" aria-live="polite"></span>
          </div>
        </div>` : ''}
      ${creds.length ? `
        <div class="preview-scroll" style="max-height:32vh;margin-top:12px">
          <table class="data"><thead><tr><th>Name</th><th>Username</th><th>Password</th></tr></thead><tbody>
            ${creds.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.username)}</td><td class="mono">${esc(c.password)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <p class="small muted" style="margin-top:10px">
          Credentials are shown only once — save them now.
          <button type="button" class="btn secondary sm" id="ic-dl-creds" style="margin-left:6px">Download credentials (.csv)</button>
        </p>` : ''}
      <p class="small muted" style="margin-top:10px">${out.imported} candidate${out.imported === 1 ? '' : 's'} added to the directory.</p>`;
    const applyBtn = part('#ic-apply-btn');
    if (applyBtn) applyBtn.onclick = async () => {
      const sel = part('#ic-apply-assessor');
      const status = part('#ic-apply-status');
      if (!sel.value) { toast('Choose an assessor first.', 'error'); sel.focus(); return; }
      applyBtn.disabled = true;
      status.textContent = 'Applying…';
      const res = await attempt(() => api('/admin/candidates/assessor', {
        method: 'POST', body: { candidate_ids: out.candidate_ids, assessor_id: sel.value },
      }));
      applyBtn.disabled = false;
      if (!res) { status.textContent = ''; return; }
      status.textContent = `${res.assessor_name} set on ${res.updated} candidate${res.updated === 1 ? '' : 's'}`
        + (res.reassigned_assessments ? ` · ${res.reassigned_assessments} assessment${res.reassigned_assessments === 1 ? '' : 's'} moved` : '');
      toast(`Assessor set to ${res.assessor_name} for ${res.updated} candidate${res.updated === 1 ? '' : 's'}`, 'success');
    };
    const dl = part('#ic-dl-creds');
    if (dl) dl.onclick = () => downloadText(
      'ecod-imported-credentials.csv',
      ['name,username,password', ...creds.map((c) => [c.name, c.username, c.password].map(csvCell).join(','))].join('\n'),
      'text/csv',
    );
  };

  const m = modal({
    title: 'Import candidates from Excel',
    wide: true,
    bodyHtml: body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Import',
        onClick: async (close, btn) => {
          if (!checked || !checked.accepted) {
            toast('Choose a file with at least one valid row first.', 'error');
            return;
          }
          btn.disabled = true;
          const createUsers = part('#ic-users')?.checked !== false;
          const autoAllocate = part('#ic-alloc')?.checked !== false;
          const assessorId = part('#ic-assessor')?.value || '';
          const total = checked.total || 0;
          const sum = { imported: 0, users_created: 0, auto_allocated: 0, credentials: [], auto_allocations: [], candidate_ids: [], total, stopped: '', stopped_at: 0 };
          let offset = 0;
          for (;;) {
            renderProgress(offset, total);
            let page;
            try {
              page = await api('/admin/candidates/import', {
                method: 'POST',
                body: { ...payload, dry_run: false, create_users: createUsers, auto_allocate: autoAllocate, assessor_id: assessorId || undefined, offset, limit: IMPORT_PAGE_ROWS },
              });
            } catch (err) {
              sum.stopped = err.message || 'the request failed';
              sum.stopped_at = offset;
              break;
            }
            sum.imported += page.imported || 0;
            sum.users_created += page.users_created || 0;
            sum.auto_allocated += page.auto_allocated || 0;
            sum.credentials.push(...(page.credentials || []));
            sum.auto_allocations.push(...(page.auto_allocations || []));
            sum.candidate_ids.push(...(page.imported_candidate_ids || []));
            if (sum.imported || sum.users_created) committed = true;
            const next = page.page?.next_offset;
            if (next == null || next <= offset) break;
            offset = next;
          }
          btn.disabled = false;
          if (sum.stopped && !committed) {
            // Nothing was written: back to the validated report, ready to retry.
            toast(`Import failed: ${sum.stopped}`, 'error');
            renderReport(checked);
            return;
          }
          renderSuccess(sum);
          btn.textContent = 'Done';
          btn.onclick = () => close();
        },
      },
    ],
    // After a successful import the dialog stays open (credentials), so any
    // way it is closed afterwards — Done, ✕, Esc, backdrop — refreshes the
    // list. Cancel before a commit never refreshes anything.
    onClose: () => { if (committed) onDone?.(); },
    onOpen: (root) => {
      rootEl = root;
      const file = root.querySelector('#ic-file');
      const drop = root.querySelector('#ic-drop');
      const name = root.querySelector('#ic-name');
      const usersToggle = root.querySelector('#ic-users');
      const allocToggle = root.querySelector('#ic-alloc');
      const assessorSel = root.querySelector('#ic-assessor');
      const report = root.querySelector('#ic-report');
      const importBtn = [...root.querySelectorAll('.m-foot .btn')].pop();
      importBtn.disabled = true;

      // The assessor list loads in the background; the dialog is usable
      // (file, toggles) before it arrives and the selector fills in when it does.
      loadAssessors().then((assessors) => {
        assessorOptions = assessors;
        if (!assessorSel?.isConnected) return;
        for (const u of assessors) {
          const opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = u.name;
          assessorSel.appendChild(opt);
        }
      }).catch(() => { /* the selector just stays at "unassigned" */ });

      const check = async (f) => {
        checked = null;
        payload = null;
        lastFile = f;
        importBtn.disabled = true;
        name.textContent = f.name;
        report.innerHTML = '<p class="small muted">Checking…</p>';

        const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv';
        try {
          payload = isCsv
            ? { csv: await f.text(), filename: f.name }
            : { file_base64: await fileToBase64(f), filename: f.name };
        } catch {
          report.innerHTML = '<p class="small muted">That file could not be read.</p>';
          return;
        }

        const createUsers = usersToggle.checked !== false;
        const autoAllocate = allocToggle.checked !== false;
        const assessorId = assessorSel?.value || '';
        try {
          const out = await api('/admin/candidates/import', {
            method: 'POST',
            body: { ...payload, dry_run: true, create_users: createUsers, auto_allocate: autoAllocate, assessor_id: assessorId || undefined },
          });
          checked = out;
          renderReport(out);
        } catch (err) {
          checked = null;
          report.innerHTML = `<div class="import-summary">${badge('Cannot read this file', 'red')}</div>
            <p class="small muted">${esc(err.message)}</p>`;
        }
      };

      root.querySelector('#ic-browse').onclick = () => file.click();
      drop.onclick = (e) => { if (!e.target.closest('button')) file.click(); };
      file.onchange = () => { if (file.files[0]) check(file.files[0]); };
      usersToggle.onchange = () => { if (lastFile) check(lastFile); };
      allocToggle.onchange = () => { if (lastFile) check(lastFile); };
      if (assessorSel) assessorSel.onchange = () => { if (lastFile) check(lastFile); };
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) check(f);
      });
      root.querySelector('#ic-template').onclick = async (e) => {
        e.preventDefault();
        const tpl = await attempt(() => api('/admin/candidates/import-template'));
        if (tpl) downloadText(tpl.filename, tpl.csv, tpl.content_type);
      };
    },
  });
  return m;
}

/** Read a File as bare base64 (no data-URI prefix), for JSON upload. */
