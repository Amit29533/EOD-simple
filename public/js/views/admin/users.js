import { deletePersonFlow } from '../../person-delete.js';
import { wireAccountForm } from '../../account-form.js';
import { api, apiAll, newRequestId } from '../../api.js';
import { state } from '../../app.js';
import { esc, fmtDateTime, badge, dataTable, loading, emptyState, toast, attempt, formModal } from '../../ui.js';
import { importCandidatesModal } from './candidates.js';

/** Users & access and the audit log. */
export async function usersView(view) {
  view.innerHTML = loading();
  const [users, candidates, roles] = await Promise.all([apiAll('/admin/users', 'users'), apiAll('/admin/candidates', 'candidates'), apiAll('/admin/roles', 'roles')]);
  const roleTone = { admin: 'red', assessor: 'blue', candidate: 'green', validator: 'amber', trainer: 'amber' };
  const assessors = users.filter((u) => u.role === 'assessor' && u.active !== false);
  view.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">Workspace access</div><h1>Users & access</h1><p>Provision accounts and assign roles.</p></div>
      <div class="heading-actions">
        <button class="btn secondary" id="import-users">Import from Excel</button>
        <button class="btn" id="add-user">＋ Create user</button>
      </div>
    </div>
    <div class="demo-creds no-print"><span class="info-strip-icon">⌁</span><span>Only admins can provision accounts. Permissions are role-based, and sensitive candidate details stay compartmentalized.</span></div>
    <div class="card flat account-summary"><span class="account-summary-number">${users.length}</span><span>account${users.length === 1 ? '' : 's'} provisioned</span><span class="summary-divider"></span><span class="muted">Passwords are stored as salted hashes</span></div>
    <div class="card flat toolbar-card account-filters">
      <input id="user-search" type="search" placeholder="Search name, username or email…" aria-label="Search users">
      <select id="user-role-filter" aria-label="Filter users by role"><option value="">All roles</option>${state.meta.userRoles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
      <select id="user-status-filter" aria-label="Filter users by status"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Deactivated</option></select>
      <span id="user-result-count" class="small muted" aria-live="polite"></span>
    </div>
    <div class="card table-card" id="user-table">
      ${dataTable([
        { label: 'User', render: (u) => `<b>${esc(u.name)}</b><div class="small muted mono">@${esc(u.username)}</div>` },
        { label: 'Role', render: (u) => badge(u.role, roleTone[u.role] || 'grey') },
        { label: 'Linked candidate', render: (u) => esc(u.candidate_name || '—') },
        { label: 'Status', render: (u) => u.active !== false ? badge('Active', 'green') : badge('Deactivated', 'grey') },
        { label: '', cls: 'actions', render: (u) => `
            <button class="btn ghost sm" data-edit="${u.id}">Edit</button>
            <button class="btn ghost sm" data-pw="${u.id}">Reset password</button>
            ${u.active !== false ? `<button class="btn ghost sm" data-recovery="${u.id}">Recovery link</button>` : ''}
            ${u.id !== state.user?.id && u.username !== 'admin' ? `<button class="btn ghost sm" style="color:var(--red)" data-purge-user="${u.id}">Delete all data</button>` : ''}
            ${u.active === false ? `<button class="btn ghost sm" data-on="${u.id}">Reactivate</button>`
    // The signed-in admin cannot deactivate their own login (the API refuses
    // the self-lockout), so do not offer it.
    : u.id === state.user?.id ? '' : `<button class="btn ghost sm" style="color:var(--red)" data-off="${u.id}">Deactivate</button>`}` },
      ], users)}
    </div>`;

  const rows = [...view.querySelectorAll('#user-table tbody tr')];
  const search = view.querySelector('#user-search');
  const roleFilter = view.querySelector('#user-role-filter');
  const statusFilter = view.querySelector('#user-status-filter');
  const filterUsers = () => {
    const term = search.value.trim().toLowerCase();
    let visible = 0;
    rows.forEach((row, i) => {
      const u = users[i];
      const match = (!term || `${u.name} ${u.username} ${u.email || ''} ${u.candidate_name || ''}`.toLowerCase().includes(term))
        && (!roleFilter.value || u.role === roleFilter.value)
        && (!statusFilter.value || (u.active !== false ? 'active' : 'inactive') === statusFilter.value);
      row.hidden = !match;
      if (match) visible++;
    });
    view.querySelector('#user-result-count').textContent = `${visible} of ${users.length} accounts`;
  };
  search.oninput = filterUsers;
  roleFilter.onchange = statusFilter.onchange = filterUsers;
  filterUsers();

  const userFields = (values) => [
    { name: 'username', label: 'Username', required: true, help: 'a-z 0-9 . _ - , at least 3 characters.' },
    { name: 'name', label: 'Full name', required: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'role', label: 'Role', type: 'select', required: true, allowEmpty: false, options: state.meta.userRoles.map((r) => ({ value: r, label: ['trainer', 'validator'].includes(r) ? `${r} (planned portal)` : r })) },
    { name: 'password', label: values ? 'New password (leave blank to keep current)' : 'Password', type: 'password', required: !values, help: 'Minimum 8 characters. Share securely with the user.' },
    ...(values && values.role !== 'candidate' ? [] : [{
      name: 'candidate_id', label: 'Linked candidate (required for candidate role)', type: 'select',
      options: candidates.map((c) => ({ value: c.id, label: c.name })),
      required: values?.role === 'candidate',
      help: values ? 'Candidate portal users must stay linked to exactly one candidate record.' : 'Required only when Role is candidate; ignored for other roles.',
    }]),
    // New candidate users are auto-allocated the selected track's default
    // assessment — this is the switch that turns that off for one user.
    // Create-only: editing an account never (re-)allocates.
    ...(!values ? [{
      name: 'auto_allocate', label: 'Auto-allocate the role’s default assessment', type: 'checkbox', value: true,
      help: 'The question count comes from the candidate’s role under Roles & frameworks. Ignored for other roles.',
    }, {
      name: 'assessor_id', label: 'Assessor for the auto-allocated assessment', type: 'select',
      options: assessors.map((u) => ({ value: u.id, label: u.name })),
      help: 'Who scores the automatic assessment. Leave blank to use the assessor set on the candidate record (or leave it unassigned). Ignored for other roles.',
    }] : []),
  ];

  view.querySelectorAll('[data-purge-user]').forEach((button) => {
    button.onclick = () => deletePersonFlow('users', users.find((u) => u.id === button.dataset.purgeUser), () => usersView(view));
  });

  view.querySelector('#import-users').onclick = () => importCandidatesModal(() => usersView(view));
  view.querySelector('#add-user').onclick = async () => {
    const requestId = newRequestId();
    // A refusal (username taken, candidate already linked, weak password)
    // keeps the dialog open with everything typed, the message on its field.
    const fieldOrder = ['role', 'candidate_id', 'name', 'email', 'username', 'password', 'auto_allocate', 'assessor_id'];
    const fields = userFields(null).sort((a, b) => fieldOrder.indexOf(a.name) - fieldOrder.indexOf(b.name));
    const out = await formModal({
      title: 'Create user', fields, values: { role: 'candidate' },
      onOpen: (el) => wireAccountForm(el, { candidates, users, roles, create: true }),
      onSubmit: (vals) => {
        if (vals.role === 'candidate' && !vals.candidate_id) {
          throw Object.assign(new Error('Choose the linked candidate before creating a candidate portal user.'), { field: 'candidate_id' });
        }
        const body = { ...vals, request_id: requestId };
        if (body.role !== 'candidate') { delete body.candidate_id; delete body.assessor_id; }
        if (!body.assessor_id) delete body.assessor_id;
        return api('/admin/users', { method: 'POST', body });
      },
    });
    if (!out) return;
    // The account is created either way — the toast then says whether its
    // assessment was auto-allocated or why it was skipped.
    const alloc = out.role === 'candidate' ? out.auto_allocation : null;
    if (alloc?.allocated) {
      toast(`User "${out.username}" created · ${alloc.question_count}-question assessment auto-allocated (${alloc.role_name})`, 'success');
    } else if (alloc && !alloc.skipped) {
      toast(`User "${out.username}" created · assessment not auto-allocated: ${alloc.reason}`, 'success');
    } else {
      toast(`User "${out.username}" created`, 'success');
    }
    usersView(view);
  };
  view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    const editable = ['name', 'email', 'password', ...(u.role === 'candidate' ? ['candidate_id'] : [])];
    const saved = await formModal({
      onOpen: (el) => wireAccountForm(el, { candidates, users }),
      title: `Edit @${u.username}`, values: u, fields: userFields(u).filter((f) => editable.includes(f.name)),
      onSubmit: (vals) => {
        const body = { name: vals.name, email: vals.email };
        if (u.role === 'candidate') body.candidate_id = vals.candidate_id;
        if (vals.password) body.password = vals.password;
        return api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      },
    });
    if (!saved) return;
    toast('User updated', 'success');
    usersView(view);
  }));
  view.querySelectorAll('[data-pw]').forEach((b) => (b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.pw);
    const saved = await formModal({
      title: `Reset password · @${u.username}`,
      onOpen: (el) => { el.dataset.accountName = u.name; wireAccountForm(el, { users }); },
      fields: [{ name: 'password', label: 'New password', type: 'password', required: true, help: 'Minimum 8 characters.' }],
      onSubmit: (vals) => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { password: vals.password } }),
    });
    if (saved) toast('Password reset', 'success');
  }));
  const toggle = async (id, active) => {
    const out = await attempt(() => api(`/admin/users/${id}`, { method: 'PATCH', body: { active } }), { okMessage: active ? 'User reactivated' : 'User deactivated' });
    if (out?.open_assessments) {
      toast(`${out.open_assessments} open assessment${out.open_assessments === 1 ? ' is' : 's are'} still assigned to this assessor — reassign them under Assessments or from each candidate's Edit form.`, 'error', 8000);
    }
    usersView(view);
  };
  view.querySelectorAll('[data-recovery]').forEach((button) => { button.onclick = async () => {
    const result = await formModal({
      title: 'Create password recovery link',
      intro: 'This revokes the user’s other sessions and older recovery links. Share the new link securely; it expires in 15 minutes.',
      submitLabel: 'Create link', fields: [{ name: 'password', label: 'Your admin password', type: 'password', required: true, autocomplete: 'current-password' }],
      onSubmit: (values) => api(`/admin/users/${button.dataset.recovery}/recovery-link`, { method: 'POST', body: values }),
    });
    if (!result) return;
    await formModal({ title: 'Recovery link created', submitLabel: 'Close',
      intro: 'Copy this link and share it directly with the user. The portal does not send email.',
      fields: [{ name: 'link', label: 'One-time recovery link', type: 'textarea', value: `${location.origin}${location.pathname}#/recover/${result.token}`, rows: 3 },
        { name: 'expiry', label: 'Expires', type: 'static', value: fmtDateTime(result.expires_at) }],
    });
  }; });
  view.querySelectorAll('[data-off]').forEach((b) => (b.onclick = () => toggle(b.dataset.off, false)));
  view.querySelectorAll('[data-on]').forEach((b) => (b.onclick = () => toggle(b.dataset.on, true)));
}

/* ================================ Audit log ================================ */
export async function auditView(view) {
  view.innerHTML = loading();
  const events = await apiAll('/admin/audit', 'events', { limit: 200 });
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
