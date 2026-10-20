import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeWorld, ADMIN_PASSWORD } from './helpers/world.mjs';
import { bookingInput } from '../src/api/handlers/bookings.mjs';
import { createBlobsStore } from '../src/storage/netlify-blobs.mjs';

const future = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const details = (extra = {}) => ({ name: 'Booking Candidate', email: 'booking@example.com', phone: '+91 98765 43210', date: future(), time: '14:30', request_id: 'booking-request-123456', password: 'Booking-password-2026', confirm_password: 'Booking-password-2026', ...extra });
async function invite(w) {
  const r = await w.call('POST', '/admin/test-bookings/links', { token: w.tok, body: { label: 'October cohort', role_id: w.role.id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body, token: r.body.path.split('/').at(-1) };
}
const bookingEmail = (link) => `booking-${link.invitation.id}@example.com`;
const submit = (w, link, extra = {}) => w.call('POST', '/public/test-bookings', { body: { token: link.token, ...details({ email: bookingEmail(link), role_id: w.role.id, ...extra }) } });

test('single-use invitation books an IST slot, creates a candidate, and appears on the dashboard', async (t) => {
  const w = await makeWorld({ t }); const link = await invite(w);
  const raw = await w.store.get('test_bookings', link.invitation.id);
  assert.notEqual(raw.token_hash, link.token);
  assert.equal(raw.token_hash, createHash('sha256').update(link.token).digest('hex'));
  assert.ok(!JSON.stringify(raw).includes(link.token));
  const lookup = await w.call('POST', '/public/test-bookings/lookup', { body: { token: link.token } });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.role_name, w.role.name);
  assert.ok(!JSON.stringify(lookup.body).includes('token_hash'));
  const saved = await submit(w, link);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.scheduled_at, `${future()}T09:00:00.000Z`);
  const row = await w.store.get('test_bookings', link.invitation.id);
  const candidate = await w.store.get('candidates', row.candidate_id);
  assert.equal(candidate.email, bookingEmail(link));
  assert.equal(candidate.phone, details().phone);
  assert.equal(candidate.target_role_id, w.role.id);
  assert.equal(candidate.stage, 'assessment');
  const dashboard = await w.call('GET', '/admin/dashboard', { token: w.tok });
  assert.equal(dashboard.body.counts.upcoming_tests, 1);
  assert.equal(dashboard.body.upcoming_tests[0].candidate_id, candidate.id);
  assert.ok(!JSON.stringify(dashboard.body).includes(raw.token_hash));
  assert.equal((await w.call('POST', '/public/test-bookings/lookup', { body: { token: link.token } })).status, 409);
  assert.equal((await submit(w, link, { request_id: 'different-request-123456' })).status, 409);
  assert.equal((await submit(w, link)).status, 200, 'same request can recover a lost acknowledgement');
  assert.equal((await submit(w, link, { name: 'Another Person' })).status, 409);
  assert.equal((await w.store.list('candidates', { booking_id: row.id })).length, 1);
});

test('booking validation rejects malformed fields, past slots and impossible dates without consuming the link', async (t) => {
  const w = await makeWorld({ t }); const link = await invite(w);
  for (const patch of [{ name: {} }, { email: 'bad' }, { phone: '123' }, { date: '2020-01-01' }, { date: '2099-02-30' }, { time: '24:30' }, { time: [] }, { name: 'x'.repeat(121) }]) {
    assert.equal((await submit(w, link, patch)).status, 422, JSON.stringify(patch));
    assert.equal((await w.store.get('test_bookings', link.invitation.id)).status, 'pending');
  }
  assert.equal((await submit(w, link, { request_id: [] })).status, 400);
  assert.equal((await submit(w, link)).status, 200);
  assert.equal(bookingInput(details({ time: '00:15' })).value.scheduled_at, new Date(`${future()}T00:15:00+05:30`).toISOString());
});

test('booking administration is admin-only and expired/revoked/random links cannot be submitted', async (t) => {
  const w = await makeWorld({ t }); const person = await w.candidateUser('booking.access');
  for (const [method, path] of [['GET', '/admin/test-bookings'], ['POST', '/admin/test-bookings/links'], ['POST', '/admin/test-bookings/unknown/cancel']]) {
    assert.equal((await w.call(method, path, { body: {} })).status, 401);
    assert.equal((await w.call(method, path, { token: person.token, body: {} })).status, 403);
  }
  const link = await invite(w);
  await w.store.update('test_bookings', link.invitation.id, { expires_at: '2020-01-01T00:00:00Z' });
  assert.equal((await submit(w, link)).status, 409);
  const revoked = await invite(w);
  assert.equal((await w.call('POST', `/admin/test-bookings/${revoked.invitation.id}/cancel`, { token: w.tok })).status, 200);
  assert.equal((await submit(w, revoked)).status, 409);
  for (const token of ['', {}, 'a'.repeat(64)]) assert.equal((await w.call('POST', '/public/test-bookings/lookup', { body: { token } })).status, 404);
});

