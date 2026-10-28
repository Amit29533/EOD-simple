import { api, apiAll } from '../../api.js';
import { esc, badge, dataTable, loading, emptyState, toast, attempt, confirmModal, modal } from '../../ui.js';
import { renderReport } from '../report.js';
import { M, maxAssessmentQuestions, refresh, fileToBase64, downloadText } from './shared.js';
import { installPublishedTrack, questionEditorModal } from './roles.js';

/** Question Bank: modules, families, authoring, preview and import. */
export function questionScope(a) {
  const n = a.question_count ?? null;
  if (n === null) return '<span class="muted">—</span>';
  const capped = a.question_limit != null && a.bank_total != null && a.bank_total > n;
  return capped
    ? `<b>${esc(n)}</b><span class="muted small"> of ${esc(a.bank_total)}</span>`
    : `<b>${esc(n)}</b>`;
}


export async function modulesView(view) {
  view.innerHTML = loading();
  // ONE screen for the whole bank. The module -> family tree is the primary
  // view; below it sits the role/competency question set that allocation
  // actually serves today (the same retired catalogue the tree lists as its
  // optional pool). `role` in the query string is what the Roles screen links
  // here with. For tracks with a published module bank it selects that bank;
  // for the served panel it filters by role either way.
  const hashQuery = new URLSearchParams(location.hash.split('?')[1] || '');
  const roleParam = hashQuery.get('role') || '';
  // `bank` addresses a published module bank by role key for a track that has
  // no workspace role yet (nothing to link by id); it is what the Track
  // selector falls back to, so choosing such a track does not snap back to
  // the default bank.
  const bankParam = hashQuery.get('bank') || '';
  const rolesOut = await attempt(() => api('/admin/roles'));
  const roles = rolesOut?.roles || [];
  const banks = M()?.moduleBanks || [];
  const defaultBankKey = M()?.defaultModuleBankRoleKey || banks[0]?.role_key || '';
  const viewedRole = roles.find((r) => r.id === roleParam) || null;
  const hasBank = (key) => banks.some((b) => b.role_key === key);
  // The module bank is addressed by the track's stable role key; a viewed
  // role without a module bank (e.g. Senior Consultant) keeps the default
  // bank while its served set is still filterable below.
  const roleKey = viewedRole && hasBank(viewedRole.key)
    ? viewedRole.key
    : (bankParam && hasBank(bankParam) ? bankParam : defaultBankKey);
  // The published catalogue to report against: the viewed role's, else the
  // bank being browsed (which may not be installed in this workspace yet).
  const catalogueKey = viewedRole ? viewedRole.key : (bankParam || '');
  const [bank, plan, servedOut, catalogue] = await Promise.all([
    api(`/admin/question-bank/modules?include_optional=1&role_key=${roleKey}`),
    attempt(() => api(`/admin/question-bank/plan?role_key=${roleKey}`)),
    // roleParam is raw hash-query input: encode it so a `&`/`#` inside a
    // crafted ?role= value cannot inject extra query params or truncate the
    // URL (the catalogueKey call below already encodes for the same reason).
    attempt(() => apiAll(`/admin/questions${roleParam ? `?role_id=${encodeURIComponent(roleParam)}` : ''}`, 'questions')),
    attempt(() => api(`/admin/content/catalogue${catalogueKey ? `?role_key=${encodeURIComponent(catalogueKey)}` : ''}`)),
  ]);
  const served = servedOut || [];
  const missing = catalogue?.available ? Number(catalogue.missing) || 0 : 0;
  // A published track this workspace does not have yet: the module bank is
  // browsable (it is static content) but nothing can be allocated from it
  // until the track is added — role, competencies, framework and questions.
  const installable = catalogue && catalogue.available === false && catalogue.installable === true
    && catalogue.role_key && !roles.some((r) => r.key === catalogue.role_key && r.active !== false)
    ? catalogue : null;
  const inactiveTrack = catalogue && catalogue.available === false && catalogue.inactive_role ? catalogue.inactive_role : null;

  const bp = bank.blueprint;
  const groupName = Object.fromEntries(bank.groups.map((g) => [g.key, g.name]));
  const typeLabel = Object.fromEntries((M()?.questionTypes || []).map((t) => [t.key, t.label]));
  const planFor = new Map((plan?.modules || []).map((r) => [r.module, r]));
  const modules = [...bank.modules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Per-module quota, derived from the published blueprint rather than
  // restated, so changing the paper shape updates this copy with it.
  const perTechnicalObjective = Math.round(bp.technical_objective / (bank.technical_modules || 10));
  const perTechnicalOpen = Math.round(bp.technical_open / (bank.technical_modules || 10));
  const quota = (m) => {
    if (m.quota && (m.quota.objective !== undefined || m.quota.open !== undefined)) {
      const parts = [];
      if (m.quota.objective) parts.push(`${m.quota.objective} objective`);
      if (m.quota.open) parts.push(`${m.quota.open} open`);
      return parts.join(' + ') || 'none';
    }
    const r = planFor.get(m.key);
    if (r && (r.required_objective !== undefined || r.required_open !== undefined)) {
      const parts = [];
      if (r.required_objective) parts.push(`${r.required_objective} objective`);
      if (r.required_open) parts.push(`${r.required_open} open`);
      return parts.join(' + ') || 'none';
    }
    return m.technical ? `${perTechnicalObjective} objective + ${perTechnicalOpen} open` : '1 open';
  };
  const roleChip = (role) => role === 'objective'
    ? '<span class="chip">Objective</span>'
    : role === 'mixed'
      ? '<span class="chip">Mixed</span>'
      : '<span class="chip">Open</span>';

  view.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="eyebrow">Assessment design</div>
        <h1>Question bank</h1>
        <p>v${esc(bank.version)} — ${esc(bank.role_name || '')} — ${bank.bank_total} questions in
           ${modules.length} modules, organised into ${bank.family_total} families.
           A new module question belongs to exactly one family inside one module.
           RSA and AI/BI exams use these module families. SAMA and custom-role
           exam questions are managed in the role question catalogue below.</p>
      </div>
    </div>
    <div class="card flat bank-toolbar">
        ${banks.length > 1 ? `
        <label class="f bank-track">
          <span class="lbl">Track</span>
          <select id="mv-bank" aria-label="Module bank track">
            ${banks.map((b) => `<option value="${esc(b.role_key)}" ${b.role_key === roleKey ? 'selected' : ''}>${esc(b.role_name)} (v${esc(b.version)})</option>`).join('')}
          </select>
        </label>` : ''}
      <div class="bank-actions">
        <button class="btn secondary" id="mv-import">Import (.xlsx / .csv)</button>
        <button class="btn secondary" id="mv-add">Add question</button>
        <button class="btn" id="mv-preview">Preview default assessment</button>
      </div>
    </div>

    <div class="card flat blueprint-strip">
      <span class="info-strip-icon">≡</span>
      <span class="catalogue-strip-copy">
        <b>Every generated test contains ${bp.total} questions.</b>
        <small>${bp.technical_objective} technical objective${bp.non_technical_objective ? ` · ${bp.non_technical_objective} consulting objective` : ''} ·
          ${bp.technical_open} technical open · ${bp.non_technical_open} non-technical open.
          Questions are drawn at random from each module's families while this structure is held exactly.</small>
      </span>
      ${plan && plan.ready ? badge('All modules ready', 'green') : badge('Some modules are short', 'amber')}
    </div>
    ${installable ? `
    <div class="card flat catalogue-strip" id="track-install">
      <span class="info-strip-icon">＋</span>
      <span class="catalogue-strip-copy"><b>The ${esc(installable.role_name)} track is not in this workspace yet.</b>
        <small>Its module bank is browsable here, but nothing can be allocated from it until the track is added. Adding it creates the role, its ${esc(installable.competency_total)} competencies, a default scoring framework and ${installable.catalogue_total
          ? `its ${esc(installable.catalogue_total)} published question${installable.catalogue_total === 1 ? '' : 's'}`
          : 'an empty bank ready for authoring'} under Roles &amp; frameworks.</small></span>
      <button class="btn sm" id="track-install-btn">Add track to workspace</button>
    </div>` : ''}
    ${inactiveTrack ? `
    <div class="card flat catalogue-strip" id="track-inactive">
      <span class="info-strip-icon">!</span>
      <span class="catalogue-strip-copy"><b>The ${esc(inactiveTrack.name)} track is deactivated in this workspace.</b>
        <small>Reactivate it under Roles &amp; frameworks to allocate from this bank again.</small></span>
      <a class="btn secondary sm" href="#/roles/${esc(inactiveTrack.id)}">Open track</a>
    </div>` : ''}

    <div class="card flat bank-controls" aria-label="Question bank module controls">
      <label class="bank-search"><span class="sr-only">Find a module or family</span><input id="mv-module-search" type="search" placeholder="Find a module or family…" autocomplete="off"></label>
      <span class="toolbar-hint" id="mv-module-count">${modules.length} modules</span>
      <div class="row"><button class="btn ghost sm" id="mv-expand-all">Expand all</button><button class="btn ghost sm" id="mv-collapse-all">Collapse all</button></div>
    </div>
    <div class="module-list" id="mv-module-list">
    ${modules.map((m, moduleIndex) => {
      const row = planFor.get(m.key);
      const open = moduleIndex === 0;
      return `
      <details class="card module-card" ${open ? 'open' : ''} data-module="${esc(m.key)}">
        <summary class="module-summary">
          <span class="module-key">${esc(m.key)}</span>
          <span class="module-title">
            <b>${esc(m.name)}</b>
            <small>${esc(groupName[m.group] || m.group)} · serves ${esc(quota(m))}</small>
          </span>
          <span class="module-metrics">
            <span class="chip">${m.objective} objective</span>
            <span class="chip">${m.open} open</span>
            ${m.inactive ? `<span class="chip chip-optional">${m.inactive} inactive</span>` : ''}
            ${m.optional ? `<span class="chip chip-optional">${m.optional} optional</span>` : ''}
            ${row ? (row.sufficient ? badge('Ready', 'green') : badge('Short', 'amber')) : ''}
          </span>
        </summary>
        <div class="family-table" tabindex="0" role="region" aria-label="${esc(m.name)} families — scrollable table">
          ${dataTable([
            { label: 'Family', render: (f) => `<b>${esc(f.name)}</b><div class="small muted mono">${esc(f.id)}</div>` },
            { label: 'Holds', render: (f) => roleChip(f.role) },
            { label: 'Objective', render: (f) => esc(f.objective) },
            { label: 'Open', render: (f) => esc(f.open) },
            { label: 'Optional', render: (f) => f.optional ? `<span class="chip chip-optional">${esc(f.optional)}</span>` : '—' },
            { label: '', cls: 'actions', render: (f) =>
                `<button class="btn ghost sm" data-family="${esc(f.id)}">View</button>` },
          ], m.families)}
          <div class="module-foot">
            <button class="btn ghost sm" data-add-module="${esc(m.key)}">+ Add a question to ${esc(m.key)}</button>
          </div>
        </div>
      </details>`;
    }).join('')}
    </div>

    ${bank.optional && bank.optional.total ? `<div class="card flat">
      <div class="panel-head"><div><h2>Optional pool</h2>
        <p class="small muted">The retired catalogue, mapped onto these modules and kept as a
        fallback. Never served while a family can fill its module's quota — only drawn to cover a
        shortfall.</p></div>
        <span class="chip chip-optional">${bank.optional.total} questions</span></div>
    </div>` : ''}

    <div class="card" id="served-set">
      <div class="panel-head">
        <div><h2>Role question catalogue</h2>
          <p class="small muted">Questions grouped by role and competency. SAMA and custom-role exams use this catalogue;
          RSA and AI/BI exams use the module families above. Existing assessments keep their allocated snapshot,
          so edits affect future allocations only.</p></div>
        <div class="row">
          <span class="chip">${served.length} in view</span>
          <button class="btn secondary sm" id="served-add">＋ Add question</button>
        </div>
      </div>
      ${missing ? `
      <div class="card flat catalogue-strip">
        <span class="info-strip-icon">＋</span>
        <span class="catalogue-strip-copy"><b>${missing} published question${missing === 1 ? '' : 's'} not in this workspace yet.</b>
          <small>The published ${esc(catalogue.role.name)} catalogue carries ${catalogue.catalogue_total} questions — this bank has ${catalogue.bank_total}, so assessments top out below the ${maxAssessmentQuestions()}-question cap.</small></span>
        <button class="btn sm" id="served-sync">Add published questions</button>
      </div>` : ''}
      <div class="card flat toolbar-card served-toolbar">
        <div class="toolbar-label"><span class="toolbar-icon">⌕</span><span>Find questions</span></div>
        <input id="served-search" type="search" placeholder="Search prompt or competency…" autocomplete="off" aria-label="Search served questions">
        <select id="served-role" aria-label="Filter the served set by role"><option value="">All roles</option>
          ${roles.map((r) => `<option value="${r.id}" ${r.id === roleParam ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        <select id="served-type" aria-label="Filter by question type"><option value="">All types</option>
          ${Object.entries(typeLabel).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select>
        <select id="served-status" aria-label="Filter by question status"><option value="">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        <span class="toolbar-hint" id="served-result-count"></span>
      </div>
      <div class="table-card" id="served-results"></div>
      <div class="pagination-bar" id="served-pagination" hidden></div>
    </div>`;

  // Re-render after a write so the counts, chips and readiness badges reflect
  // what was just added rather than going stale until the next navigation.
  const refresh = () => modulesView(view);

  // Keep the catalogue compact. Search includes family names, and bulk
  // controls make it quick to compare modules without opening every card by
  // default on a page that can contain dozens of tables.
  const moduleCards = [...view.querySelectorAll('.module-card')];
  const moduleSearch = view.querySelector('#mv-module-search');
  const updateModuleFilter = () => {
    const term = moduleSearch.value.trim().toLowerCase();
    let visible = 0;
    for (const card of moduleCards) {
      const match = !term || card.textContent.toLowerCase().includes(term);
      card.hidden = !match;
      if (match) { visible += 1; if (term) card.open = true; }
    }
    view.querySelector('#mv-module-count').textContent = `${visible} of ${moduleCards.length} modules`;
  };
  moduleSearch.oninput = updateModuleFilter;
  view.querySelector('#mv-expand-all').onclick = () => moduleCards.filter((c) => !c.hidden).forEach((c) => { c.open = true; });
  view.querySelector('#mv-collapse-all').onclick = () => moduleCards.forEach((c) => { c.open = false; });

  // Switching the track re-renders with the other bank. The hash carries the
  // role record id (what the Roles screen links with), so the served panel
  // below follows the same track.
  const bankSelect = view.querySelector('#mv-bank');
  if (bankSelect) bankSelect.onchange = (e) => {
    const key = e.target.value;
    const r = roles.find((x) => x.key === key && x.active !== false) || roles.find((x) => x.key === key);
    // No workspace role for this track yet: browse the bank by key (and offer
    // to add the track) instead of silently falling back to the default bank.
    location.hash = r ? `#/modules?role=${r.id}` : `#/modules?bank=${encodeURIComponent(key)}`;
  };

  const installBtn = view.querySelector('#track-install-btn');
  if (installBtn) installBtn.onclick = async () => {
    installBtn.disabled = true;
    installBtn.textContent = 'Adding…';
    const out = await installPublishedTrack(installable.role_key);
    if (!out) { installBtn.disabled = false; installBtn.textContent = 'Add track to workspace'; return; }
    // The track now has a role: address the screen by it so the served set
    // below shows the freshly added questions.
    const next = `#/modules?role=${out.role.id}`;
    if (location.hash === next) refresh(); else location.hash = next;
  };

  view.querySelector('#mv-preview').onclick = async () => {
    const out = await attempt(() => api('/admin/question-bank/preview', { method: 'POST', body: { role_key: roleKey, mode: 'allocation' } }));
    if (out) previewModal(out);
  };
  view.querySelector('#mv-add').onclick = () => addQuestionModal(bank, {}, refresh);
  view.querySelector('#mv-import').onclick = () => importQuestionsModal(refresh, bank);
  for (const btn of view.querySelectorAll('[data-family]')) {
    btn.onclick = async () => {
      const out = await attempt(() => api(`/admin/question-bank/families/${encodeURIComponent(btn.dataset.family)}?role_key=${roleKey}`));
      if (out) familyModal(out, bank, refresh);
    };
  }
  for (const btn of view.querySelectorAll('[data-add-module]')) {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      addQuestionModal(bank, { module: btn.dataset.addModule }, refresh);
    };
  }

  // ---- served question set: the role/competency bank allocation draws on ----
  // This is the panel the standalone Question Bank screen used to be. It stays
  // here so one screen manages every question in the platform.
  const syncBtn = view.querySelector('#served-sync');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Adding…';
    const out = await attempt(() => api('/admin/content/sync', { method: 'POST', body: { role_key: viewedRole?.key } }));
    if (!out) { syncBtn.disabled = false; syncBtn.textContent = 'Add published questions'; return; }
    toast(out.added
      ? `Added ${out.added} published question${out.added === 1 ? '' : 's'} — the bank now has ${out.bank_total}`
      : 'The bank already has the full published catalogue.', 'success');
    refresh();
  };

  const roleSelect = view.querySelector('#served-role');
  if (roleSelect) roleSelect.onchange = (e) => {
    location.hash = e.target.value ? `#/modules?role=${e.target.value}` : '#/modules';
  };

  const editServed = async (existing) => {
    const roleId = existing?.role_id || roleParam || roles[0]?.id;
    if (!roleId) { toast('Create a role first.', 'error'); return; }
    const detail = await attempt(() => api(`/admin/roles/${roleId}`));
    if (!detail) return;
    if (!detail.competencies?.length) { toast('Add competencies to this role first.', 'error'); return; }
    const vals = await questionEditorModal(existing, detail.competencies);
    if (!vals) return;
    await attempt(() => existing
      ? api(`/admin/questions/${existing.id}`, { method: 'PATCH', body: vals })
      : api('/admin/questions', { method: 'POST', body: { ...vals, role_id: roleId } }),
      { okMessage: existing ? 'Question updated' : 'Question added' });
    refresh();
  };
  const addServed = view.querySelector('#served-add');
  if (addServed) addServed.onclick = () => editServed(null);

  // The live set can contain hundreds of records. Filter and page it in the
  // browser so the screen remains useful without extra API traffic.
  const servedResults = view.querySelector('#served-results');
  const servedPagination = view.querySelector('#served-pagination');
  const servedSearch = view.querySelector('#served-search');
  const servedType = view.querySelector('#served-type');
  const servedStatus = view.querySelector('#served-status');
  let servedPage = 1;
  const pageSize = 25;
  const renderServed = () => {
    const term = servedSearch.value.trim().toLowerCase();
    const type = servedType.value;
    const status = servedStatus.value;
    const filtered = served.filter((q) => {
      const haystack = `${q.prompt || ''} ${q.competency_name || ''}`.toLowerCase();
      return (!term || haystack.includes(term))
        && (!type || q.type === type)
        && (!status || (status === 'active' ? q.active !== false : q.active === false));
    });
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    servedPage = Math.min(servedPage, pages);
    const start = (servedPage - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    view.querySelector('#served-result-count').textContent = `${filtered.length} of ${served.length} questions`;
    servedResults.innerHTML = rows.length ? dataTable([
      { label: 'Question', render: (qq) => `<div class="served-question-copy">${esc(qq.prompt)}</div><div class="small muted">${esc(qq.competency_name || '')}</div>` },
      { label: 'Type', render: (qq) => `<span class="chip">${esc(typeLabel[qq.type] || qq.type)}</span>${qq.audio_required ? '<div class="small muted" style="margin-top:4px">🎙 recorded answer required</div>' : ''}` },
      { label: 'Points', render: (qq) => esc(qq.points) },
      { label: 'Difficulty', render: (qq) => esc(qq.difficulty || '') },
      { label: 'Status', render: (qq) => qq.active !== false ? badge('Active', 'green') : badge('Inactive', 'grey') },
      { label: '', cls: 'actions', render: (qq) => `<button class="btn ghost sm" data-served-edit="${qq.id}">Edit</button><button class="btn ghost sm danger" data-served-del="${qq.id}">Delete</button>` },
    ], rows) : emptyState('No matching questions', 'Clear a filter or search for a different prompt or competency.');
    servedPagination.hidden = filtered.length <= pageSize;
    servedPagination.innerHTML = `<button class="btn ghost sm" id="served-prev" ${servedPage === 1 ? 'disabled' : ''}>← Previous</button><span>Page <b>${servedPage}</b> of ${pages}</span><button class="btn ghost sm" id="served-next" ${servedPage === pages ? 'disabled' : ''}>Next →</button>`;
    servedPagination.querySelector('#served-prev').onclick = () => { servedPage -= 1; renderServed(); };
    servedPagination.querySelector('#served-next').onclick = () => { servedPage += 1; renderServed(); };
  };
  for (const control of [servedSearch, servedType, servedStatus]) {
    control.addEventListener(control === servedSearch ? 'input' : 'change', () => { servedPage = 1; renderServed(); });
  }
  servedResults.onclick = async (event) => {
    const edit = event.target.closest('[data-served-edit]');
    if (edit) { editServed(served.find((x) => x.id === edit.dataset.servedEdit)); return; }
    const del = event.target.closest('[data-served-del]');
    if (!del) return;
    const yes = await confirmModal('Delete question', 'Delete this question? In-flight assessments keep their snapshot.', 'Delete', true);
    if (!yes) return;
    await attempt(() => api(`/admin/questions/${del.dataset.servedDel}`, { method: 'DELETE' }), { okMessage: 'Question deleted' });
    refresh();
  };
  renderServed();
}

/** The questions inside one family — what a new question would join. */
function familyModal({ family, questions }, bank, onChanged) {
  const rows = questions.map((q, i) => `
    <tr data-qid="${esc(q.id)}">
      <td class="muted">${i + 1}</td>
      <td><span class="chip">${esc(q.type === 'objective' ? 'Objective' : 'Open')}</span></td>
      <td style="max-width:480px">${esc(q.prompt)}
        ${q.removed ? '<span class="chip chip-optional">Removed</span>'
          : q.active === false ? '<span class="chip chip-optional">Inactive</span>' : ''}
        ${q.authored ? '<span class="chip">Added here</span>' : ''}
        ${q.optional ? '<span class="chip chip-optional">Optional</span>' : ''}
        ${q.needs_option_review ? '<span class="chip chip-optional">Options need review</span>' : ''}
        ${(q.tags || []).length
          ? `<div class="tag-row">${q.tags.slice(0, 6).map((t) => `<span class="chip chip-tag">${esc(t)}</span>`).join('')}</div>`
          : ''}</td>
      <td class="actions">${q.authored
        ? `<button class="btn ghost sm danger" data-del="${esc(q.id)}">Delete</button>`
        : q.optional
          ? '<span class="small muted">Optional</span>'
          : q.removed || q.active === false
            ? `<button class="btn ghost sm" data-restore="${esc(q.id)}">Restore</button>`
            : `<button class="btn ghost sm danger" data-del="${esc(q.id)}" data-published="1">Remove</button>`}</td>
    </tr>`).join('');

  const dialog = modal({
    title: `${family.module} · ${family.name}`,
    wide: true,
    bodyHtml: `
      <p class="small muted">Family <span class="mono">${esc(family.id)}</span> —
        ${family.objective} objective, ${family.open} open.
        A question added here joins this family in module ${esc(family.module)} only.</p>
      <div class="preview-scroll">
        <table class="data"><thead><tr>
          <th>#</th><th>Type</th><th>Question</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>`,
    actions: [
      { label: 'Close', kind: 'ghost' },
      ...(bank ? [{
        label: 'Add to this family',
        onClick: (close) => {
          close();
          addQuestionModal(bank, { module: family.module, familyId: family.id }, onChanged);
        },
      }] : []),
    ],
    onOpen: (root, close) => {
      // Every bank call in this dialog is scoped to the bank the family came
      // from (the `bank` object carries its role_key from the modules call).
      const qs = bank?.role_key ? `?role_key=${encodeURIComponent(bank.role_key)}` : '';
      // After any change the dialog re-opens on fresh data (and the tree
      // behind it refreshes), so the header counts and row states never go
      // stale — a removed question flips to Removed + Restore in place.
      const reload = async () => {
        const fresh = await attempt(() => api(`/admin/question-bank/families/${encodeURIComponent(family.id)}${qs}`));
        if (onChanged) onChanged();
        close();
        if (fresh) familyModal(fresh, bank, onChanged);
      };
      // Authored rows are deleted for good; published rows are removed from
      // circulation (hidden from counts and generation) and can be restored.
      for (const btn of root.querySelectorAll('[data-del]')) {
        btn.onclick = async () => {
          const isPublished = btn.dataset.published === '1';
          const okToDelete = await confirmModal(
            isPublished ? 'Remove this question?' : 'Delete this question?',
            isPublished
              ? 'It is hidden from the bank and will no longer be drawn into generated tests. You can restore it any time.'
              : 'It is removed from the bank and will no longer be drawn into generated tests.',
            isPublished ? 'Remove' : 'Delete', true,
          );
          if (!okToDelete) return;
          const out = await attempt(
            () => api(`/admin/question-bank/questions/${encodeURIComponent(btn.dataset.del)}${qs}`, { method: 'DELETE' }),
            { okMessage: isPublished ? 'Question removed — restore it any time' : 'Question deleted' },
          );
          if (!out) return;
          await reload();
        };
      }
      for (const btn of root.querySelectorAll('[data-restore]')) {
        btn.onclick = async () => {
          const out = await attempt(
            () => api(`/admin/question-bank/questions/${encodeURIComponent(btn.dataset.restore)}${qs}`, { method: 'PATCH', body: { active: true } }),
            { okMessage: 'Question restored' },
          );
          if (!out) return;
          await reload();
        };
      }
    },
  });
  return dialog;
}

/** Show one generated paper, grouped by module. */
function previewModal(result) {
  const c = result.counts;
  const rows = result.questions.map((q, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td><b>${esc(q.module)}</b>
        <div class="small muted">${esc(q.family || '')}</div></td>
      <td><span class="chip">${esc(q.type === 'objective' ? 'Objective' : 'Open')}</span></td>
      <td style="max-width:520px">${esc(q.prompt)}
        ${q.optional ? '<span class="chip chip-optional">Optional</span>' : ''}</td>
    </tr>`).join('');

  modal({
    title: result.mode === 'allocation' ? `${result.role_name}: default assessment` : 'Sample generated test · module template',
    wide: true,
    bodyHtml: `
      <p class="small muted">${result.mode === 'allocation' ? 'Uses the same saved role default and selection logic as account and CSV automatic allocation. Actual exams randomize their question selection.' : 'This module template is separate from the role’s automatic allocation settings.'}</p>
      <p class="small muted">${c.total} questions — ${c.technical_objective} technical objective,
        ${c.non_technical_objective ? `${c.non_technical_objective} consulting objective, ` : ''}${c.technical_open} technical open,
        ${c.non_technical_open} non-technical open${c.from_optional
          ? `, ${c.from_optional} drawn from the optional pool` : ''}.</p>
      ${result.warnings.length
        ? `<div class="card flat"><b>Warnings</b><ul class="small">${
            result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : ''}
      <div class="preview-scroll">
        <table class="data"><thead><tr>
          <th>#</th><th>Module / family</th><th>Type</th><th>Question</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>`,
    actions: [{ label: 'Close', kind: 'ghost', close: true }],
  });
}

/* ------------------------- question authoring ------------------------- */

/** Option rows an objective question is built from. Four is the house style. */
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Add one question to a module.
 *
 * The form is type-aware: an objective question collects options and a single
 * correct answer, an open question collects a rubric and probes. Swapping the
 * type swaps the lower half of the form rather than showing both and hoping
 * the author fills in the right one.
 */
function addQuestionModal(bank, { module: presetModule, familyId: presetFamily } = {}, onSaved) {
  const modules = [...bank.modules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const familiesFor = (key) => (modules.find((m) => m.key === key)?.families || []).filter((f) => !f.legacy);

  const moduleOptions = modules.map((m) =>
    `<option value="${esc(m.key)}" ${m.key === presetModule ? 'selected' : ''}>${esc(m.key)} — ${esc(m.name)}</option>`).join('');

  const optionRow = (letter, i) => `
    <div class="opt-row" data-opt="${esc(letter)}">
      <label class="opt-correct" title="Mark as the correct answer">
        <input type="radio" name="aq-correct" value="${esc(letter.toLowerCase())}" ${i === 0 ? '' : ''}/>
        <span class="opt-letter">${esc(letter)}</span>
      </label>
      <input type="text" class="opt-text" data-letter="${esc(letter)}" placeholder="Option ${esc(letter)}"/>
      <button type="button" class="btn ghost sm opt-del" aria-label="Remove option ${esc(letter)}">✕</button>
    </div>`;

  const body = `
    <p class="modal-intro">A question belongs to exactly one family inside one module.
      An unknown family name creates a new family in that module.</p>
    <form id="aq-form" novalidate>
      <div class="form-2col">
        <label class="f"><span class="lbl">Module <span class="req">*</span></span>
          <select id="aq-module"><option value="">— select —</option>${moduleOptions}</select>
          <div class="field-err" id="aq-err-module" role="alert" hidden></div></label>
        <label class="f"><span class="lbl">Type <span class="req">*</span></span>
          <select id="aq-type">
            <option value="objective">Objective (multiple choice)</option>
            <option value="open">Open (assessor-scored)</option>
          </select></label>
      </div>

      <label class="f"><span class="lbl">Family <span class="req">*</span></span>
        <input type="text" id="aq-family" list="aq-family-list" placeholder="Pick an existing family or type a new name"/>
        <datalist id="aq-family-list"></datalist>
        <div class="help" id="aq-family-hint">Select a module first.</div>
        <div class="field-err" id="aq-err-family" role="alert" hidden></div></label>

      <label class="f"><span class="lbl">Question <span class="req">*</span></span>
        <textarea id="aq-prompt" rows="3" placeholder="What the candidate is asked."></textarea>
        <div class="field-err" id="aq-err-prompt" role="alert" hidden></div></label>

      <div id="aq-objective">
        <div class="lbl" style="margin-bottom:7px">Options — select the correct one <span class="req">*</span></div>
        <div id="aq-options">${OPTION_LETTERS.slice(0, 4).map(optionRow).join('')}</div>
        <button type="button" class="btn ghost sm" id="aq-add-opt" style="margin:2px 0 15px">+ Add option</button>
        <div class="field-err" id="aq-err-options" role="alert" hidden></div>
        <label class="f"><span class="lbl">Why that answer is right</span>
          <textarea id="aq-rationale" rows="2" placeholder="Shown to the reviewer, never to the candidate."></textarea></label>
      </div>

      <div id="aq-open" hidden>
        <label class="f"><span class="lbl">Rubric — expected evidence <span class="req">*</span></span>
          <textarea id="aq-rubric" rows="3" placeholder="What a strong answer must contain."></textarea>
          <div class="field-err" id="aq-err-rubric" role="alert" hidden></div></label>
        <label class="f"><span class="lbl">Follow-up probes</span>
          <input type="text" id="aq-probes" placeholder="Separate with a semicolon"/></label>
      </div>

      <div class="form-3col">
        <label class="f"><span class="lbl">Difficulty</span>
          <select id="aq-difficulty">
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}
          </select></label>
        <label class="f"><span class="lbl">Band</span>
          <select id="aq-band">
            <option>Foundation</option><option selected>Intermediate</option><option>Advanced</option>
          </select></label>
        <label class="f"><span class="lbl">Minutes</span>
          <input type="number" id="aq-minutes" min="1" max="120" value="2"/></label>
      </div>

      <label class="f"><span class="lbl">Tags</span>
        <input type="text" id="aq-tags" placeholder="Separate with a comma"/>
        <div class="help">Used for reporting and to seed the gap tag.</div></label>
    </form>`;

  modal({
    title: 'Add a question',
    wide: true,
    bodyHtml: body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Add question',
        onClick: async (close, btn) => {
          const root = btn.closest('.modal') || document;
          const el = (id) => root.querySelector(`#${id}`);
          const clearErrors = () => root.querySelectorAll('#aq-form .field-err')
            .forEach((e) => { e.hidden = true; e.textContent = ''; });
          const showError = (name, msg) => {
            const box = el(`aq-err-${name}`);
            if (box) { box.textContent = msg; box.hidden = false; }
          };
          clearErrors();

          const type = el('aq-type').value;
          const payload = {
            role_key: bank?.role_key || undefined,
            module: el('aq-module').value,
            family: el('aq-family').value.trim(),
            type,
            prompt: el('aq-prompt').value.trim(),
            difficulty: Number(el('aq-difficulty').value),
            band: el('aq-band').value,
            minutes: Number(el('aq-minutes').value),
            tags: el('aq-tags').value,
          };
          if (type === 'objective') {
            const rows = [...root.querySelectorAll('#aq-options .opt-row')];
            payload.options = rows
              .map((r) => ({
                id: r.dataset.opt.toLowerCase(),
                label: r.querySelector('.opt-text').value.trim(),
              }))
              .filter((o) => o.label);
            const picked = root.querySelector('#aq-options input[name="aq-correct"]:checked');
            payload.correct_option_ids = picked ? [picked.value] : [];
            payload.rationale = el('aq-rationale').value.trim();
          } else {
            payload.rubric = el('aq-rubric').value.trim();
            payload.probes = el('aq-probes').value;
          }

          btn.disabled = true;
          try {
            const out = await api('/admin/question-bank/questions', { method: 'POST', body: payload });
            toast(`Added ${out.question.id} to ${out.question.module}.`, 'success');
            close();
            if (onSaved) onSaved(out.question);
          } catch (err) {
            btn.disabled = false;
            // Field-level errors land against their input; anything else is a toast.
            const list = err.body?.errors || [];
            if (!list.length) { toast(err.message, 'error'); return; }
            // Order matters: "An open question needs a rubric" mentions both a
            // question and a rubric, and belongs against the rubric.
            const target = (msg) => /rubric/i.test(msg) ? 'rubric'
              : /option|correct answer|correct/i.test(msg) ? 'options'
                : /module/i.test(msg) ? 'module'
                  : /famil/i.test(msg) ? 'family'
                    : /prompt/i.test(msg) ? 'prompt' : null;
            const orphans = [];
            for (const msg of list) {
              const name = target(msg);
              const box = name && el(`aq-err-${name}`);
              // An error routed into a collapsed section would be invisible;
              // surface those as a toast instead of silently swallowing them.
              // Start from the parent: the box itself is always `hidden` until shown.
              if (box && !box.parentElement?.closest('[hidden]')) showError(name, msg);
              else orphans.push(msg);
            }
            if (orphans.length) toast(orphans.join(' '), 'error');
          }
        },
      },
    ],
    onOpen: (root) => {
      const el = (id) => root.querySelector(`#${id}`);
      const syncFamilies = () => {
        const key = el('aq-module').value;
        const fams = key ? familiesFor(key) : [];
        el('aq-family-list').innerHTML = fams.map((f) => `<option value="${esc(f.name)}"></option>`).join('');
        el('aq-family-hint').textContent = key
          ? `${fams.length} existing ${fams.length === 1 ? 'family' : 'families'} in ${key}. A new name creates a new family.`
          : 'Select a module first.';
        if (presetFamily) {
          const match = fams.find((f) => f.id === presetFamily);
          if (match) { el('aq-family').value = match.name; presetFamily = null; }
        }
      };
      const syncType = () => {
        const objective = el('aq-type').value === 'objective';
        el('aq-objective').hidden = !objective;
        el('aq-open').hidden = objective;
        el('aq-minutes').value = objective ? '2' : '5';
      };
      const renumber = () => {
        [...root.querySelectorAll('#aq-options .opt-row')].forEach((row, i) => {
          const letter = OPTION_LETTERS[i];
          row.dataset.opt = letter;
          row.querySelector('.opt-letter').textContent = letter;
          const radio = row.querySelector('input[type=radio]');
          radio.value = letter.toLowerCase();
          const text = row.querySelector('.opt-text');
          text.dataset.letter = letter;
          text.placeholder = `Option ${letter}`;
          row.querySelector('.opt-del').setAttribute('aria-label', `Remove option ${letter}`);
        });
        const rows = root.querySelectorAll('#aq-options .opt-row').length;
        el('aq-add-opt').hidden = rows >= OPTION_LETTERS.length;
        root.querySelectorAll('#aq-options .opt-del').forEach((b) => { b.disabled = rows <= 2; });
      };
      root.querySelector('#aq-options').addEventListener('click', (e) => {
        const del = e.target.closest('.opt-del');
        if (!del) return;
        if (root.querySelectorAll('#aq-options .opt-row').length <= 2) return;
        del.closest('.opt-row').remove();
        renumber();
      });
      el('aq-add-opt').onclick = () => {
        const i = root.querySelectorAll('#aq-options .opt-row').length;
        if (i >= OPTION_LETTERS.length) return;
        root.querySelector('#aq-options').insertAdjacentHTML('beforeend', optionRow(OPTION_LETTERS[i], i));
        renumber();
      };
      el('aq-module').onchange = syncFamilies;
      el('aq-type').onchange = syncType;
      syncFamilies();
      syncType();
      renumber();
    },
  });
}

/**
 * Bulk import from a spreadsheet.
 *
 * Every upload is validated server-side as a dry run first, so the admin sees
 * the per-row outcome and can only commit once something was actually
 * accepted. Nothing is written until they press Import.
 */
function importQuestionsModal(onImported, bank = null) {
  let checked = null;      // last dry-run report
  let payload = null;      // { file_base64 | csv, filename }
  const bankKey = bank?.role_key || undefined;   // which published bank this import lands in

  const body = `
    <p class="modal-intro">Upload an .xlsx or .csv. The first row must be a header.
      The file is checked before anything is written. Both the template columns and the
      published Question Bank export columns (including options embedded as
      “• A) … • B) …”) are accepted.</p>
    <div class="import-drop" id="iq-drop">
      <input type="file" id="iq-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden/>
      <div class="import-drop-copy">
        <b id="iq-name">Choose a file or drop it here</b>
        <small>.xlsx or .csv · up to 2000 rows</small>
      </div>
      <button type="button" class="btn secondary sm" id="iq-browse">Browse</button>
    </div>
    <p class="small muted" style="margin:11px 0 0">
      Need a starting point? <a href="#" id="iq-template">Download the CSV template</a>.
    </p>
    <div id="iq-report"></div>`;

  const m = modal({
    title: 'Import questions',
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
          const out = await attempt(
            () => api('/admin/question-bank/import', { method: 'POST', body: { ...payload, dry_run: false, role_key: bankKey } }),
          );
          btn.disabled = false;
          if (!out) return;
          toast(`Imported ${out.imported} ${out.imported === 1 ? 'question' : 'questions'}.`, 'success');
          close();
          if (onImported) onImported(out);
        },
      },
    ],
    onOpen: (root) => {
      const file = root.querySelector('#iq-file');
      const drop = root.querySelector('#iq-drop');
      const name = root.querySelector('#iq-name');
      const report = root.querySelector('#iq-report');
      const importBtn = [...root.querySelectorAll('.m-foot .btn')].pop();
      importBtn.disabled = true;

      const renderReport = (r) => {
        const problems = [...r.errors.map((e) => ({ ...e, kind: 'Rejected' })),
          ...r.duplicate_rows.map((d) => ({ ...d, kind: 'Duplicate', errors: ['Already in the bank.'] }))]
          .sort((a, b) => a.line - b.line);

        report.innerHTML = `
          <div class="import-summary">
            ${badge(`${r.accepted} ready`, r.accepted ? 'green' : 'grey')}
            ${r.rejected ? badge(`${r.rejected} rejected`, 'red') : ''}
            ${r.duplicates ? badge(`${r.duplicates} duplicate`, 'amber') : ''}
            <span class="small muted">of ${r.total} data ${r.total === 1 ? 'row' : 'rows'}</span>
          </div>
          ${r.preview.length ? `
            <div class="preview-scroll" style="max-height:26vh;margin-top:12px">
              <table class="data"><thead><tr>
                <th>Row</th><th>Module</th><th>Family</th><th>Type</th><th>Question</th>
              </tr></thead><tbody>${r.preview.map((p) => `
                <tr><td class="muted">${p.line}</td><td><b>${esc(p.module)}</b></td>
                  <td class="small">${esc(p.family)}</td>
                  <td><span class="chip">${esc(p.type === 'objective' ? 'Objective' : 'Open')}</span></td>
                  <td style="max-width:420px">${esc(p.prompt)}</td></tr>`).join('')}
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
                    ${p.prompt ? `<div class="small muted">${esc(String(p.prompt).slice(0, 120))}</div>` : ''}</td>
                </tr>`).join('')}
              </tbody></table>
            </div>` : ''}
          ${!r.accepted ? '<p class="small muted">Nothing can be imported from this file yet.</p>' : ''}`;
        importBtn.disabled = !r.accepted;
      };

      const check = async (f) => {
        checked = null;
        payload = null;
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

        try {
          const out = await api('/admin/question-bank/import', { method: 'POST', body: { ...payload, dry_run: true, role_key: bankKey } });
          checked = out;
          renderReport(out);
        } catch (err) {
          checked = null;
          report.innerHTML = `<div class="import-summary">${badge('Cannot read this file', 'red')}</div>
            <p class="small muted">${esc(err.message)}</p>`;
        }
      };

      root.querySelector('#iq-browse').onclick = () => file.click();
      drop.onclick = (e) => { if (!e.target.closest('button')) file.click(); };
      file.onchange = () => { if (file.files[0]) check(file.files[0]); };
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) check(f);
      });
      root.querySelector('#iq-template').onclick = async (e) => {
        e.preventDefault();
        const tpl = await attempt(() => api(`/admin/question-bank/import-template${bankKey ? `?role_key=${encodeURIComponent(bankKey)}` : ''}`));
        if (tpl) downloadText(tpl.filename, tpl.csv, tpl.content_type);
      };
    },
  });
  return m;
}

/**
 * Bulk import of candidates (+ their portal users) from a spreadsheet.
 *
 * Same dry-run-first contract as the question import: the server validates
 * every row and reports accepted / rejected / duplicate before anything is
 * written. The "Create linked portal users" switch creates a candidate-role
 * login per row — a blank Username/Password is generated, and the plaintext
 * credentials are shown once (and downloadable) so the admin can share them.
 */
