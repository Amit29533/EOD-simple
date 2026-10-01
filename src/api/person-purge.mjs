import { createHash } from 'node:crypto';
import { verifyPasswordAsync } from '../core/passwords.mjs';
import { audit, bulkRemove, bulkUpdate, ok, notFound, forbidden, conflict } from './helpers.mjs';
import { withLock } from './mutex.mjs';
import { allocationLockKey } from './assessment-service.mjs';

const finalized = (a) => ['scored', 'validated'].includes(a.status);
const lockAll = (keys, fn) => keys.length ? withLock(keys[0], () => lockAll(keys.slice(1), fn)) : fn();

async function plan(store, kind, id, actor) {
  const target = await store.get(kind, id);
  if (!target) return null;
  const candidate = kind === 'candidates' ? target
    : target.role === 'candidate' && target.candidate_id ? await store.get('candidates', target.candidate_id) : null;
  const accounts = candidate ? await store.list('users', { candidate_id: candidate.id }) : kind === 'users' ? [target] : [];
  const ids = new Set(accounts.map((u) => u.id));
  const protectedAccount = accounts.find((u) => u.id === actor.id || u.username === 'admin');
  const assessments = candidate ? await store.list('assessments', { candidate_id: candidate.id }) : [];
  const assigned = !candidate && ids.size ? (await store.list('assessments', {}, { detached: false })).filter((a) => ids.has(a.assessor_id)) : [];
  const candidateAssignments = !candidate && ids.size ? (await store.list('candidates')).filter((c) => ids.has(c.assessor_id)) : [];
  const sessions = (await store.list('sessions')).filter((s) => ids.has(s.user_id));
  const responses = [], recordings = [];
  for (const a of assessments) {
    responses.push(...await store.list('responses', { assessment_id: a.id }));
    recordings.push(...await store.list('recordings', { assessment_id: a.id }));
  }
  const paperIds = new Set(assessments.map((a) => a.id));
  const events = (await store.list('audit_log')).filter((e) => ids.has(e.actor_id)
    || (e.entity === 'users' && ids.has(e.entity_id))
    || (candidate && e.entity === 'candidates' && e.entity_id === candidate.id)
    || (e.entity === 'assessments' && paperIds.has(e.entity_id)));
  const counts = {
    candidate_profiles: candidate ? 1 : 0, accounts: accounts.length, sessions: sessions.length,
    assessments: assessments.length, reports: assessments.filter((a) => a.report_json || finalized(a)).length,
    responses: responses.length, recordings: recordings.length, audit_events: events.length,
  };
  const rows = { accounts, assessments, assigned, candidateAssignments, sessions, responses, recordings, events };
  const signature = Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.map((r) => [r.id, r.updated_at || '', r.status || '', r.assessor_id || '']).sort()]));
  const token = createHash('sha256').update(JSON.stringify({ kind, id, candidate: candidate?.id,
    target_updated: target.updated_at, candidate_updated: candidate?.updated_at, signature })).digest('hex');
  return {
    ...rows, candidate,
    preview: { name: target.name, counts, confirmation: 'DELETE', preview_token: token,
      blocked_reason: protectedAccount ? 'Your own account and the primary admin account cannot be permanently deleted.' : null,
      retained_assessments: assigned.length, cleared_candidate_assignments: candidateAssignments.length,
      accounts: accounts.map((u) => ({ username: u.username, role: u.role })),
      assessments: assessments.map((a) => ({ role_name: a.role_name || 'Assessment', status: a.status })),
    },
  };
}

export async function purgePreview({ store, params, auth }, kind) {
  const data = await plan(store, kind, params.id, auth.user);
  return data ? ok(data.preview) : notFound('Person not found.');
}

export async function purgePerson({ store, params, auth, body }, kind) {
  if (!await store.get(kind, params.id)) return notFound('Person not found.');
  if (typeof body?.password !== 'string' || !body.password) return forbidden('Admin password is required for permanent deletion.');
  // Use the current hash, rather than the copy resolved before a password reset.
  const actor = await store.get('users', auth.user.id);
  if (!actor || actor.active === false || !await verifyPasswordAsync(body.password, actor.password_hash))
    return forbidden('Incorrect admin password — deletion cancelled.');
  if (body.confirmation !== 'DELETE') return conflict('Type DELETE to confirm permanent deletion.');
  return withLock('users:create', async () => {
    const initial = await plan(store, kind, params.id, actor);
    if (!initial) return notFound('Person not found.');
    if (initial.preview.blocked_reason) return conflict(initial.preview.blocked_reason);
    const allocationLocks = initial.candidate
      ? (await store.list('roles')).map((r) => allocationLockKey(initial.candidate.id, r.id)).sort() : [];
    return lockAll(initial.accounts.map((u) => `identity:${u.id}`).sort(), () => lockAll(allocationLocks, async () => {
      const papers = [...initial.assessments, ...initial.assigned];
      return lockAll([...new Set(papers.map((a) => `assessment:${a.id}`))].sort(), async () => {
        const data = await plan(store, kind, params.id, actor);
        if (!data || data.preview.preview_token !== body.preview_token)
          return conflict('Linked data changed since the preview. Close this dialog and review the deletion again.');
        if (data.preview.blocked_reason) return conflict(data.preview.blocked_reason);
        // Stop access first. A partial storage failure leaves the candidate visible
        // for a fresh preview/retry, with login and new allocation disabled.
        if (data.candidate) await store.update('candidates', data.candidate.id, { deleting: true });
        await bulkUpdate(store, 'users', data.accounts.map((u) => ({ id: u.id, patch: { active: false } })));
        await bulkRemove(store, 'sessions', data.sessions.map((r) => r.id));
        for (const a of data.assessments) {
          await bulkRemove(store, 'responses', data.responses.filter((r) => r.assessment_id === a.id).map((r) => r.id));
          await bulkRemove(store, 'recordings', data.recordings.filter((r) => r.assessment_id === a.id).map((r) => r.id));
          // Adapter removal also removes detached paper and report objects.
          await store.remove('assessments', a.id);
        }
        // Staff accounts do not own their candidates' papers or reports.
        for (const a of data.assigned) await store.update('assessments', a.id, { assessor_id: null });
        await bulkUpdate(store, 'candidates', data.candidateAssignments.map((c) => ({ id: c.id, patch: { assessor_id: null } })));
        await bulkRemove(store, 'audit_log', data.events.map((r) => r.id));
        await bulkRemove(store, 'users', data.accounts.map((r) => r.id));
        if (data.candidate) await store.remove('candidates', data.candidate.id);
        await audit(store, actor, 'person_permanently_deleted', kind, params.id,
          'Permanent deletion completed.', { counts: data.preview.counts });
        return ok({ ok: true, removed: data.preview.counts });
      });
    }));
  });
}