test('concurrent submissions consume a link once and retries repair interrupted profile creation', async (t) => {
  const w = await makeWorld({ t }); const link = await invite(w);
  const results = await Promise.all([submit(w, link), submit(w, link, { name: 'Second candidate', request_id: 'different-request-123456' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const repair = await invite(w);
  const insert = w.store.insert.bind(w.store); let failed = false;
  w.store.insert = async (table, row) => {
    if (table === 'candidates' && !failed) { failed = true; throw new Error('simulated profile failure'); }
    return insert(table, row);
  };
  assert.equal((await submit(w, repair)).status, 500);
  assert.equal((await w.store.get('test_bookings', repair.invitation.id)).status, 'booked');
  assert.equal((await submit(w, repair, { request_id: 'another-request-123456' })).status, 409);
  assert.equal((await submit(w, repair)).status, 200);
  assert.equal((await w.store.list('candidates', { booking_id: repair.invitation.id })).length, 1);
});

test('dashboard repairs a saved slot after a lost candidate-write acknowledgement; cancellation preserves single use', async (t) => {
  const w = await makeWorld({ t }); const link = await invite(w);
  const insert = w.store.insert.bind(w.store); let failed = false;
  w.store.insert = async (table, row) => {
    const result = await insert(table, row);
    if (table === 'candidates' && !failed) { failed = true; throw new Error('simulated acknowledgement loss'); }
    return result;
  };
  assert.equal((await submit(w, link)).status, 500);
  const dashboard = await w.call('GET', '/admin/dashboard', { token: w.tok });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.counts.upcoming_tests, 1);
  assert.ok(dashboard.body.upcoming_tests[0].candidate_id);
  assert.equal((await w.store.list('candidates', { booking_id: link.invitation.id })).length, 1);
  await w.call('POST', `/admin/test-bookings/${link.invitation.id}/cancel`, { token: w.tok });
  assert.equal((await w.call('GET', '/admin/dashboard', { token: w.tok })).body.counts.upcoming_tests, 0);
  assert.equal((await submit(w, link)).status, 409);
});

test('candidate permanent deletion removes booking contact data and its invitation', async (t) => {
  const w = await makeWorld({ t }); const link = await invite(w); await submit(w, link);
  const row = await w.store.get('test_bookings', link.invitation.id);
  const path = `/admin/candidates/${row.candidate_id}`;
  // A lost profile-link acknowledgement must not let a later dashboard
  // recreate a person the admin has permanently deleted.
  await w.store.update('test_bookings', row.id, { candidate_id: null });
  const preview = await w.call('GET', `${path}/purge-preview`, { token: w.tok });
  assert.equal(preview.body.counts.test_bookings, 1);
  const result = await w.call('DELETE', `${path}/purge`, { token: w.tok, body: { password: ADMIN_PASSWORD, confirmation: 'DELETE', preview_token: preview.body.preview_token } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(await w.store.get('test_bookings', row.id), null);
  assert.equal((await w.call('GET', '/admin/dashboard', { token: w.tok })).body.counts.upcoming_tests, 0);
  assert.equal((await submit(w, link)).status, 404);
});

test('independent Blobs adapters atomically consume a booking link only once', async () => {
  const data = new Map(); let revision = 0;
  const copy = (v) => structuredClone(v);
  const backend = {
    async get(k) { return data.has(k) ? copy(data.get(k).value) : null; },
    async getWithMetadata(k) { const v = data.get(k); await new Promise((r) => setTimeout(r, 2)); return v ? { data: copy(v.value), etag: v.etag } : null; },
    async setJSON(k, value, opts = {}) {
      const old = data.get(k);
      if ((opts.onlyIfNew && old) || (opts.onlyIfMatch && old?.etag !== opts.onlyIfMatch)) return { modified: false };
      data.set(k, { value: copy(value), etag: `v${++revision}` }); return { modified: true };
    },
    async delete(k) { data.delete(k); },
  };
  const blobsModule = { getStore: () => backend };
  const first = await createBlobsStore({ blobsModule, requireConsistency: true });
  const second = await createBlobsStore({ blobsModule, requireConsistency: true });
  await first.insert('test_bookings', { id: 'one-link', status: 'pending' });
  const claim = (store, name) => store.changeRow('test_bookings', { id: 'one-link' }, (r) => r.status === 'pending' ? { status: 'booked', name } : undefined);
  const results = await Promise.all([claim(first, 'First'), claim(second, 'Second')]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.equal((await first.get('test_bookings', 'one-link')).status, 'booked');
  assert.equal((await second.get('test_bookings', 'one-link')).name, (await first.get('test_bookings', 'one-link')).name);
});
