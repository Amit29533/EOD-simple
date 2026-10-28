import { api } from '../../api.js';
import { state } from '../../app.js';
import { esc, badge, dataTable, loading, emptyState, toast, attempt, formModal, confirmModal, modal } from '../../ui.js';
import { loadAssessors, trackAssessorLabel, trackAssessorField } from './candidates.js';
import { modulesView } from './question-bank.js';

/** Roles & frameworks: tracks, competencies, scoring framework and the question editor. */
export async function installPublishedTrack(roleKey) {
  const out = await attempt(() => api('/admin/content/tracks', { method: 'POST', body: { role_key: roleKey } }));
  if (!out) return null;
  if (out.created) {
    toast(`${out.role?.name || 'Track'} added — ${out.competencies_added} competencies, ${out.bank_total} question${out.bank_total === 1 ? '' : 's'} and a default scoring framework`, 'success');
  } else {
    toast(out.added
      ? `Added ${out.added} published question${out.added === 1 ? '' : 's'} — the bank now has ${out.bank_total}`
      : 'This track already has the full published catalogue.', 'success');
  }
  return out;
}

export async function rolesView(view) {
  view.innerHTML = loading();
  // The published-track list is advisory: if it fails the roles table still
  // renders (attempt() has already shown the error).
  const [{ roles }, tracksOut] = await Promise.all([
    api('/admin/roles'),
    attempt(() => api('/admin/content/tracks')),
  ]);
  const tracks = tracksOut?.tracks || [];
  const trackState = (t) => {
    if (!t.installed) return badge('Not in this workspace', 'amber');
    if (!t.active) return badge('Deactivated', 'grey');
    if (t.missing > 0) return badge(`${t.missing} published question${t.missing === 1 ? '' : 's'} missing`, 'amber');
    return badge('Installed', 'green');
  };
  const trackAction = (t) => {
    if (!t.installed) return `<button class="btn sm" data-install-track="${esc(t.role_key)}">Add to workspace</button>`;
    if (!t.active) return `<a class="btn ghost sm" href="#/roles/${t.role.id}">Reactivate</a>`;
    if (t.missing > 0) return `<button class="btn secondary sm" data-install-track="${esc(t.role_key)}">Add ${t.missing} published question${t.missing === 1 ? '' : 's'}</button>`;
    return `<a class="btn ghost sm" href="#/roles/${t.role.id}">Configure</a>`;
  };
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Capability architecture</div><h1>Roles & frameworks</h1><p>Competencies, scoring bands and tracks.</p></div>
      <div class="heading-actions"><button class="btn" id="add-role">＋ New role / track</button></div>
    </div>
    <div class="card flat info-strip"><span class="info-strip-icon">✦</span><span>Assessment tracks are configuration, not code. Change the framework here and new assessments use it automatically.</span></div>
    <div class="card table-card">
      ${roles.length ? dataTable([
        { label: 'Role', cls: 'track-name-cell', render: (r) => `<a href="#/roles/${r.id}"><b>${esc(r.name)}</b></a><div class="small muted">${esc(r.key)} · ${esc(r.technology)}</div>` },
        { label: 'Competencies', render: (r) => esc(r.competency_count) },
        { label: 'Questions', render: (r) => esc(r.question_count) },
        { label: 'Auto allocation', render: (r) => `${esc(r.default_question_count)} questions` },
        { label: 'Default assessor', render: trackAssessorLabel },
        { label: 'Assessments', render: (r) => esc(r.assessment_count) },
        { label: 'Status', render: (r) => r.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey') },
        { label: '', cls: 'actions', render: (r) => `<a class="btn ghost sm" href="#/roles/${r.id}">Configure</a>
          <a class="btn ghost sm" href="#/modules?role=${r.id}">Questions</a>` },
      ], roles) : emptyState('No roles yet', 'Create your first assessment track, or add a published one below.')}
    </div>
    ${tracks.length ? `
    <div class="card" id="published-tracks">
      <div class="row between" style="align-items:flex-start;gap:16px">
        <div>
          <h3 style="margin:0">Published tracks</h3>
          <p class="small muted" style="margin:4px 0 0">Tracks that ship with the platform. Adding one creates its role, competencies, default scoring framework and published questions — a workspace seeded before a track was published does not get it automatically.</p>
        </div>
        <span class="chip">${tracks.filter((t) => t.installed && t.active).length} of ${tracks.length} installed</span>
      </div>
      ${dataTable([
        { label: 'Track', render: (t) => `<b>${esc(t.role_name)}</b><div class="small muted">${esc(t.role_key)} · ${esc(t.technology)}</div>` },
        { label: 'Ships with', render: (t) => `${esc(t.competency_total)} competencies · ${t.authoring_only
          ? '<span class="muted">no published questions yet — author them in the Question bank</span>'
          : `${esc(t.catalogue_total)} published question${t.catalogue_total === 1 ? '' : 's'}`}` },
        { label: 'In this workspace', render: (t) => `${trackState(t)}${t.installed ? `<div class="small muted" style="margin-top:4px">${esc(t.bank_total)} question${t.bank_total === 1 ? '' : 's'} in the bank</div>` : ''}` },
        { label: '', cls: 'actions', render: trackAction },
      ], tracks)}
    </div>` : ''}`;
  for (const btn of view.querySelectorAll('[data-install-track]')) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Adding…';
      await installPublishedTrack(btn.dataset.installTrack);
      // Re-render either way: on success the track joins the roles table; on
      // failure (error already shown) the button comes back enabled.
      rolesView(view);
    };
  }
  view.querySelector('#add-role').onclick = async () => {
    const assessors = await attempt(loadAssessors);
    if (!assessors) return;
    const saved = await formModal({
      title: 'New assessment track',
      fields: [
        { name: 'name', label: 'Role name', required: true, placeholder: 'e.g. Resident Solutions Architect (RSA)' },
        { name: 'key', label: 'Key (slug)', required: true, placeholder: 'e.g. databricks-rsa', help: 'Lowercase letters, numbers, dashes.' },
        { name: 'technology', label: 'Technology', required: true, placeholder: 'e.g. Databricks' },
        trackAssessorField(assessors),
        { name: 'default_question_count', label: 'Default automatic allocation', type: 'number', required: true, min: 1, max: 50, value: 50, help: 'Used when candidate users are created individually or imported by CSV.' },
        { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
      ],
      onSubmit: (vals) => api('/admin/roles', { method: 'POST', body: vals }),
    });
    if (!saved) return;
    toast('Role created with a default scoring framework', 'success');
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
      <a class="btn secondary sm" href="#/modules?role=${role.id}">Open in the question bank (${d.questions.length})</a>
    </div></div>
    <div class="card">
      <div class="row between">
        <div><h2 style="margin:0">${esc(role.name)}</h2><div class="muted small">${esc(role.key)} · ${esc(role.technology)}</div></div>
        <div class="row">${role.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey')}<button class="btn secondary sm" id="edit-role">Edit</button><button class="btn ghost sm" id="del-role" style="color:var(--red)">Delete</button></div>
      </div>
      ${role.description ? `<p class="small muted" style="margin-top:8px">${esc(role.description)}</p>` : ''}
      <div class="small" style="margin-top:10px"><b>Default automatic allocation:</b> ${esc(role.default_question_count)} questions</div>
      <div class="small" style="margin-top:10px"><b>Default assessor:</b> ${trackAssessorLabel(role)}</div>
      <p class="small muted">The default receives new automatic bookings and allocations. Choose one using Edit; existing assessments can be reassigned from Assessments.</p>
      ${['databricks-rsa', 'databricks-ai-bi-genie'].includes(role.key) ? '<p class="small">Fixed 20-module blueprint: 30 technical objective + 10 technical open + 10 non-technical open. Manage the question pool in Question Bank; competency weights below determine report scoring.</p>' : ''}
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
    const saved = await formModal({
      title: c ? `Edit ${c.name}` : 'Add competency', fields: compFields,
      values: c || { target_level: 4, active: true, order: d.competencies.length + 1 }, wide: true,
      onSubmit: (vals) => (c
        ? api(`/admin/competencies/${c.id}`, { method: 'PATCH', body: vals })
        : api('/admin/competencies', { method: 'POST', body: { ...vals, role_id: role.id } })),
    });
    if (!saved) return;
    toast(c ? 'Competency updated' : 'Competency added', 'success');
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
    const assessors = await attempt(loadAssessors);
    if (!assessors) return;
    const saved = await formModal({
      title: 'Edit role', values: role,
      fields: [
        { name: 'name', label: 'Role name', required: true },
        { name: 'technology', label: 'Technology', required: true },
        trackAssessorField(assessors, role),
        { name: 'default_question_count', label: 'Default automatic allocation', type: 'number', required: true, min: 1, max: 50,
          readonly: ['databricks-rsa', 'databricks-ai-bi-genie'].includes(role.key),
          help: ['databricks-rsa', 'databricks-ai-bi-genie'].includes(role.key) ? 'Fixed at 50 by the 20-module blueprint. Existing assessments keep their saved paper.' : 'Used for new candidate-user and CSV auto allocations. Existing assessments keep their saved paper.' },
        { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
        { name: 'active', label: 'Active', type: 'checkbox' },
      ],
      onSubmit: (vals) => api(`/admin/roles/${role.id}`, { method: 'PATCH', body: vals }),
    });
    if (!saved) return;
    toast('Role updated', 'success');
    roleDetailView(view, { id });
  };
  view.querySelector('#del-role').onclick = async () => {
    const yes = await confirmModal('Delete role', `Delete the "${role.name}" track and all of its competencies and questions? In-flight assessments keep their snapshot and are unaffected. Roles with assessments on record cannot be deleted — deactivate them instead.`, 'Delete', true);
    if (!yes) return;
    const out = await attempt(() => api(`/admin/roles/${role.id}`, { method: 'DELETE' }));
    if (out) location.hash = '#/roles';
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

/* ============================ Question editor ============================ */
/**
 * The competency-based question editor.
 *
 * The standalone "Question Bank" screen this used to power is gone: its list,
 * filters, published-catalogue sync and editing all live on the Modules screen
 * now (see modulesView -> "Served question set"), so there is one place to
 * manage questions instead of two that duplicate each other.
 */
/** Custom editor: dynamic options with correct-answer markers, type-conditional fields. Exported for its tests. */
export function questionEditorModal(existing, competencies) {
  return new Promise((resolve) => {
    // Answer exactly once: Esc, the backdrop and ✕ mean "cancelled" (they
    // used to leave the promise pending), and Save settles before close().
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
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
        <div id="qe-mic-note" class="info-strip">
          <span class="info-strip-icon">🎙</span>
          <span>Open questions are answered <b>out loud</b>: the exam shows a microphone recorder and the candidate must submit a recording. The text box beside it is optional supporting notes. This requirement comes from the question type and cannot be turned off.</span>
        </div>
        <div id="qe-options-zone">
          <span class="lbl" style="display:block;font-size:12.5px;font-weight:600;color:var(--ink-2);margin-bottom:6px">Options & correct answer(s)</span>
          <div id="qe-multi-note" class="small muted" style="margin:0 0 8px">Multi-select scoring is all-or-nothing: the candidate must pick every correct option and no others. Any incorrect choice scores the question at zero.</div>
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
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { settle(null); close(); } },
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
            settle(out);
            close();
          },
        },
      ],
      onClose: () => settle(null),
      onOpen: (el) => {
        const zone = el.querySelector('#qe-options-zone');
        const rubricZone = el.querySelector('#qe-rubric-zone');
        const micNote = el.querySelector('#qe-mic-note');
        const multiNote = el.querySelector('#qe-multi-note');
        const syncVisibility = () => {
          zone.style.display = ['mcq_single', 'mcq_multi'].includes(v.type) ? '' : 'none';
          rubricZone.style.display = v.type === 'text' ? '' : 'none';
          if (micNote) micNote.style.display = v.type === 'text' ? '' : 'none';
          if (multiNote) multiNote.style.display = v.type === 'mcq_multi' ? '' : 'none';
        };
        syncVisibility();
        const syncFromDom = () => {
          options.forEach((o, i) => {
            const input = el.querySelector(`[data-opt-label="${i}"]`);
            if (input) o.label = input.value;
          });
          const checked = [...el.querySelectorAll('input[name=qe-correct]:checked')].map((x) => x.value);
          v.correct_option_ids = checked;
        };
        const wireOpts = () => {
          el.querySelectorAll('[data-opt-del]').forEach((b) => (b.onclick = () => {
            syncFromDom();
            const idx = Number(b.dataset.optDel);
            const removed = options[idx];
            if (removed) {
              v.correct_option_ids = (v.correct_option_ids || []).filter((id) => id !== removed.id);
            }
            options.splice(idx, 1);
            refreshOpts();
          }));
          el.querySelectorAll('input[name=qe-correct]').forEach((input) => {
            input.onchange = () => {
              const checked = [...el.querySelectorAll('input[name=qe-correct]:checked')].map((x) => x.value);
              v.correct_option_ids = checked;
            };
          });
          el.querySelectorAll('[data-opt-label]').forEach((input) => {
            input.oninput = () => {
              const idx = Number(input.dataset.optLabel);
              if (options[idx]) options[idx].label = input.value;
            };
          });
        };
        const refreshOpts = () => { el.querySelector('#qe-opts').innerHTML = optionRows(); wireOpts(); };
        wireOpts();
        el.querySelector('#qe-add-opt').onclick = () => {
          syncFromDom();
          const used = new Set(options.map((o) => o.id));
          let next = '';
          for (let i = 0; i < 26; i += 1) {
            const id = String.fromCharCode(97 + i);
            if (!used.has(id)) { next = id; break; }
          }
          if (!next) next = `o${options.length + 1}`;
          options.push({ id: next, label: '' });
          refreshOpts();
        };
        el.querySelector('#qe-type').onchange = (e) => {
          syncFromDom();
          v.type = e.target.value;
          if (v.type === 'mcq_single' && v.correct_option_ids?.length > 1) {
            v.correct_option_ids = [v.correct_option_ids[0]];
          }
          syncVisibility();
          refreshOpts();
        };
      },
    });
  });
}

/* ================================ Users & access ================================ */
