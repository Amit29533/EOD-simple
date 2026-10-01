import { api } from './api.js';
import { esc, modal, formModal, toast } from './ui.js';

const labels = {
  candidate_profiles: 'Candidate profiles', accounts: 'Portal accounts', sessions: 'Login sessions',
  assessments: 'Assessments and question snapshots', reports: 'Finalized reports',
  responses: 'Answers, transcripts, scores and comments', recordings: 'Audio recordings', audit_events: 'Linked activity history',
};

export async function deletePersonFlow(kind, person, onDeleted) {
  let preview;
  try { preview = await api(`/admin/${kind}/${person.id}/purge-preview`); }
  catch (err) { toast(err.message, 'error'); return; }
  const summary = Object.entries(preview.counts).map(([key, count]) => `${labels[key]}: ${count}`).join(' · ');
  const proceed = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    modal({
      title: `Delete all data · ${preview.name}`,
      bodyHtml: `<p><b>This permanently deletes the records below. There is no portal undo.</b></p>
        <dl class="deletion-summary">${Object.entries(preview.counts).map(([key, count]) => `<div><dt>${esc(labels[key])}</dt><dd>${count}</dd></div>`).join('')}</dl>
        ${preview.accounts.length ? `<p>Accounts: ${preview.accounts.map((u) => `<b>@${esc(u.username)}</b> (${esc(u.role)})`).join(', ')}</p>` : ''}
        ${preview.assessments.length ? `<details><summary>Show assessments to be deleted</summary><ul>${preview.assessments.map((a) => `<li>${esc(a.role_name)} · ${esc(a.status)}</li>`).join('')}</ul></details>` : ''}
        ${preview.retained_assessments || preview.cleared_candidate_assignments ? `<p>${preview.retained_assessments} assigned assessments belonging to other candidates will be kept, with this staff account removed as assessor. ${preview.cleared_candidate_assignments} candidate assessor assignments will be cleared.</p>` : ''}
        <p class="small muted">Shared question banks, roles, frameworks and other people’s accounts remain. One new admin deletion audit entry is retained, containing counts and no deleted person’s name.</p>
        ${preview.blocked_reason ? `<p class="field-err">${esc(preview.blocked_reason)}</p>` : ''}`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: (close) => { settle(false); close(); } },
        ...(!preview.blocked_reason ? [{ label: 'Continue', kind: 'danger', onClick: (close) => { settle(true); close(); } }] : []),
      ],
      onClose: () => settle(false),
    });
  });
  if (!proceed) return;
  const deleted = await formModal({
    title: `Permanently delete · ${preview.name}`,
    intro: summary,
    submitLabel: 'Delete all data permanently', busyLabel: 'Deleting…',
    onOpen: (el) => el.querySelector('.m-foot .btn:last-child').classList.add('danger'),
    fields: [
      { name: 'confirmation', label: 'Type DELETE to confirm', required: true, pattern: '^DELETE$', patternMessage: 'Type DELETE exactly to confirm.', autocomplete: 'off' },
      { name: 'password', label: 'Your admin password', type: 'password', required: true, autocomplete: 'current-password', help: 'Use the password of the admin currently signed in.' },
    ],
    onSubmit: (values) => api(`/admin/${kind}/${person.id}/purge`, { method: 'DELETE', body: { ...values, preview_token: preview.preview_token } }),
  });
  if (!deleted) return;
  toast('Person and linked data permanently deleted.', 'success');
  onDeleted?.();
}
