import { api } from '../api.js';
import { state } from '../app.js';
import { esc, badge, loading, emptyState, dataTable, formModal, modal, toast, confirmModal, fmtDateTime, progressBar } from '../ui.js';

/**
 * Training: invite candidates to the learning platform (Anthroprime-LMS),
 * assign courses and follow their progress. Courses, invitations and progress
 * live in the LMS; ECOD forwards the administrator's session to it through
 * /admin/training (src/api/handlers/training.mjs). No email is ever sent.
 */
const ACCESS = {
  not_invited: ['Not invited', 'grey'],
  invited: ['Invited', 'blue'],
  active: ['Learning', 'green'],
  revoked: ['Revoked', 'red'],
};
const accessBadge = (key) => badge(...(ACCESS[key] || [key, 'grey']));
const courseState = (e) => e.progress.complete ? 'completed' : e.progress.completed ? 'in_progress' : 'not_started';
const COURSE_STATE = { completed: ['Completed', 'green'], in_progress: ['In progress', 'blue'], not_started: ['Not started', 'grey'] };
const pctText = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const mean = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

const ICONS = {
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M3.8 19c.4-3.1 2.1-4.7 5.2-4.7s4.8 1.6 5.2 4.7"></path><path d="M16 5.4a3 3 0 0 1 0 5.7M17 14.6c2.1.5 3.3 2 3.5 4.4"></path></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="14" r="4"></circle><path d="m11 11 8-8M16 6l2 2M14 8l2 2"></path></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6c-2.5-1.6-5.5-1.6-8-.8v13c2.5-.8 5.5-.8 8 .8 2.5-1.6 5.5-1.6 8-.8v-13c-2.5-.8-5.5-.8-8 .8zm0 0v13"></path></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="m8 12 3 3 5-6"></path></svg>',
};

function lessonDetails(candidate) {
  const body = candidate.enrollments.map((e) => {
    const tested = e.training.lessons.filter((l) => l.attempts);
    const firsts = tested.map((l) => l.first_percent).filter((v) => v !== null && v !== undefined);
    return `<section class="training-detail"><h3>${esc(e.course.title)}</h3>
      <p class="small muted">First-attempt average ${pctText(mean(firsts))} · Best-score average ${pctText(mean(tested.map((l) => l.best_percent)))} · ${tested.length} of ${e.training.lessons.filter((l) => l.question_count).length} lesson checks attempted</p>
      <div class="training-modules">${e.training.modules.map((m) => `<div><span>${esc(m.title)}</span>${progressBar(m.percent, 120)}<span class="small muted">${m.completed}/${m.total}</span></div>`).join('')}</div>
      ${dataTable([
        { label: 'Lesson', render: (l) => esc(l.title) },
        { label: 'Done', render: (l) => (l.completed_at ? badge('Yes', 'green') : '<span class="muted">No</span>') },
        { label: 'Attempts', cls: 'num', render: (l) => esc(l.attempts) },
        { label: 'First', cls: 'num', render: (l) => pctText(l.first_percent) },
        { label: 'Best', cls: 'num', render: (l) => pctText(l.best_percent) },
        { label: 'Latest', cls: 'num', render: (l) => pctText(l.latest_percent) },
      ], e.training.lessons, (l) => l.id, `${e.course.title} lesson scores`)}</section>`;
  }).join('');
  modal({ title: `${candidate.name} · lesson details`, bodyHtml: body || emptyState('No course assigned yet'), wide: true, actions: [{ label: 'Close' }] });
}

export async function trainingView(view) {
  let data = null;
  let query = '';
  let access = '';
  let courseFilter = '';
  const learningUrl = state.meta?.learningUrl || '';

  const load = async () => { data = await api('/admin/training'); };
  const act = async (fn, message) => {
    try { await fn(); toast(message, 'success'); await load(); if (view.isConnected) paint(); }
    catch (err) { toast(err.message || 'The learning platform could not complete this request.', 'error'); }
  };

  const invite = async () => {
    const saved = await formModal({
      title: 'Grant training access', submitLabel: 'Grant access',
      intro: 'Use the email on the candidate\'s ECOD account. No email is sent: the candidate signs in to the learning platform with their existing ECOD username and password.',
      fields: [{ name: 'email', label: 'Candidate email', type: 'email', required: true, placeholder: 'candidate@example.com' }],
      onSubmit: (body) => api('/admin/training/invitations', { method: 'POST', body }),
    });
    if (saved) { toast(saved.notice || 'Training access granted.', 'success'); await load(); if (view.isConnected) paint(); }
  };

  const assign = async (preset = '') => {
    const eligible = data.candidates.filter((c) => ['active', 'invited'].includes(c.access));
    if (!data.courses.length) return toast('Publish a course in the learning platform before assigning it.', 'info');
    if (!eligible.length) return toast('Grant a candidate training access first.', 'info');
    const saved = await formModal({
      title: 'Assign a course', submitLabel: 'Assign course',
      intro: 'The candidate keeps any progress they already have. The course appears under My learning in the learning platform.',
      values: { candidate_id: preset },
      fields: [
        { name: 'candidate_id', label: 'Candidate', type: 'select', required: true, options: eligible.map((c) => ({ value: c.id, label: `${c.name} · ${c.email}` })) },
        { name: 'id', label: 'Course', type: 'select', required: true, options: data.courses.map((c) => ({ value: c.id, label: c.title })) },
      ],
      onSubmit: (body) => api('/admin/training/assign', { method: 'POST', body: { ...body, kind: 'course' } }),
    });
    if (saved) { toast('Course assigned.', 'success'); await load(); if (view.isConnected) paint(); }
  };

  const paint = () => {
    const all = data.candidates || [];
    const enrollments = all.flatMap((c) => c.enrollments);
    const shown = all.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(query.toLowerCase())
      && (!access || c.access === access)
      && (!courseFilter || (courseFilter === 'unassigned' ? !c.enrollments.length : c.enrollments.some((e) => courseState(e) === courseFilter))));
    view.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Learning</div><h1>Training Dashboard</h1>
        <p>Invite candidates to the learning platform, assign courses and follow their progress. Accounts stay in ECOD; courses and progress live in the learning platform.</p></div>
        <div class="heading-actions"><button class="btn ghost" id="training-refresh">Refresh</button>${learningUrl ? `<a class="btn secondary" href="${esc(learningUrl)}" target="_blank" rel="noopener">Open learning platform ↗</a>` : ''}<button class="btn secondary" id="training-invite">Grant access</button><button class="btn" id="training-assign">＋ Assign course</button></div></div>
      <div class="grid cols-4 metric-grid">
        <div class="stat"><div class="stat-top"><span class="stat-icon">${ICONS.people}</span></div><div class="num">${all.length}</div><div class="lbl">Candidates</div></div>
        <div class="stat stat-blue"><div class="stat-top"><span class="stat-icon">${ICONS.key}</span></div><div class="num">${all.filter((c) => ['active', 'invited'].includes(c.access)).length}</div><div class="lbl">With training access</div></div>
        <div class="stat stat-violet"><div class="stat-top"><span class="stat-icon">${ICONS.book}</span></div><div class="num">${enrollments.filter((e) => courseState(e) === 'in_progress').length}</div><div class="lbl">Courses in progress</div></div>
        <div class="stat stat-gold"><div class="stat-top"><span class="stat-icon">${ICONS.done}</span></div><div class="num">${enrollments.filter((e) => e.progress.complete).length}</div><div class="lbl">Courses completed</div></div>
      </div>
      <div class="card"><div class="panel-head"><div><h2>Candidate progress</h2><p>${shown.length} of ${all.length} candidates · updated ${esc(fmtDateTime(data.generated_at))}</p></div></div>
        <div class="training-filters">
          <label class="f"><span class="lbl">Search</span><input id="training-search" type="search" placeholder="Name or email" value="${esc(query)}"></label>
          <label class="f"><span class="lbl">Training access</span><select id="training-access">${[['', 'All'], ...Object.entries(ACCESS).map(([k, [t]]) => [k, t])].map(([v, t]) => `<option value="${v}" ${access === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label class="f"><span class="lbl">Course status</span><select id="training-course">${[['', 'All'], ['unassigned', 'No course assigned'], ...Object.entries(COURSE_STATE).map(([k, [t]]) => [k, t])].map(([v, t]) => `<option value="${v}" ${courseFilter === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        </div>
        ${shown.length ? dataTable([
          { label: 'Candidate', render: (c) => `<b>${esc(c.name)}</b><div class="small muted">${esc(c.email || (c.has_account ? 'Add an email to this ECOD account to invite' : 'No active ECOD account'))}</div>` },
          { label: 'Access', render: (c) => accessBadge(c.access) },
          { label: 'Courses', render: (c) => c.enrollments.map((e) => `<div class="training-course"><span>${esc(e.course.title)}</span><div class="training-course-meta">${progressBar(e.progress.percent, 110)}<span class="small">${e.progress.percent}% · ${e.progress.completed}/${e.progress.total} lessons</span>${badge(...COURSE_STATE[courseState(e)])}</div></div>`).join('') || '<span class="muted small">No course assigned</span>' },
          { label: '', cls: 'actions', render: (c) => `<div class="row-actions">${['active', 'invited'].includes(c.access) ? `<button class="btn ghost sm" data-assign-to="${esc(c.id)}">Assign</button>` : ''}${c.enrollments.length ? `<button class="btn ghost sm" data-details="${esc(c.id)}">Lesson details</button>` : ''}${!c.invitation_id && c.email ? `<button class="btn ghost sm" data-invite-email="${esc(c.email)}">Grant access</button>` : ''}${c.invitation_id ? `<button class="btn ghost sm" data-access-id="${esc(c.invitation_id)}" data-status="${c.access === 'revoked' ? 'active' : 'revoked'}">${c.access === 'revoked' ? 'Restore access' : 'Revoke access'}</button>` : ''}</div>` },
        ], shown, (c) => c.id, 'Candidate training progress') : emptyState(all.length ? 'No candidates match these filters' : 'No candidates yet', all.length ? 'Clear the search or filters.' : 'Candidates you add in ECOD appear here.')}
      </div>
      <div class="card"><div class="panel-head"><div><h2>Invitation register</h2><p>An invitation for an email with no ECOD account yet stays pending until a candidate account uses it. Revoking access keeps the candidate's progress.</p></div></div>
        ${(data.invitations || []).length ? dataTable([
          { label: 'Email', render: (i) => esc(i.email) },
          { label: 'Account', render: (i) => (i.user_id ? 'Linked to ECOD' : '<span class="muted">Pending ECOD account</span>') },
          { label: 'Status', render: (i) => accessBadge(i.status === 'revoked' ? 'revoked' : i.first_access_at ? 'active' : 'invited') },
          { label: 'Granted', render: (i) => esc(fmtDateTime(i.invited_at)) },
          { label: '', cls: 'actions', render: (i) => `<button class="btn ghost sm" data-access-id="${esc(i.id)}" data-status="${i.status === 'revoked' ? 'active' : 'revoked'}">${i.status === 'revoked' ? 'Restore access' : 'Revoke access'}</button>` },
        ], data.invitations, (i) => i.id, 'Training invitations') : '<p class="muted">No invitations yet. Use Grant access to invite a candidate.</p>'}
      </div>`;

    view.querySelector('#training-refresh').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { await load(); if (view.isConnected) paint(); toast('Progress refreshed.', 'success'); }
      catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
    };
    view.querySelector('#training-invite').onclick = invite;
    view.querySelector('#training-assign').onclick = () => assign();
    const search = view.querySelector('#training-search');
    search.oninput = () => {
      const at = search.selectionStart; query = search.value; paint();
      const next = view.querySelector('#training-search'); next.focus({ preventScroll: true }); if (at !== null) next.setSelectionRange(at, at);
    };
    view.querySelector('#training-access').onchange = (e) => { access = e.target.value; paint(); };
    view.querySelector('#training-course').onchange = (e) => { courseFilter = e.target.value; paint(); };
    view.querySelectorAll('[data-assign-to]').forEach((b) => { b.onclick = () => assign(b.dataset.assignTo); });
    view.querySelectorAll('[data-details]').forEach((b) => { b.onclick = () => lessonDetails(all.find((c) => c.id === b.dataset.details)); });
    view.querySelectorAll('[data-invite-email]').forEach((b) => { b.onclick = () => act(() => api('/admin/training/invitations', { method: 'POST', body: { email: b.dataset.inviteEmail } }), 'Training access granted. No email was sent.'); });
    view.querySelectorAll('[data-access-id]').forEach((b) => { b.onclick = async () => {
      const revoking = b.dataset.status === 'revoked';
      if (revoking && !await confirmModal('Revoke training access?', 'The candidate loses access to the learning platform at their next request. Their progress is kept, and you can restore access later.', 'Revoke access', true)) return;
      b.disabled = true;
      await act(() => api(`/admin/training/invitations/${encodeURIComponent(b.dataset.accessId)}`, { method: 'PUT', body: { status: b.dataset.status } }), revoking ? 'Training access revoked. Progress is kept.' : 'Training access restored.');
    }; });
  };

  view.innerHTML = loading('Loading training progress…');
  try {
    await load();
  } catch (err) {
    if (!view.isConnected) return;
    view.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Learning</div><h1>Training Dashboard</h1></div></div>
      <div class="card training-offline"><h2>The learning platform isn't available</h2><p>${esc(err.message || 'It could not be reached.')}</p>
      <p class="small muted">Assessments and the rest of ECOD keep working. Training needs <code>LMS_WEB_URL</code> set to the learning platform's address, and the learning platform needs this ECOD's API address.</p>
      <button class="btn" id="training-retry">Try again</button></div>`;
    view.querySelector('#training-retry').onclick = () => trainingView(view);
    return;
  }
  if (view.isConnected) paint();
}
